import type { JobPublisher } from "@rakazo/adapter-kit";
import { memorySummaryJob } from "@rakazo/adapter-kit";
import type { MemoryJobOutbox, PrismaClient } from "@rakazo/db";
import {
  claimMemoryOutboxJobs,
  completeMemoryOutboxJob,
  failMemoryOutboxJob,
  memoryOutboxRetryDelay,
  rebuildShardProfile,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { buildFactProjectionContent } from "./memory-recall.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import type { MemoryJobsConfig } from "./memory-jobs-config.js";

/**
 * ME-02: durable memory outbox drain. Rows are written in the same
 * transaction as the fact change they follow, claimed with SKIP LOCKED,
 * deleted on success and retried with visible backoff on failure. External
 * index cleanup failures stay in the table (attempts + lastError) so they are
 * observable and retryable; they can never flow back into the model because
 * the recall path tombstone-filters projections independently.
 */

export interface MemoryOutboxDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  memoryProviders: MemoryProviderResolver;
  config: MemoryJobsConfig;
  workerId: string;
}

/** Rows parked beyond this attempt count keep a 24h retry instead of backoff. */
const PARK_AFTER_ATTEMPTS = 10;
const PARK_RETRY_MS = 24 * 60 * 60 * 1000;

export interface MemoryOutboxDrainResult {
  claimed: number;
  completed: number;
  failed: number;
  remaining: boolean;
}

export async function drainMemoryOutbox(
  deps: MemoryOutboxDeps,
): Promise<MemoryOutboxDrainResult> {
  const startedCleanupMs = Date.now();
  const jobs = await claimMemoryOutboxJobs(deps.prisma, {
    workerId: deps.workerId,
    limit: deps.config.outboxBatchSize,
  });
  let completed = 0;
  let failed = 0;
  for (const job of jobs) {
    const started = Date.now();
    try {
      await processOutboxJob(deps, job);
      await completeMemoryOutboxJob(deps.prisma, job.id);
      completed += 1;
      if (job.kind === "index_cleanup") {
        getLogger().info("memory.index.cleanup completed", {
          "memory.index.cleanup.delay_ms": startedCleanupMs - job.createdAt.getTime(),
          "memory.index.cleanup.attempts": job.attempts,
          "memory.job.target": job.targetId,
        });
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      const nextAttemptAt = new Date(
        Date.now() +
          (job.attempts >= PARK_AFTER_ATTEMPTS
            ? PARK_RETRY_MS
            : memoryOutboxRetryDelay(job.attempts)),
      );
      await failMemoryOutboxJob(deps.prisma, { jobId: job.id, error: message, nextAttemptAt });
      getLogger().error("memory.outbox job failed; visible for retry", error, {
        "memory.job.kind": job.kind,
        "memory.job.target": job.targetId,
        "memory.job.attempts": job.attempts,
        "memory.job.duration_ms": Date.now() - started,
      });
    }
  }
  return { claimed: jobs.length, completed, failed, remaining: jobs.length === deps.config.outboxBatchSize };
}

async function processOutboxJob(deps: MemoryOutboxDeps, job: MemoryJobOutbox): Promise<void> {
  switch (job.kind) {
    case "shard_profile_rebuild": {
      const result = await rebuildShardProfile(deps.prisma, job.targetId);
      if (!result.rebuilt && result.version >= 0) {
        // A newer version landed while rebuilding; the newer row already has
        // its own outbox entry, so this one is done.
        getLogger().info("memory.shard.profile rebuild superseded by a newer version", {
          "memory.shard.id": job.targetId,
        });
      }
      return;
    }
    case "summary_rebuild": {
      const shardId = job.targetId.replace(/^shard:/, "");
      const shard = await deps.prisma.memoryShard.findUnique({ where: { id: shardId } });
      if (!shard) return;
      const recipients = await resolveAffectedRecipients(deps.prisma, shard, deps.config.summaryFanoutLimit);
      for (const recipient of recipients) {
        await deps.jobs.enqueue(
          memorySummaryJob({
            spaceId: shard.spaceId,
            recipientUserId: recipient.userId,
            recipientBotId: recipient.botId,
          }),
        );
      }
      return;
    }
    case "index_projection": {
      const fact = await deps.prisma.memoryFact.findUnique({ where: { id: job.targetId } });
      if (!fact || fact.state !== "active") return; // deleted/never activated: nothing to project
      const configured = await deps.memoryProviders.resolve(fact.spaceId);
      if (!configured) return; // no external index configured; first-party only
      const botId = fact.botId ?? botIdFromScope(fact.scopeKind, fact.scopeKey);
      if (!botId) return; // space-scope facts without a bot ride per-bot projections
      const result = await configured.provider.save(
        {
          content: buildFactProjectionContent(fact),
          scope: configured.defaultScope,
          botId,
          source: { kind: "durable" },
        },
        {
          operationId: `memory-index:${fact.id}`,
          traceId: `memory-index:${fact.id}`,
          spaceId: fact.spaceId,
          userId: fact.ownerUserId,
          botId,
          signal: new AbortController().signal,
        },
      );
      if (!result.ok) throw new Error(`index projection refused: ${result.error}`);
      return;
    }
    case "index_cleanup": {
      const fact = await deps.prisma.memoryFact.findUnique({ where: { id: job.targetId } });
      // Bot/Space deletion cascades can remove the fact row before the drain
      // runs; the queued payload carries the identity needed to clean anyway.
      const payload = job.payload as { factId?: string; botId?: string; userId?: string };
      const spaceId = fact?.spaceId ?? job.spaceId;
      const configured = await deps.memoryProviders.resolve(spaceId);
      if (!configured) return; // provider config gone with the space: nothing reachable to clean
      if (!configured.provider.forget) {
        // Honest visibility: the provider cannot delete per item. The row
        // stays parked (attempts + lastError) instead of pretending success;
        // the recall tombstone filter keeps the entry out of the model.
        throw new Error("provider_lacks_forget");
      }
      const botId =
        fact?.botId ?? payload.botId ?? (fact ? botIdFromScope(fact.scopeKind, fact.scopeKey) : null);
      const result = await configured.provider.forget(
        { id: job.targetId, reason: payload.botId ? "bot_deleted" : "fact_deleted" },
        {
          operationId: `memory-index-cleanup:${job.targetId}`,
          traceId: `memory-index-cleanup:${job.targetId}`,
          spaceId,
          userId: fact?.ownerUserId ?? payload.userId ?? "",
          ...(botId ? { botId } : {}),
          signal: new AbortController().signal,
        },
      );
      if (!result.ok) throw new Error(`index cleanup refused: ${result.error}`);
      return;
    }
    default:
      throw new Error(`unknown memory outbox kind: ${job.kind}`);
  }
}

function botIdFromScope(scopeKind: string, scopeKey: string): string | null {
  return scopeKind === "bot" ? scopeKey.slice("bot:".length) : null;
}

async function resolveAffectedRecipients(
  prisma: PrismaClient,
  shard: { spaceId: string; scopeKind: string; scopeKey: string },
  limit: number,
): Promise<Array<{ userId: string; botId: string }>> {
  if (shard.scopeKind === "bot") {
    const botId = shard.scopeKey.slice("bot:".length);
    const threads = await prisma.thread.findMany({
      where: { spaceId: shard.spaceId, botId },
      select: { userId: true },
      distinct: ["userId"],
      take: limit,
      orderBy: { userId: "asc" },
    });
    return threads.map((thread) => ({ userId: thread.userId, botId }));
  }
  if (shard.scopeKind === "user") {
    const userId = shard.scopeKey.slice("user:".length);
    const threads = await prisma.thread.findMany({
      where: { spaceId: shard.spaceId, userId, botId: { not: null } },
      select: { botId: true },
      distinct: ["botId"],
      take: limit,
      orderBy: { botId: "asc" },
    });
    return threads
      .map((thread) => (thread.botId ? { userId, botId: thread.botId } : null))
      .filter((entry): entry is { userId: string; botId: string } => entry !== null);
  }
  // Space-scope changes fan out to the most recently created bot threads.
  const threads = await prisma.thread.findMany({
    where: { spaceId: shard.spaceId, botId: { not: null } },
    select: { userId: true, botId: true },
    take: limit,
    orderBy: { createdAt: "desc" },
  });
  const seen = new Set<string>();
  const recipients: Array<{ userId: string; botId: string }> = [];
  for (const thread of threads) {
    if (!thread.botId) continue;
    const key = `${thread.userId}:${thread.botId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push({ userId: thread.userId, botId: thread.botId });
  }
  return recipients;
}
