import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRunRequest, ConnectorCall, ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  boundDirectApprovalRequest,
  catalogApprovalRequest,
  catalogIdForRoute,
} from "./approval-effect.js";
import type * as AutoReviewModule from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { CATALOG_EXECUTE } from "./lazy-tool-catalog.js";

const CATALOG_MARKER = "__rakazoCatalogTool";

const hookRoute = {
  connectorId: "fixture",
  resourceId: "hook",
  toolName: "hook_write",
};

const hookTool: ConnectorTool = {
  name: "hook_write",
  description: "POST a countable local fixture",
  readOnly: false,
  inputSchema: { type: "object" },
  route: hookRoute,
};

const catalogExecuteTool: ConnectorTool = {
  name: "fixture_execute_tool",
  description: "Run a fixture tool by id",
  readOnly: false,
  inputSchema: { type: "object" },
  route: { connectorId: "fixture", toolName: CATALOG_EXECUTE },
};

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
  operationId?: string;
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

function fixture(
  runId = "run-retry",
  opts: {
    tools?: ConnectorTool[];
    hops?: string[];
    retryOfRunId?: string | null;
    failLiveRefresh?: boolean;
    resolveCall?: (
      call: ConnectorCall,
    ) => Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined>;
  } = {},
) {
  const hops = opts.hops ?? ["run-old"];
  const predecessorId = hops[0]!;
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const prompts: string[] = [];
  const toolSchemas: Record<string, unknown> = {};
  const scratchpadRows: Array<{ title: string }> = [];
  let discoverCount = 0;
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
    retryOfRunId: opts.retryOfRunId === undefined ? predecessorId : opts.retryOfRunId,
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
      const id = `effect-${effects.length + 1}`;
      const effect = {
        ...data,
        id,
        createdAt: new Date(),
        operationId: data.operationId ?? id,
      };
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
    runPlan: { findUnique: vi.fn(async () => null) },
    runPlanReview: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    deliveryRecord: { findMany: vi.fn(async () => []) },
    run: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) => {
        if (!where.id || where.id === run.id) return run;
        const index = hops.indexOf(where.id);
        if (index >= 0) {
          return { id: hops[index], retryOfRunId: hops[index + 1] ?? null };
        }
        return run;
      }),
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
    memoryFact: { findMany: vi.fn(async () => []) },
    memoryShard: { findMany: vi.fn(async () => []) },
    contextSummary: { findFirst: vi.fn(async () => null) },
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
    const liveTools = request.currentTools ? await request.currentTools() : request.tools;
    for (const tool of liveTools) {
      toolSchemas[tool.name] = tool.inputSchema;
    }
    for (const call of calls) {
      results.push(await request.executeTool!(call.name, call.args, call.executionId));
    }
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    prisma,
    taskInstructions: async () => ({
      envelope: {
        taskId: run.taskId,
        revision: 1,
        original: { content: "Send the weekly report to Ada" },
        amendments: [],
      },
      ref: { taskId: run.taskId, consumedRevision: 1 },
    }),
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => {
        discoverCount += 1;
        if (opts.failLiveRefresh && discoverCount > 1) {
          throw new Error("live refresh failed");
        }
        return opts.tools ?? [hookTool];
      },
      resolveCall: opts.resolveCall ?? (async () => undefined),
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
    toolSchemas,
    scratchpadRows,
    append,
    pauseRunForInput,
    execute,
    predecessorId,
    seed(effect: Omit<Effect, "createdAt"> & { createdAt?: Date }) {
      effects.push({
        createdAt: new Date("2026-10-19T00:00:00.000Z"),
        operationId: effect.operationId ?? effect.id,
        ...effect,
      });
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

async function resolveCatalogHook(call: ConnectorCall) {
  if (call.route?.resourceId || call.route?.toolName !== CATALOG_EXECUTE) return undefined;
  const inner = call.args.arguments;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return undefined;
  return {
    tool: hookTool,
    call: {
      tool: hookTool.name,
      args: inner as Record<string, unknown>,
      executionId: call.executionId,
      route: hookRoute,
    },
  };
}

describe("manual retry effect reuse (production executor)", () => {
  it("reuses a completed bound-direct connector request and does not POST again", async () => {
    const http = await listen();
    try {
      const f = fixture();
      const args = { url: `${http.url}/items`, body: "hello" };
      f.seed({
        id: "e-old",
        operationId: "op-bound",
        runId: f.predecessorId,
        kind: "hook_write",
        idempotencyKey: "old-hook",
        status: "completed",
        request: boundDirectApprovalRequest(hookRoute, args, CATALOG_MARKER),
        result: { ok: true, id: "ext-1" },
      });
      f.setCalls([
        {
          name: "hook_write",
          args: { ...args, retryOperationId: "op-bound" },
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
      expect(f.prompts[0]).toContain("retryOperationId=op-bound");
      expect(f.prompts[0]).toContain("hook_write");
    } finally {
      http.server.close();
    }
  });

  it("reuses a completed catalog connector request and does not POST again", async () => {
    const http = await listen();
    try {
      const f = fixture("run-retry", {
        tools: [catalogExecuteTool, hookTool],
        resolveCall: resolveCatalogHook,
      });
      const args = { url: `${http.url}/items`, body: "hello" };
      const catalogArgs = { id: catalogIdForRoute(hookRoute), arguments: args };
      f.seed({
        id: "e-catalog",
        operationId: "op-catalog",
        runId: f.predecessorId,
        kind: "hook_write",
        idempotencyKey: "old-catalog",
        status: "completed",
        request: catalogApprovalRequest(
          "fixture_execute_tool",
          catalogArgs,
          CATALOG_MARKER,
          hookRoute,
        ),
        result: { ok: true, id: "ext-catalog" },
      });
      f.setCalls([
        {
          name: "fixture_execute_tool",
          args: { ...catalogArgs, retryOperationId: "op-catalog" },
          executionId: "call-catalog",
        },
      ]);
      await f.run();
      expect(http.hits).toHaveLength(0);
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.results[0]).toEqual({ ok: true, id: "ext-catalog" });
      expect(f.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "effect.reconciled",
          payload: expect.objectContaining({
            sourceEffectId: "e-catalog",
            reuse: "manual_retry",
            kind: "hook_write",
          }),
        }),
      );
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
      operationId: "op-unknown",
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
        args: { title: "follow up with design", retryOperationId: "op-unknown" },
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

  it("continues the second same-args operation after skipping the completed first", async () => {
    const http = await listen();
    try {
      const f = fixture();
      const args = { url: `${http.url}/items`, body: "hello" };
      const request = boundDirectApprovalRequest(hookRoute, args, CATALOG_MARKER);
      f.seed({
        id: "e-first",
        operationId: "op-first",
        runId: f.predecessorId,
        kind: "hook_write",
        idempotencyKey: "old-first",
        status: "completed",
        request,
        result: { ok: true, id: "ext-1" },
      });
      f.seed({
        id: "e-second",
        operationId: "op-second",
        runId: f.predecessorId,
        kind: "hook_write",
        idempotencyKey: "old-second",
        status: "uncertain",
        request,
        result: null,
        createdAt: new Date("2026-10-19T00:00:01.000Z"),
      });
      f.setCalls([
        {
          name: "hook_write",
          args: { ...args, retryOperationId: "op-second" },
          executionId: "call-second",
        },
      ]);
      await f.run();
      expect(http.hits).toHaveLength(0);
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledWith(
        expect.objectContaining({ manualRetryEffectId: "e-second" }),
      );
    } finally {
      http.server.close();
    }
  });

  it("reuses reversed different operations by id and treats omit as a new send", async () => {
    const http = await listen();
    try {
      const f = fixture();
      const firstArgs = { url: `${http.url}/items`, body: "first" };
      const secondArgs = { url: `${http.url}/items`, body: "second" };
      f.seed({
        id: "e-a",
        operationId: "op-a",
        runId: f.predecessorId,
        kind: "hook_write",
        idempotencyKey: "old-a",
        status: "completed",
        request: boundDirectApprovalRequest(hookRoute, firstArgs, CATALOG_MARKER),
        result: { ok: true, id: "ext-a" },
      });
      f.seed({
        id: "e-b",
        operationId: "op-b",
        runId: f.predecessorId,
        kind: "hook_write",
        idempotencyKey: "old-b",
        status: "completed",
        request: boundDirectApprovalRequest(hookRoute, secondArgs, CATALOG_MARKER),
        result: { ok: true, id: "ext-b" },
        createdAt: new Date("2026-10-19T00:00:01.000Z"),
      });
      f.setCalls([
        {
          name: "hook_write",
          args: { ...secondArgs, retryOperationId: "op-b" },
          executionId: "call-b",
        },
        {
          name: "hook_write",
          args: { ...firstArgs, retryOperationId: "op-a" },
          executionId: "call-a",
        },
        {
          name: "hook_write",
          args: firstArgs,
          executionId: "call-new",
        },
      ]);
      await f.run();
      expect(f.results[0]).toEqual({ ok: true, id: "ext-b" });
      expect(f.results[1]).toEqual({ ok: true, id: "ext-a" });
      expect(http.hits).toHaveLength(1);
      expect(f.execute).toHaveBeenCalledTimes(1);
    } finally {
      http.server.close();
    }
  });

  it("walks a three-hop chain to the nearest row of the same operation", async () => {
    const http = await listen();
    try {
      const f = fixture("run-retry", { hops: ["run-mid", "run-old"] });
      const args = { url: `${http.url}/items`, body: "hello" };
      const request = boundDirectApprovalRequest(hookRoute, args, CATALOG_MARKER);
      f.seed({
        id: "e-old",
        operationId: "op-1",
        runId: "run-old",
        kind: "hook_write",
        idempotencyKey: "old-1",
        status: "uncertain",
        request,
        result: null,
      });
      f.seed({
        id: "e-mid",
        operationId: "op-1",
        runId: "run-mid",
        kind: "hook_write",
        idempotencyKey: "mid-1",
        status: "completed",
        request,
        result: { ok: true, id: "ext-mid" },
      });
      f.setCalls([
        {
          name: "hook_write",
          args: { ...args, retryOperationId: "op-1" },
          executionId: "call-3",
        },
      ]);
      await f.run();
      expect(http.hits).toHaveLength(0);
      expect(f.results[0]).toEqual({ ok: true, id: "ext-mid" });
    } finally {
      http.server.close();
    }
  });

  it("rejects a foreign operation id without leaking its result", async () => {
    const http = await listen();
    try {
      const f = fixture();
      const args = { url: `${http.url}/items`, body: "hello" };
      f.seed({
        id: "e-old",
        operationId: "op-bound",
        runId: f.predecessorId,
        kind: "hook_write",
        idempotencyKey: "old-hook",
        status: "completed",
        request: boundDirectApprovalRequest(hookRoute, args, CATALOG_MARKER),
        result: { ok: true, id: "secret-ext" },
      });
      f.setCalls([
        {
          name: "hook_write",
          args: { ...args, retryOperationId: "op-other-task" },
          executionId: "call-foreign",
        },
      ]);
      await f.run();
      expect(http.hits).toHaveLength(0);
      expect(f.results[0]).toEqual({
        error: "This operation is not part of the current retry.",
      });
      expect(JSON.stringify(f.results[0])).not.toContain("secret-ext");
    } finally {
      http.server.close();
    }
  });

  it("rejects binding an existing operation id to different arguments", async () => {
    const http = await listen();
    try {
      const f = fixture();
      const args = { url: `${http.url}/items`, body: "hello" };
      f.seed({
        id: "e-old",
        operationId: "op-bound",
        runId: f.predecessorId,
        kind: "hook_write",
        idempotencyKey: "old-hook",
        status: "completed",
        request: boundDirectApprovalRequest(hookRoute, args, CATALOG_MARKER),
        result: { ok: true, id: "ext-1" },
      });
      f.setCalls([
        {
          name: "hook_write",
          args: { ...args, body: "goodbye", retryOperationId: "op-bound" },
          executionId: "call-mismatch",
        },
      ]);
      await f.run();
      expect(http.hits).toHaveLength(0);
      expect(f.results[0]).toEqual({
        error:
          "retryOperationId does not match this tool, resource, or arguments. Continue the listed operation with the same request, or omit retryOperationId to start a new operation.",
      });
    } finally {
      http.server.close();
    }
  });

  it("sends a continued operation only once when the same retry Run repeats its id", async () => {
    const http = await listen();
    try {
      const f = fixture();
      const args = { url: `${http.url}/items`, body: "one logical operation" };
      f.seed({
        id: "e-old-denied",
        operationId: "op-repeat",
        runId: f.predecessorId,
        kind: "hook_write",
        idempotencyKey: "old-denied",
        status: "denied",
        request: boundDirectApprovalRequest(hookRoute, args, CATALOG_MARKER),
        result: null,
      });
      f.setCalls([
        {
          name: "hook_write",
          args: { ...args, retryOperationId: "op-repeat" },
          executionId: "first",
        },
        {
          name: "hook_write",
          args: { ...args, retryOperationId: "op-repeat" },
          executionId: "second",
        },
      ]);
      await f.run();
      expect(http.hits).toHaveLength(1);
      expect(f.execute).toHaveBeenCalledTimes(1);
    } finally {
      http.server.close();
    }
  });

  it("declares retryOperationId on closed direct and catalog model-visible schemas", async () => {
    const f = fixture("run-schema", {
      tools: [closedDirectTool, closedCatalogTool],
    });
    await f.run();
    expectRetryIdentity(f.toolSchemas.hook_write, ["url", "body"]);
    expectRetryIdentity(f.toolSchemas.fixture_execute_tool, ["id", "arguments"]);
  });

  it("keeps retryOperationId on currentTools after a live-refresh failure", async () => {
    const f = fixture("run-schema-fallback", {
      tools: [closedDirectTool, closedCatalogTool],
      failLiveRefresh: true,
    });
    await f.run();
    expectRetryIdentity(f.toolSchemas.hook_write, ["url", "body"]);
    expectRetryIdentity(f.toolSchemas.fixture_execute_tool, ["id", "arguments"]);
  });

  it("does not declare retryOperationId on an ordinary run", async () => {
    const f = fixture("run-ordinary", {
      tools: [closedDirectTool, closedCatalogTool],
      retryOfRunId: null,
    });
    await f.run();
    expectOrdinarySchema(f.toolSchemas.hook_write, ["url", "body"]);
    expectOrdinarySchema(f.toolSchemas.fixture_execute_tool, ["id", "arguments"]);
  });
});

const closedDirectTool: ConnectorTool = {
  ...hookTool,
  inputSchema: {
    type: "object",
    properties: { url: { type: "string" }, body: { type: "string" } },
    required: ["url", "body"],
    additionalProperties: false,
  },
};

const closedCatalogTool: ConnectorTool = {
  ...catalogExecuteTool,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      arguments: { type: "object" },
    },
    required: ["id", "arguments"],
    additionalProperties: false,
  },
};

function expectRetryIdentity(schema: unknown, keys: string[]) {
  const properties = (schema as { properties: Record<string, unknown> }).properties;
  expect(schema).toEqual(
    expect.objectContaining({
      additionalProperties: false,
      properties: expect.objectContaining({
        ...Object.fromEntries(keys.map((key) => [key, expect.anything()])),
        retryOperationId: expect.objectContaining({ type: "string" }),
      }),
    }),
  );
  expect(properties.retryOperationId).toEqual(expect.objectContaining({ type: "string" }));
}

function expectOrdinarySchema(schema: unknown, keys: string[]) {
  const properties = (schema as { properties: Record<string, unknown> }).properties;
  expect(schema).toEqual(
    expect.objectContaining({
      additionalProperties: false,
      properties: expect.objectContaining(
        Object.fromEntries(keys.map((key) => [key, expect.anything()])),
      ),
    }),
  );
  expect(properties.retryOperationId).toBeUndefined();
}
