import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    claimMemoryOutboxJobs: vi.fn(async () => []),
    completeMemoryOutboxJob: vi.fn(async () => undefined),
    failMemoryOutboxJob: vi.fn(async () => undefined),
    rebuildShardProfile: vi.fn(async () => ({ rebuilt: true, version: 2 })),
  };
});

import {
  claimMemoryOutboxJobs,
  completeMemoryOutboxJob,
  failMemoryOutboxJob,
  rebuildShardProfile,
  type PrismaClient,
} from "@rakazo/db";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { DEFAULT_MEMORY_JOBS_CONFIG } from "./memory-jobs-config.js";
import { drainMemoryOutbox } from "./memory-outbox.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";

function job(overrides: Record<string, unknown>) {
  return {
    id: "job-1",
    kind: "shard_profile_rebuild",
    spaceId: "space-1",
    targetId: "shard-1",
    payload: { shardId: "shard-1" },
    sourceVersionDigest: "",
    attempts: 1,
    nextAttemptAt: new Date(),
    lastError: null,
    claimedBy: "w1",
    claimedAt: new Date(),
    createdAt: new Date(Date.now() - 60_000),
    updatedAt: new Date(),
    ...overrides,
  };
}

function harness(options: {
  jobs?: Array<Record<string, unknown>>;
  facts?: Array<Record<string, unknown>>;
  shards?: Array<Record<string, unknown>>;
  threads?: Array<Record<string, unknown>>;
  provider?: { save?: unknown; forget?: unknown } | null;
}) {
  vi.mocked(claimMemoryOutboxJobs).mockResolvedValue(
    (options.jobs ?? []) as never,
  );
  const prisma = {
    memoryFact: { findUnique: vi.fn(async () => options.facts?.[0] ?? null) },
    memoryShard: { findUnique: vi.fn(async () => options.shards?.[0] ?? null) },
    thread: { findMany: vi.fn(async () => options.threads ?? []) },
  } as unknown as PrismaClient;
  const enqueue = vi.fn(async () => undefined);
  const resolver: MemoryProviderResolver = {
    resolve: vi.fn(async () =>
      options.provider === null || options.provider === undefined
        ? null
        : {
            defaultScope: "isolated" as const,
            provider: {
              describe: () => ({ id: "test", contractVersion: "1", adapterVersion: "1", capabilities: { recall: true, save: true, purgeHistory: true, sharedScope: true } }),
              save: options.provider.save ?? vi.fn(async () => ({ ok: true, value: undefined })),
              ...(options.provider.forget ? { forget: options.provider.forget } : {}),
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
    ),
  };
  return {
    prisma,
    enqueue,
    resolver,
    deps: {
      prisma,
      jobs: { enqueue } as unknown as JobPublisher,
      memoryProviders: resolver,
      config: DEFAULT_MEMORY_JOBS_CONFIG,
      workerId: "w-test",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("drainMemoryOutbox", () => {
  it("rebuilds shard profiles and deletes the row on success", async () => {
    const h = harness({ jobs: [job({})] });
    const result = await drainMemoryOutbox(h.deps);
    expect(rebuildShardProfile).toHaveBeenCalledWith(h.prisma, "shard-1");
    expect(completeMemoryOutboxJob).toHaveBeenCalledWith(h.prisma, "job-1");
    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
  });

  it("fans summary rebuilds out to the shard's recipients", async () => {
    const h = harness({
      jobs: [job({ kind: "summary_rebuild", targetId: "shard:shard-1", payload: { shardId: "shard-1" } })],
      shards: [{ id: "shard-1", spaceId: "space-1", scopeKind: "bot", scopeKey: "bot:bot-1" }],
      threads: [{ userId: "user-1" }, { userId: "user-2" }],
    });
    await drainMemoryOutbox(h.deps);
    expect(h.enqueue).toHaveBeenCalledTimes(2);
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "memory.summary",
        payload: { spaceId: "space-1", recipientUserId: "user-1", recipientBotId: "bot-1" },
      }),
    );
    expect(completeMemoryOutboxJob).toHaveBeenCalled();
  });

  it("projects active facts to the external index and skips inactive ones", async () => {
    const save = vi.fn(async () => ({ ok: true, value: undefined }));
    const active = harness({
      jobs: [job({ kind: "index_projection", targetId: "fact-1" })],
      facts: [{ id: "fact-1", state: "active", spaceId: "space-1", botId: "bot-1", ownerUserId: "user-1", text: "Likes tables", literalValues: null, scopeKind: "bot", scopeKey: "bot:bot-1" }],
      provider: { save },
    });
    await drainMemoryOutbox(active.deps);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ content: "[wp-fact:fact-1] Likes tables" }),
      expect.anything(),
    );
    expect(completeMemoryOutboxJob).toHaveBeenCalled();

    const deleted = harness({
      jobs: [job({ id: "job-2", kind: "index_projection", targetId: "fact-2" })],
      facts: [{ id: "fact-2", state: "deleted" }],
      provider: { save },
    });
    await drainMemoryOutbox(deleted.deps);
    expect(completeMemoryOutboxJob).toHaveBeenCalledWith(deleted.prisma, "job-2");
  });

  it("keeps index cleanup visible and retryable when the provider lacks forget", async () => {
    const h = harness({
      jobs: [job({ kind: "index_cleanup", targetId: "fact-1" })],
      facts: [{ id: "fact-1", state: "deleted", spaceId: "space-1", botId: "bot-1", ownerUserId: "user-1", scopeKind: "bot", scopeKey: "bot:bot-1" }],
      provider: {}, // no forget
    });
    const result = await drainMemoryOutbox(h.deps);
    expect(result.failed).toBe(1);
    expect(completeMemoryOutboxJob).not.toHaveBeenCalled();
    expect(failMemoryOutboxJob).toHaveBeenCalledWith(
      h.prisma,
      expect.objectContaining({ jobId: "job-1", error: "provider_lacks_forget" }),
    );
  });

  it("cleans cascaded facts through the payload identity after bot deletion", async () => {
    const forget = vi.fn(async () => ({ ok: true, value: { id: "fact-1", expired: true, reason: null } }));
    const h = harness({
      jobs: [
        job({
          kind: "index_cleanup",
          targetId: "fact-1",
          payload: { factId: "fact-1", botId: "bot-gone", reason: "bot_deleted" },
        }),
      ],
      facts: [], // row gone with the bot cascade
      provider: { forget },
    });
    await drainMemoryOutbox(h.deps);
    expect(forget).toHaveBeenCalledWith(
      expect.objectContaining({ id: "fact-1", reason: "bot_deleted" }),
      expect.objectContaining({ botId: "bot-gone" }),
    );
    expect(completeMemoryOutboxJob).toHaveBeenCalled();
  });

  it("records failures with backoff and reports a full batch as remaining work", async () => {
    const h = harness({
      jobs: Array.from({ length: DEFAULT_MEMORY_JOBS_CONFIG.outboxBatchSize }, (_, index) =>
        job({ id: `job-${index}`, kind: "index_cleanup", targetId: `fact-${index}` }),
      ),
      facts: [],
      provider: {}, // no forget → every row fails visibly
    });
    const result = await drainMemoryOutbox(h.deps);
    expect(result.remaining).toBe(true);
    expect(result.failed).toBe(DEFAULT_MEMORY_JOBS_CONFIG.outboxBatchSize);
    expect(failMemoryOutboxJob).toHaveBeenCalledTimes(DEFAULT_MEMORY_JOBS_CONFIG.outboxBatchSize);
  });
});
