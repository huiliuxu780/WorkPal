import type { AgentRunRequest } from "@rakazo/adapter-kit";
import {
  legacyScopedToolEffectIdempotencyKey,
  toolEffectIdempotencyKey,
} from "@rakazo/core/node/approval-effect-key";
import { TaskInstructionIntegrityError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type * as AutoReviewModule from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

vi.mock("./auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AutoReviewModule>()),
  resolveAutoReviewChecker: () => ({ provider: "scripted", model: "checker" }),
  isAutoReviewCheckerConfigured: () => true,
  runAutoReviewJudge: vi.fn(),
}));

type Effect = {
  id: string;
  runId?: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  reviewDecision?: string;
};

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  executionId: string;
};

function fixture(
  runId = "run-1",
  instruction?: {
    revision: number;
    original: string;
    amendments: Array<{ seq: number; content: string }>;
  },
  instructionFailure?: Error,
) {
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const scratchpadRows: Array<{
    id: string;
    spaceId: string;
    botId: string;
    userId: string;
    title: string;
    status: string;
    notes: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const run = {
    id: runId,
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseOwner: null as string | null,
    leaseFence: 0,
    leaseExpiresAt: null as Date | null,
    planPhase: null as string | null,
  };
  const memoryCommit = vi.fn(async () => ({ revision: "rev-1" }));
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: string; runId?: string; status?: string; kind?: string };
      } = {}) =>
        effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.kind && effect.kind !== where.kind) return false;
          if (where?.runId && effect.runId && effect.runId !== where.runId) return false;
          if (where?.id && effect.id !== where.id) return false;
          return true;
        }),
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; status: string }; data: Partial<Effect> }) => {
        const effect = effects.find(
          (effect) => effect.id === where.id && effect.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };
  const prisma = {
    runPlan: { findUnique: vi.fn(async (): Promise<unknown> => null) },
    runPlanReview: {
      findFirst: vi.fn(async (): Promise<unknown> => null),
      count: vi.fn(async () => 0),
    },
    deliveryRecord: { findMany: vi.fn(async () => []) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUnique: vi.fn(async () => ({ capabilityRules: null, archivedAt: null })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 0),
    },
    thread: {
      findUnique: vi.fn(async () => ({ id: run.threadId, historyCompactionGeneration: 0 })),
      findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })),
    },
    message: { findMany: vi.fn(async () => []) },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Update shared state" })),
    },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    memoryFact: { findMany: vi.fn(async () => []) },
    memoryShard: { findMany: vi.fn(async () => []) },
    contextSummary: { findFirst: vi.fn(async () => null) },
    scratchpadItem: {
      findMany: vi.fn(async () => scratchpadRows),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            spaceId: string;
            botId: string;
            userId: string;
            title: string;
            status: string;
            notes: string;
          };
        }) => {
          const now = new Date("2026-09-14T00:00:00.000Z");
          const row = {
            id: `scratch-${scratchpadRows.length + 1}`,
            ...data,
            createdAt: now,
            updatedAt: now,
          };
          scratchpadRows.push(row);
          return row;
        },
      ),
    },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
  };
  let factCreates = 0;
  Object.assign(prisma, {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join("");
          if (sql.includes('"external_effects"')) {
            const effect = effects.find((candidate) => candidate.id === values[0]);
            return effect
              ? [
                  {
                    id: effect.id,
                    runId: effect.runId ?? run.id,
                    status: effect.status,
                    result: effect.result ?? null,
                  },
                ]
              : [];
          }
          return [
            {
              id: run.id,
              status: run.status,
              leaseOwner: run.leaseOwner,
              leaseFence: run.leaseFence,
              leaseExpiresAt: run.leaseExpiresAt,
              leaseValid:
                run.leaseExpiresAt !== null && run.leaseExpiresAt.getTime() > Date.now(),
            },
          ];
        }),
        run: {
          findUnique: vi.fn(async () => ({
            ...run,
            leaseExpiresAt: run.leaseExpiresAt ?? new Date(Date.now() + 60_000),
          })),
          updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            Object.assign(run, data);
            return { count: 1 };
          }),
        },
        externalEffect,
        attempt: prisma.attempt,
        // ME-01: remember now writes first-party facts through this transaction.
        memoryFact: {
          findFirst: vi.fn(async () => null),
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            factCreates += 1;
            return { id: `fact-${factCreates}`, revision: 1, ...data };
          }),
        },
        memoryFactRevision: { create: vi.fn(async () => ({})) },
        memoryEvidence: { create: vi.fn(async () => ({})) },
        memoryShard: {
          upsert: vi.fn(async () => ({ id: "shard-1", version: 0 })),
          findUniqueOrThrow: vi.fn(async () => ({ id: "shard-1", version: 0 })),
          update: vi.fn(async () => ({ id: "shard-1", version: 1 })),
        },
        memoryJobOutbox: { upsert: vi.fn(async () => ({})) },
      }),
    ),
  });
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  let calls: ToolCall[] = [];
  let lastRequest: AgentRunRequest | undefined;
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    lastRequest = request;
    for (const call of calls) {
      const result = await request.executeTool!(call.name, call.args, call.executionId);
      results.push(result);
    }
    yield { type: "done" as const, text: "Done" };
  });
  const instructionReads: Array<{ runId: string; leaseOwner: string; leaseFence: number }> = [];
  const executor = createRunExecutor({
    prisma,
    taskInstructions: async (
      _prisma: unknown,
      input: { runId: string; leaseOwner: string; leaseFence: number },
    ) => {
      instructionReads.push(input);
      if (instructionFailure) throw instructionFailure;
      return {
        envelope: {
          taskId: run.taskId,
          revision: instruction?.revision ?? 1,
          original: { content: instruction?.original ?? "Update shared state" },
          amendments: (instruction?.amendments ?? []).map((amendment) => ({
            messageId: `message-${amendment.seq}`,
            seq: amendment.seq,
            content: amendment.content,
          })),
        },
        ref: { taskId: run.taskId, consumedRevision: instruction?.revision ?? 1 },
      };
    },
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: async () => ({ documents: [] }),
      search: async () => [],
      commit: memoryCommit,
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    effects,
    results,
    scratchpadRows,
    memoryCommit,
    get factCreates() {
      return factCreates;
    },
    prisma,
    runRow: run,
    executor,
    pauseRunForInput,
    finalizeRun,
    runtimeRun,
    instructionReads,
    get lastRequest() {
      return lastRequest;
    },
    setCalls(next: ToolCall[]) {
      calls = next;
    },
    async run() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    },
  };
}

describe("mutating tool effect idempotency keys", () => {
  it("feeds the original and all server-ordered amendments to the runtime", async () => {
    const f = fixture("run-envelope", {
      revision: 3,
      original: "Original task",
      amendments: [
        { seq: 2, content: "Second amendment" },
        { seq: 1, content: "First amendment" },
      ],
    });
    await f.run();
    expect(f.instructionReads).toEqual([
      { runId: "run-envelope", leaseOwner: "worker-1", leaseFence: 1 },
    ]);
    const prompt = f.lastRequest?.prompt ?? "";
    expect(prompt).toContain("Task instruction revision 3.");
    expect(prompt).toContain("Original task");
    expect(prompt.indexOf("[amendment 1]")).toBeGreaterThan(-1);
    expect(prompt.indexOf("[amendment 1]")).toBeLessThan(prompt.indexOf("[amendment 2]"));
    expect(prompt).toContain("First amendment");
    expect(prompt).toContain("Second amendment");
  });

  it("fails the Run instead of calling the runtime when the envelope is incomplete", async () => {
    const f = fixture(
      "run-incomplete",
      undefined,
      new TaskInstructionIntegrityError("task-1", 3, 0),
    );
    await f.executor.continueRun(f.runRow.id, "worker-1");
    expect(f.runtimeRun).not.toHaveBeenCalled();
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: expect.stringContaining("is incomplete"),
      }),
    );
  });

  it("executes different tools that share a reused provider tool-call id", async () => {
    const f = fixture("run-a");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "team preference" },
        executionId: "call_0",
      },
      {
        name: "scratchpad_add",
        args: { title: "follow up with design" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    // ME-01: the hidden legacy document write path is gone; the fact store
    // records the memory exactly once.
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.factCreates).toBe(1);
    expect(f.scratchpadRows).toHaveLength(1);
    expect(f.effects.map((effect) => effect.idempotencyKey)).toEqual([
      toolEffectIdempotencyKey("run-a", "remember", {
        path: "MEMORY.md",
        content: "team preference",
      }),
      toolEffectIdempotencyKey("run-a", "scratchpad_add", {
        title: "follow up with design",
      }),
    ]);
    expect(f.effects.every((effect) => effect.status === "completed")).toBe(true);
    expect(f.results[0]).toEqual(expect.objectContaining({ ok: true }));
    expect(f.results[1]).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({ title: "follow up with design" }),
      }),
    );
  });

  it("executes the same provider tool-call id on different runs", async () => {
    const first = fixture("run-1");
    first.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "first bot note" },
        executionId: "call_0",
      },
    ]);
    await first.run();

    const second = fixture("run-2");
    // Shared ExternalEffect table: prior completed rows remain visible by idempotency key.
    second.effects.push(...first.effects);
    second.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "second bot note" },
        executionId: "call_0",
      },
    ]);
    await second.run();

    expect(second.memoryCommit).not.toHaveBeenCalled();
    expect(second.factCreates).toBe(1);
    expect(second.effects.map((effect) => effect.idempotencyKey)).toEqual([
      toolEffectIdempotencyKey("run-1", "remember", {
        path: "MEMORY.md",
        content: "first bot note",
      }),
      toolEffectIdempotencyKey("run-2", "remember", {
        path: "MEMORY.md",
        content: "second bot note",
      }),
    ]);
    expect(second.results[0]).toEqual(expect.objectContaining({ ok: true }));
  });

  it("replays a true retry of the same effect without re-executing", async () => {
    const f = fixture("run-retry");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "call_0",
      },
    ]);
    await f.run();
    // ME-01: the hidden legacy document write path is gone; the fact store
    // records the memory exactly once.
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.factCreates).toBe(1);
    expect(f.effects).toHaveLength(1);

    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "call_0",
      },
    ]);
    await f.run();

    // ME-01: the hidden legacy document write path is gone; the fact store
    // records the memory exactly once.
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.factCreates).toBe(1);
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-retry", "remember", {
        path: "MEMORY.md",
        content: "durable fact",
      }),
    );
    expect(f.results[1]).toEqual(expect.objectContaining({ ok: true }));
  });

  it("replays the same logical effect when restart assigns a new tool-call id", async () => {
    const f = fixture("run-replay-id");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "toolu_abc",
      },
    ]);
    await f.run();
    // ME-01: the hidden legacy document write path is gone; the fact store
    // records the memory exactly once.
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.factCreates).toBe(1);
    expect(f.effects).toHaveLength(1);

    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "toolu_xyz",
      },
    ]);
    await f.run();

    // ME-01: the hidden legacy document write path is gone; the fact store
    // records the memory exactly once.
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.factCreates).toBe(1);
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-replay-id", "remember", {
        path: "MEMORY.md",
        content: "durable fact",
      }),
    );
    expect(f.results[1]).toEqual(expect.objectContaining({ ok: true }));
  });

  it("executes the same tool twice in one run when args differ but the provider id is reused", async () => {
    const f = fixture("run-args");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "first fact" },
        executionId: "call_0",
      },
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "second fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.factCreates).toBe(2);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.idempotencyKey).not.toBe(f.effects[1]?.idempotencyKey);
    expect(f.results).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
  });

  it("replays a legacy bare provider idempotency key for the same run and tool", async () => {
    const f = fixture("run-legacy");
    f.effects.push({
      id: "legacy-1",
      runId: "run-legacy",
      kind: "remember",
      idempotencyKey: "call_0",
      status: "completed",
      request: { path: "MEMORY.md", content: "legacy fact" },
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "legacy fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("replays a legacy scoped key that included the provider tool-call id", async () => {
    const args = { path: "MEMORY.md", content: "legacy scoped fact" };
    const f = fixture("run-legacy-scoped");
    f.effects.push({
      id: "legacy-scoped-1",
      runId: "run-legacy-scoped",
      kind: "remember",
      idempotencyKey: legacyScopedToolEffectIdempotencyKey(
        "run-legacy-scoped",
        "remember",
        "call_0",
        args,
      ),
      status: "completed",
      request: args,
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args,
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("does not reuse an incomplete legacy effect when the request differs", async () => {
    const f = fixture("run-legacy-mismatch");
    f.effects.push({
      id: "legacy-open",
      runId: "run-legacy-mismatch",
      kind: "remember",
      idempotencyKey: "call_0",
      status: "intended",
      request: { path: "MEMORY.md", content: "old fact" },
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "new fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    // ME-01: the hidden legacy document write path is gone; the fact store
    // records the memory exactly once.
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.factCreates).toBe(1);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[1]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-legacy-mismatch", "remember", {
        path: "MEMORY.md",
        content: "new fact",
      }),
    );
    expect(f.results[0]).toEqual(expect.objectContaining({ ok: true }));
  });

  it("executes two identical-args mutating calls in one live run", async () => {
    const args = { path: "MEMORY.md", content: "same fact" };
    const f = fixture("run-live-repeat");
    f.setCalls([
      { name: "remember", args, executionId: "call_a" },
      { name: "remember", args, executionId: "call_b" },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.factCreates).toBe(2);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-live-repeat", "remember", args),
    );
    expect(f.effects[1]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-live-repeat", "remember", args, 1),
    );
    expect(f.results).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
  });

  it("replays a legacy scoped key when restart assigns a new tool-call id", async () => {
    const args = { path: "MEMORY.md", content: "legacy scoped fact" };
    const f = fixture("run-legacy-new-id");
    f.effects.push({
      id: "legacy-scoped-old-id",
      runId: "run-legacy-new-id",
      kind: "remember",
      idempotencyKey: legacyScopedToolEffectIdempotencyKey(
        "run-legacy-new-id",
        "remember",
        "call_old",
        args,
      ),
      status: "completed",
      request: args,
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args,
        executionId: "call_new",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });
});

describe("unified plan review execution gate (UX-02)", () => {
  it("blocks mutating tools during the read-only PLAN phase with zero effects", async () => {
    const f = fixture("run-gate-phase");
    f.runRow.planPhase = "planning";
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "team preference" },
        executionId: "call_gate_1",
      },
    ]);
    await f.run();
    expect(f.results[0]).toEqual({ error: expect.stringContaining("PLAN mode (read-only)") });
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(0);
  });

  it("re-opens the review card at attempt start when a pending round never paired with its pause", async () => {
    const f = fixture("run-gate-repair");
    const plan = {
      planId: "plan:run-gate-repair",
      runId: "run-gate-repair",
      sourceMessageId: null,
      revisionId: "plan:run-gate-repair:1",
      revision: 1,
      goal: "Deliver the gated fixture",
      items: [{ id: "a", title: "Stage A", status: "pending" }],
      changeReason: null,
      createdAt: new Date().toISOString(),
    };
    f.prisma.runPlanReview.findFirst.mockResolvedValue({
      id: "round-1",
      runId: "run-gate-repair",
      planId: plan.planId,
      contentVersion: 1,
      revision: 1,
      status: "pending",
      source: "plan_exit",
      toolExecutionId: "exit-1",
      interventionId: null,
      submittedAt: new Date(),
    });
    f.prisma.runPlan.findUnique.mockResolvedValue({
      reviewStatus: "pending",
      current: plan,
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "team preference" },
        executionId: "call_gate_2",
      },
    ]);
    f.runRow.status = "queued";
    await f.executor.continueRun("run-gate-repair", "worker-1");
    // The run re-pauses on the SAME version binding before any model call or
    // tool execution: a crash between submit and pause never leaks forward.
    expect(f.pauseRunForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        planReviewRound: expect.objectContaining({
          roundId: "round-1",
          planId: plan.planId,
          contentVersion: 1,
          source: "plan_exit",
        }),
      }),
    );
    const pauseCall = f.pauseRunForInput.mock.calls[0] as unknown as [
      { blocks: Array<{ planReview?: unknown }> },
    ];
    const ask = pauseCall[0].blocks[0] as { planReview?: Record<string, unknown> };
    expect(ask.planReview ?? {}).toMatchObject({
      planId: plan.planId,
      contentVersion: 1,
      goal: plan.goal,
      source: "plan_exit",
    });
    expect(f.runtimeRun).not.toHaveBeenCalled();
    expect(f.results).toHaveLength(0);
    expect(f.effects).toHaveLength(0);
  });
});
