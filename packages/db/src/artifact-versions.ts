import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

export async function resolveNextArtifactVersion(
  prisma: Pick<PrismaClient, "artifact">,
  params: {
    spaceId: string;
    userId: string;
    botId: string;
    groupId?: string | null;
    name: string;
  },
): Promise<{ rootArtifactId: string | null; version: number }> {
  const previous = await prisma.artifact.findFirst({
    where: {
      spaceId: params.spaceId,
      userId: params.userId,
      botId: params.botId,
      groupId: params.groupId ?? null,
      name: { equals: params.name, mode: "insensitive" },
    },
    orderBy: [{ version: "desc" }, { createdAt: "desc" }],
    select: { id: true, rootArtifactId: true, version: true },
  });
  if (!previous) return { rootArtifactId: null, version: 1 };
  return {
    rootArtifactId: previous.rootArtifactId ?? previous.id,
    version: previous.version + 1,
  };
}

const MAX_VERSION_ALLOCATION_ATTEMPTS = 5;

type ArtifactVersionWrite = {
  rootArtifactId: string | null;
  version: number;
};

// Advisory lock queues same-name publishes; retry a unique family-version clash.
export async function withResolvedArtifactVersion<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  params: {
    spaceId: string;
    userId: string;
    botId: string;
    groupId?: string | null;
    name: string;
  },
  // The callback runs inside the version transaction with the full client, so
  // Run↔Artifact membership can append its `thread.artifact` event atomically
  // with the row write.
  attempt: (db: Prisma.TransactionClient, version: ArtifactVersionWrite) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < MAX_VERSION_ALLOCATION_ATTEMPTS; i++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${artifactVersionLockKey(params)}, 0))::text AS "lock"
        `);
        const version = await resolveNextArtifactVersion(tx, params);
        return await attempt(tx, version);
      });
    } catch (error) {
      if (!isArtifactVersionConflict(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

// Same identity as the name lookup, so those publishes share one lock.
function artifactVersionLockKey(params: {
  spaceId: string;
  userId: string;
  botId: string;
  groupId?: string | null;
  name: string;
}): string {
  return [
    params.spaceId,
    params.userId,
    params.botId,
    params.groupId ?? "",
    params.name.toLowerCase(),
  ].join("\u001f");
}

function isArtifactVersionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Delete one Artifact row together with its Run-membership (`thread.artifact`
 * detached) event in a single transaction: if the event write fails, the row
 * deletion rolls back with it and the caller receives the failure — the Run's
 * snapshot rev can never lag behind a committed deletion. The storage blob is
 * removed by the caller AFTER this commits (a leaked blob is recoverable; a
 * committed deletion without its event is not).
 */
export async function deleteArtifactRowWithDetachEvent(
  tx: Prisma.TransactionClient,
  artifact: { id: string; runId: string | null; name: string; mimeType: string; size?: number },
): Promise<boolean> {
  try {
    await tx.artifact.delete({ where: { id: artifact.id } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return false;
    }
    throw error;
  }
  if (artifact.runId) {
    const run = await tx.run.findUnique({
      where: { id: artifact.runId },
      select: { threadId: true, botId: true, spaceId: true },
    });
    if (run) {
      const { appendEventInTransaction } = await import("./events.js");
      await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId: artifact.runId,
        type: "thread.artifact",
        payload: {
          artifactId: artifact.id,
          action: "detached",
          name: artifact.name,
          mimeType: artifact.mimeType,
          ...(typeof artifact.size === "number" ? { size: artifact.size } : {}),
        },
      });
    }
  }
  return true;
}
