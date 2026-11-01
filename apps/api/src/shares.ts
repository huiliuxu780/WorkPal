import { randomBytes } from "node:crypto";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import {
  type Actor,
  type PublicShareView,
  SHARE_CUSTOM_DAYS_MAX,
  SHARE_CUSTOM_DAYS_MIN,
  type ShareExpiry,
  type ShareLink,
  type ShareOverview,
} from "@rakazo/contracts";
import { IsolationError, Prisma, type PrismaClient } from "@rakazo/db";
import { findLatestPublishedArtifactRow } from "./artifact-families.js";

/** The artifact exists for the actor but is not a published HTML page. */
export class PageNotShareableError extends Error {
  override readonly name = "PageNotShareableError";
  readonly code = "PAGE_NOT_SHAREABLE";

  constructor(message = "Only published HTML pages can be shared") {
    super(message);
  }
}

type ShareDeps = { prisma: PrismaClient; artifacts: ArtifactStore };
type ShareTarget = { botId?: string; groupId?: string; artifactId: string };
type PageFamily = {
  familyId: string;
  botId: string | null;
  groupId: string | null;
  name: string;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function shareExpiryDate(expiry: ShareExpiry, now = new Date()): Date {
  switch (expiry.preset) {
    case "24h":
      return new Date(now.getTime() + DAY_MS);
    case "7d":
      return new Date(now.getTime() + 7 * DAY_MS);
    case "30d":
      return new Date(now.getTime() + 30 * DAY_MS);
    case "custom": {
      const days = expiry.customDays;
      if (days === undefined || days < SHARE_CUSTOM_DAYS_MIN || days > SHARE_CUSTOM_DAYS_MAX) {
        throw new PageNotShareableError("A custom expiry must be 1–90 days");
      }
      return new Date(now.getTime() + days * DAY_MS);
    }
  }
}

function linkDto(row: { token: string; expiresAt: Date; createdAt: Date }): ShareLink {
  return {
    token: row.token,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

async function resolvePageFamily(
  deps: ShareDeps,
  actor: Actor,
  input: ShareTarget,
): Promise<PageFamily> {
  if (!input.groupId && !input.botId) throw new IsolationError();
  const row = await deps.prisma.artifact.findFirst({
    where: {
      id: input.artifactId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      ...(input.groupId ? { groupId: input.groupId } : { botId: input.botId!, groupId: null }),
    },
    select: {
      id: true,
      rootArtifactId: true,
      mimeType: true,
      botId: true,
      groupId: true,
    },
  });
  if (!row) throw new IsolationError();
  const familyId = row.rootArtifactId ?? row.id;
  const scope = row.groupId
    ? { spaceId: actor.spaceId, userId: actor.userId, groupId: row.groupId }
    : { spaceId: actor.spaceId, userId: actor.userId, botId: row.botId! };
  if (!row.groupId && !row.botId) throw new PageNotShareableError();
  const latest = await findLatestPublishedArtifactRow(deps.prisma, scope, familyId);
  if (latest?.mimeType !== "text/html" || row.mimeType !== "text/html") {
    throw new PageNotShareableError();
  }
  return {
    familyId,
    botId: row.groupId ? null : row.botId,
    groupId: row.groupId,
    name: latest.name,
  };
}

export async function getArtifactShare(
  deps: ShareDeps,
  actor: Actor,
  input: ShareTarget,
): Promise<ShareOverview> {
  const page = await resolvePageFamily(deps, actor, input);
  const link = await deps.prisma.shareLink.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      artifactFamilyId: page.familyId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  return {
    familyId: page.familyId,
    publicLink: link ? linkDto(link) : null,
  };
}

/**
 * One link per page family: creating a new link revokes the previous one, so
 * "the public link" in the sheet is always unambiguous. The advisory lock
 * serializes two concurrent generates from the same owner.
 */
export async function createPublicShare(
  deps: ShareDeps,
  actor: Actor,
  input: ShareTarget & { expiry: ShareExpiry },
): Promise<ShareLink> {
  const page = await resolvePageFamily(deps, actor, input);
  const expiresAt = shareExpiryDate(input.expiry);
  const now = new Date();
  const token = randomBytes(32).toString("base64url");
  const row = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${[
        "share",
        actor.spaceId,
        actor.userId,
        page.familyId,
      ].join("\u001f")}, 0))::text AS "lock"
    `);
    await tx.shareLink.updateMany({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        artifactFamilyId: page.familyId,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
    return tx.shareLink.create({
      data: {
        token,
        spaceId: actor.spaceId,
        userId: actor.userId,
        artifactFamilyId: page.familyId,
        artifactName: page.name,
        botId: page.botId,
        groupId: page.groupId,
        expiresAt,
      },
    });
  });
  return linkDto(row);
}

/** Idempotent and independent of the page still being published. */
export async function revokePublicShare(
  deps: Pick<ShareDeps, "prisma">,
  actor: Actor,
  input: ShareTarget,
): Promise<{ ok: true }> {
  const row = await deps.prisma.artifact.findFirst({
    where: {
      id: input.artifactId,
      spaceId: actor.spaceId,
      userId: actor.userId,
    },
    select: { id: true, rootArtifactId: true },
  });
  await deps.prisma.shareLink.updateMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      artifactFamilyId: { in: row ? [row.rootArtifactId ?? row.id] : [input.artifactId] },
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return { ok: true };
}

/** Anonymous read path. Revocation and expiry are enforced before any bytes move. */
export async function resolvePublicShare(
  deps: ShareDeps,
  token: string,
  now = new Date(),
): Promise<PublicShareView> {
  const link = await deps.prisma.shareLink.findUnique({ where: { token } });
  if (!link) return { state: "invalid" };
  if (link.revokedAt) return { state: "revoked", name: link.artifactName };
  if (link.expiresAt.getTime() <= now.getTime()) {
    return { state: "expired", name: link.artifactName };
  }
  if (!link.groupId && !link.botId) return { state: "invalid" };
  const latest = await findLatestPublishedArtifactRow(
    deps.prisma,
    link.groupId
      ? { spaceId: link.spaceId, userId: link.userId, groupId: link.groupId }
      : { spaceId: link.spaceId, userId: link.userId, botId: link.botId! },
    link.artifactFamilyId,
  );
  if (latest?.mimeType !== "text/html") return { state: "invalid" };
  const bytes = await deps.artifacts.get(latest.storageKey, {
    operationId: `share-resolve:${link.id}`,
    traceId: `share-resolve:${link.id}`,
    spaceId: link.spaceId,
    userId: link.userId,
    ...(link.botId ? { botId: link.botId } : {}),
    signal: new AbortController().signal,
  });
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { state: "invalid" };
  }
  return {
    state: "ok",
    name: latest.name,
    html,
    expiresAt: link.expiresAt.toISOString(),
  };
}
