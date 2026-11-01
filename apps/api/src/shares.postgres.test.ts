import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { createIsolatedPostgresDatabase, type IsolatedPostgresDatabase } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicShare,
  getArtifactShare,
  PageNotShareableError,
  resolvePublicShare,
  revokePublicShare,
  shareExpiryDate,
} from "./shares.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

const HTML = "<!doctype html><html><body><h1>Board</h1></body></html>";
const DAY_MS = 24 * 60 * 60 * 1000;
const artifacts = {
  get: async () => new TextEncoder().encode(HTML),
} as unknown as ArtifactStore;

type Owner = {
  label: string;
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  runId: string;
  actor: Actor;
};

describePostgres("page share links (PostgreSQL)", () => {
  let isolated: IsolatedPostgresDatabase;
  let prisma: IsolatedPostgresDatabase["db"]["prisma"];
  const sequence = new Map<string, number>();

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("share_links");
    prisma = isolated.db.prisma;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  async function createOwner(label: string): Promise<Owner> {
    const id = `sh-${label}-${randomUUID().slice(0, 8)}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    await prisma.user.create({
      data: { id: userId, name: "Owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Shares", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId: id, name: "Shares" } });
    await prisma.member.create({
      data: {
        id: `${id}-member`,
        organizationId: id,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: `${id}-sm`,
        spaceId,
        organizationId: id,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Chief", color: "#111111" },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId,
        prompt: "Publish a page",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId,
        status: "completed",
        trigger: "user",
      },
    });
    return {
      label,
      userId,
      spaceId,
      botId: bot.id,
      threadId: thread.id,
      runId: run.id,
      actor: { userId, spaceId, email: `${id}@example.test`, isDeploymentOwner: true },
    };
  }

  async function createPage(
    owner: Owner,
    options: { name?: string; mimeType?: string; published?: boolean } = {},
  ) {
    const name = options.name ?? "board.html";
    const mimeType = options.mimeType ?? "text/html";
    const artifact = await prisma.artifact.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: owner.botId,
        runId: owner.runId,
        name,
        mimeType,
        size: HTML.length,
        hash: `hash-${randomUUID()}`,
        storageKey: `key-${randomUUID()}`,
        version: 1,
      },
    });
    if (options.published !== false) {
      const seq = (sequence.get(owner.threadId) ?? 0) + 1;
      sequence.set(owner.threadId, seq);
      await prisma.message.create({
        data: {
          threadId: owner.threadId,
          seq,
          role: "bot",
          botId: owner.botId,
          runId: owner.runId,
          blocks: [{ kind: "file", artifactId: artifact.id, mimeType, name, size: HTML.length }],
        },
      });
    }
    return artifact;
  }

  it("creates one public link and resolves the published page anonymously", async () => {
    const owner = await createOwner("roundtrip");
    const page = await createPage(owner);
    const created = await createPublicShare({ prisma, artifacts }, owner.actor, {
      botId: owner.botId,
      artifactId: page.id,
      expiry: { preset: "7d" },
    });
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6.9 * DAY_MS);
    expect(created.token.length).toBeGreaterThanOrEqual(40);

    const overview = await getArtifactShare({ prisma, artifacts }, owner.actor, {
      botId: owner.botId,
      artifactId: page.id,
    });
    expect(overview).toMatchObject({
      familyId: page.id,
      publicLink: { token: created.token },
    });

    const view = await resolvePublicShare({ prisma, artifacts }, created.token);
    expect(view).toEqual({
      state: "ok",
      name: "board.html",
      html: HTML,
      expiresAt: created.expiresAt,
    });
  });

  it("revoking wins immediately and leaves the page unreadable", async () => {
    const owner = await createOwner("revoke");
    const page = await createPage(owner);
    const created = await createPublicShare({ prisma, artifacts }, owner.actor, {
      botId: owner.botId,
      artifactId: page.id,
      expiry: { preset: "24h" },
    });
    await revokePublicShare({ prisma }, owner.actor, {
      botId: owner.botId,
      artifactId: page.id,
    });
    expect(await resolvePublicShare({ prisma, artifacts }, created.token)).toEqual({
      state: "revoked",
      name: "board.html",
    });
    const overview = await getArtifactShare({ prisma, artifacts }, owner.actor, {
      botId: owner.botId,
      artifactId: page.id,
    });
    expect(overview.publicLink).toBeNull();
    // Revoking again is a no-op.
    await revokePublicShare({ prisma }, owner.actor, {
      botId: owner.botId,
      artifactId: page.id,
    });
  });

  it("an expired token never reaches the page body", async () => {
    const owner = await createOwner("expired");
    const page = await createPage(owner);
    const created = await createPublicShare({ prisma, artifacts }, owner.actor, {
      botId: owner.botId,
      artifactId: page.id,
      expiry: { preset: "custom", customDays: 1 },
    });
    await prisma.shareLink.update({
      where: { token: created.token },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    expect(await resolvePublicShare({ prisma, artifacts }, created.token)).toEqual({
      state: "expired",
      name: "board.html",
    });
    const overview = await getArtifactShare({ prisma, artifacts }, owner.actor, {
      botId: owner.botId,
      artifactId: page.id,
    });
    expect(overview.publicLink).toBeNull();
  });

  it("generating again retires the previous token", async () => {
    const owner = await createOwner("rotate");
    const page = await createPage(owner);
    const first = await createPublicShare({ prisma, artifacts }, owner.actor, {
      botId: owner.botId,
      artifactId: page.id,
      expiry: { preset: "7d" },
    });
    const second = await createPublicShare({ prisma, artifacts }, owner.actor, {
      botId: owner.botId,
      artifactId: page.id,
      expiry: { preset: "30d" },
    });
    expect(second.token).not.toBe(first.token);
    expect(await resolvePublicShare({ prisma, artifacts }, first.token)).toMatchObject({
      state: "revoked",
    });
    expect(await resolvePublicShare({ prisma, artifacts }, second.token)).toMatchObject({
      state: "ok",
    });
    expect(
      await prisma.shareLink.count({
        where: { artifactFamilyId: page.id, revokedAt: null },
      }),
    ).toBe(1);
  });

  it("rejects custom expiries outside 1–90 days", () => {
    const now = new Date("2026-11-01T00:00:00.000Z");
    expect(shareExpiryDate({ preset: "custom", customDays: 90 }, now).getTime()).toBe(
      now.getTime() + 90 * DAY_MS,
    );
    expect(() => shareExpiryDate({ preset: "custom", customDays: 120 }, now)).toThrow(
      PageNotShareableError,
    );
    expect(() => shareExpiryDate({ preset: "custom", customDays: 0 }, now)).toThrow(
      PageNotShareableError,
    );
    expect(() => shareExpiryDate({ preset: "custom" }, now)).toThrow(PageNotShareableError);
  });

  it("only the owner can share or revoke their page", async () => {
    const owner = await createOwner("owner");
    const other = await createOwner("other");
    const page = await createPage(owner);
    const created = await createPublicShare({ prisma, artifacts }, owner.actor, {
      botId: owner.botId,
      artifactId: page.id,
      expiry: { preset: "7d" },
    });
    await expect(
      getArtifactShare({ prisma, artifacts }, other.actor, {
        botId: page.botId!,
        artifactId: page.id,
      }),
    ).rejects.toThrow();
    await expect(
      createPublicShare({ prisma, artifacts }, other.actor, {
        botId: page.botId!,
        artifactId: page.id,
        expiry: { preset: "7d" },
      }),
    ).rejects.toThrow();
    await revokePublicShare({ prisma }, other.actor, {
      botId: page.botId!,
      artifactId: page.id,
    });
    expect(await resolvePublicShare({ prisma, artifacts }, created.token)).toMatchObject({
      state: "ok",
    });
  });

  it("refuses artifacts that are not published HTML pages", async () => {
    const owner = await createOwner("scope");
    const unpublished = await createPage(owner, { published: false });
    await expect(
      createPublicShare({ prisma, artifacts }, owner.actor, {
        botId: owner.botId,
        artifactId: unpublished.id,
        expiry: { preset: "7d" },
      }),
    ).rejects.toThrow(PageNotShareableError);

    const text = await createPage(owner, { name: "notes.txt", mimeType: "text/plain" });
    await expect(
      createPublicShare({ prisma, artifacts }, owner.actor, {
        botId: owner.botId,
        artifactId: text.id,
        expiry: { preset: "7d" },
      }),
    ).rejects.toThrow(PageNotShareableError);
  });

  it("treats an unknown token as invalid", async () => {
    expect(await resolvePublicShare({ prisma, artifacts }, "x".repeat(43))).toEqual({
      state: "invalid",
    });
  });
});
