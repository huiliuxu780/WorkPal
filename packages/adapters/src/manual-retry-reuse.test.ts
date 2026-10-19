import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
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
  reviewDecision?: string | null;
  createdAt?: Date;
};

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  executionId: string;
};

async function listen(): Promise<{ server: Server; url: string; hits: unknown[] }> {
  const hits: unknown[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      hits.push(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, id: `ext-${hits.length}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}`, hits };
}

function fixture(runId = "run-retry") {
  const predecessorId = "run-old";
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const prompts: string[] = [];
  const scratchpadRows: Array<{ title: string }> = [];
  const run = {
    id: runId,
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
    retryOfRunId: predecessorId,
  };
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: string; runId?: string | { in?: string[] }; status?: string; kind?: string };
      } = {}) => {
        const runIds =
          typeof where?.runId === "string"
            ? [where.runId]
            : where?.runId && typeof where.runId === "object" && Array.isArray(where.runId.in)
              ? where.runId.in
              : undefined;
        return effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.kind && effect.kind !== where.kind) return false;
          if (runIds && effect.runId && !runIds.includes(effect.runId)) return false;
          if (where?.id && effect.id !== where.id) return false;
          return true;
        });
      },
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}`, createdAt: new Date() };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; status?: string };
        data: Partial<Effect>;
      }) => {
        const effect = effects.find(
          (row) => row.id === where.id && (where.status ? row.status === where.status : true),
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };
  const prisma = {
    deliveryRecord: { findMany: vi.fn(async () => []) },
    run: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        where.id === predecessorId ? { id: predecessorId, retryOfRunId: null } : run,
      ),
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
    },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
    message: { findMany: vi.fn(async () => []) },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.taskId,
        prompt: "Send the weekly report to Ada",
      })),
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
    scratchpadItem: {
      findMany: vi.fn(async () => scratchpadRows),
      create: vi.fn(async ({ data }: { data: { title: string } }) => {
        scratchpadRows.push({ title: data.title });
        return { id: `scratch-${scratchpadRows.length}`, ...data };
      }),
    },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
  };
  Object.assign(prisma, {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: vi.fn(async () => [{ id: run.id }]),
        run: {
          findUnique: vi.fn(async () => ({
            ...run,
            leaseExpiresAt: new Date(Date.now() + 60_000),
          })),
          updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            Object.assign(run, data);
            return { count: 1 };
          }),
        },
        attempt: prisma.attempt,
      }),
    ),
  });
  const append = vi.fn(async () => undefined);
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  let calls: ToolCall[] = [];
  const execute = vi.fn(async function* (call: { name?: string; args: Record<string, unknown> }) {
    const response = await fetch(String(call.args.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(call.args),
    });
    yield { type: "result" as const, data: await response.json() };
  });
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    prompts.push(request.prompt);
    for (const call of calls) {
      results.push(await request.executeTool!(call.name, call.args, call.executionId));
    }
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [
        {
          name: "hook_write",
          description: "POST a countable local fixture",
          readOnly: false,
          inputSchema: { type: "object" },
          route: { connectorId: "fixture", resourceId: "hook", toolName: "hook_write" },
        },
      ],
      resolveCall: async () => undefined,
      execute,
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: async () => ({ documents: [] }),
      search: async () => [],
      commit: vi.fn(async () => ({ revision: "rev-1" })),
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: async () => null },
    events: { append, pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    effects,
    results,
    prompts,
    scratchpadRows,
    append,
    pauseRunForInput,
    execute,
    predecessorId,
    seed(effect: Omit<Effect, "createdAt">) {
      effects.push({ createdAt: new Date("2026-10-19T00:00:00.000Z"), ...effect });
    },
    setCalls(next: ToolCall[]) {
      calls = next;
    },
    async run() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
    },
  };
}

describe("manual retry effect reuse (production executor)", () => {
  it("reuses a completed predecessor result and does not POST the fixture again", async () => {
    const http = await listen();
    try {
      const f = fixture();
      f.seed({
        id: "e-old",
        runId: f.predecessorId,
        kind: "hook_write",
        idempotencyKey: "old-hook",
        status: "completed",
        request: { url: `${http.url}/items`, body: "hello" },
        result: { ok: true, id: "ext-1" },
      });
      f.setCalls([
        {
          name: "hook_write",
          args: { url: `${http.url}/items`, body: "hello" },
          executionId: "call-1",
        },
      ]);
      await f.run();
      expect(http.hits).toHaveLength(0);
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.results[0]).toEqual({ ok: true, id: "ext-1" });
      expect(f.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "effect.reconciled",
          payload: expect.objectContaining({
            sourceEffectId: "e-old",
            reuse: "manual_retry",
            kind: "hook_write",
          }),
        }),
      );
      expect(f.effects.filter((effect) => effect.runId === "run-retry")).toHaveLength(0);
      expect(f.prompts[0]).toContain("manual retry");
      expect(f.prompts[0]).toContain("Send the weekly report to Ada");
      expect(f.prompts[0]).toContain("hook_write");
    } finally {
      http.server.close();
    }
  });

  it("executes a different target as a new operation", async () => {
    const f = fixture();
    f.seed({
      id: "e-old",
      runId: f.predecessorId,
      kind: "scratchpad_add",
      idempotencyKey: "old-scratch",
      status: "completed",
      request: { title: "follow up with design" },
      result: { ok: true },
    });
    f.setCalls([
      {
        name: "scratchpad_add",
        args: { title: "a different follow-up" },
        executionId: "call-2",
      },
    ]);
    await f.run();
    expect(f.scratchpadRows).toEqual([{ title: "a different follow-up" }]);
  });

  it("pauses an uncertain predecessor instead of re-sending it", async () => {
    const f = fixture();
    f.seed({
      id: "e-unknown",
      runId: f.predecessorId,
      kind: "scratchpad_add",
      idempotencyKey: "old-scratch",
      status: "uncertain",
      request: { title: "follow up with design" },
      result: null,
    });
    f.setCalls([
      {
        name: "scratchpad_add",
        args: { title: "follow up with design" },
        executionId: "call-3",
      },
    ]);
    await f.run();
    expect(f.pauseRunForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        manualRetryEffectId: "e-unknown",
        offeredActions: expect.arrayContaining([
          expect.objectContaining({ id: "confirm_completed" }),
          expect.objectContaining({ id: "authorize_retry" }),
          expect.objectContaining({ id: "cancel" }),
        ]),
      }),
    );
    expect(f.scratchpadRows).toHaveLength(0);
  });
});
