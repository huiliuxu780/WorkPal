import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    taskId: "task-1",
    status: "completed",
    waitKind: null,
    trigger: "user",
    orchestration: null,
    error: null,
    sourceMessageId: null,
    startedAt: new Date("2026-10-12T00:00:00.000Z"),
    completedAt: new Date("2026-10-12T00:01:00.000Z"),
    createdAt: new Date("2026-10-12T00:00:00.000Z"),
    updatedAt: new Date("2026-10-12T00:01:00.000Z"),
    snapshotRev: 0,
    ...overrides,
  };
}

function executionDeps(input: {
  runs?: ReturnType<typeof runRow>[];
  messages?: unknown[];
}) {
  const emptyFind = vi.fn().mockResolvedValue([]);
  const tx = {
    // FOR SHARE lock statement + grouped raw scans: every raw query resolves
    // to no rows here, so rev stays 0 and the anchors are resolved from the
    // message rows the detail pass reads directly.
    $queryRaw: vi.fn().mockResolvedValue([]),
    run: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        (input.runs ?? []).find(
          (row) => row.id === where.id && row.threadId === where.threadId && row.spaceId === where.spaceId,
        ) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { id?: { in?: string[] } } }) =>
        (input.runs ?? []).filter((row) => !where.id?.in || where.id.in.includes(row.id)),
      ),
      findUniqueOrThrow: vi.fn(async () => runRow()),
      findUnique: vi.fn(async () => null),
    },
    task: { findMany: emptyFind },
    message: { findMany: vi.fn().mockResolvedValue(input.messages ?? []), findFirst: vi.fn().mockResolvedValue(null) },
    event: {
      findMany: emptyFind,
      findFirst: vi.fn().mockResolvedValue(null),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    runPlan: { findUnique: vi.fn().mockResolvedValue(null) },
    runStep: { findMany: emptyFind, groupBy: vi.fn().mockResolvedValue([]) },
    runTodo: { findMany: emptyFind, groupBy: vi.fn().mockResolvedValue([]) },
    intervention: { findMany: emptyFind },
    artifact: { findMany: emptyFind, groupBy: vi.fn().mockResolvedValue([]) },
    backgroundAgentTask: { findMany: emptyFind, groupBy: vi.fn().mockResolvedValue([]) },
    bot: { findUnique: vi.fn().mockResolvedValue({ name: "Chief" }) },
  };
  const prisma = {
    // The activity-page handler reads through the top-level client, so the
    // same model mocks back both paths.
    ...tx,
    bot: {
      ...tx.bot,
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.spaceId === actor.spaceId && where.userId === actor.userId
          ? { id: "bot-1", spaceId: "space-1", userId: "user-1", thread: { id: "thread-1" }, computer: null }
          : null,
      ),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    env: { webOrigin: "http://127.0.0.1:5173", screenProxySecret: "s".repeat(32) },
    dataDir: "/tmp/rakazo-execution-rpc-test",
  } as unknown as RouterDeps;
  return { deps, handler: new RPCHandler(createRouter(deps)), tx };
}

async function call(
  handler: RPCHandler<ReturnType<typeof createRouter>>,
  procedure: string,
  body: unknown,
) {
  const { response } = await handler.handle(
    new Request(`http://127.0.0.1/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: body }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  return response;
}

describe("runs.executionSnapshot", () => {
  it("reads one Run of the addressed thread with its result and empty sections", async () => {
    const { handler } = executionDeps({
      runs: [runRow()],
      messages: [
        {
          id: "message-ask",
          runId: "run-1",
          blocks: [{ kind: "ask", text: "City?", status: "answered", answer: "Paris" }],
        },
        { id: "message-result", runId: "run-1", blocks: [{ kind: "text", text: "Done: Paris" }] },
      ],
    });
    const response = await call(handler, "runs/executionSnapshot", {
      botId: "bot-1",
      runId: "run-1",
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { json?: Record<string, unknown> };
    const snapshot = payload.json as {
      summary: { runId: string; entry: string };
      result?: { messageId: string; blocks: Array<{ kind: string }> };
      interventions: unknown[];
      steps: { items: unknown[]; truncated: boolean };
    };
    expect(snapshot.summary.runId).toBe("run-1");
    expect(snapshot.summary.entry).toBe("execution");
    expect(snapshot.result?.messageId).toBe("message-result");
    // The ask card never surfaces as the result.
    expect(snapshot.result?.blocks.every((block) => block.kind !== "ask")).toBe(true);
    expect(snapshot.steps).toEqual({ items: [], truncated: false, total: 0 });
  });

  it("rejects a Run of another thread or space without leaking existence", async () => {
    const { handler } = executionDeps({ runs: [runRow({ threadId: "thread-other" })] });
    const response = await call(handler, "runs/executionSnapshot", {
      botId: "bot-1",
      runId: "run-1",
    });
    expect(response.ok).toBe(false);

    const foreign = executionDeps({ runs: [runRow({ spaceId: "space-2" })] });
    const foreignResponse = await call(foreign.handler, "runs/executionSnapshot", {
      botId: "bot-1",
      runId: "run-1",
    });
    expect(foreignResponse.ok).toBe(false);
  });

  it("refuses threads the actor does not own", async () => {
    const { handler } = executionDeps({});
    const response = await call(handler, "runs/executionSnapshot", {
      botId: "bot-other-space",
      runId: "run-1",
    });
    expect(response.ok).toBe(false);
  });
});

describe("runs.executionActivityPage", () => {
  it("rejects a cursor that does not decode to this Run", async () => {
    const { handler } = executionDeps({ runs: [runRow({ status: "running" })] });
    const forged = Buffer.from(
      JSON.stringify({ v: 1, r: "run-other", g: 0, hi: 10, nx: 5 }),
    ).toString("base64url");
    const response = await call(handler, "runs/executionActivityPage", {
      botId: "bot-1",
      runId: "run-1",
      cursor: forged,
    });
    expect(response.status).toBe(400);
    const text = JSON.stringify(await response.json());
    expect(text.toLowerCase()).toContain("cursor");
  });

  it("rejects malformed cursors and returns an empty page without events", async () => {
    const { handler } = executionDeps({ runs: [runRow()] });
    const malformed = await call(handler, "runs/executionActivityPage", {
      botId: "bot-1",
      runId: "run-1",
      cursor: "not-a-cursor-at-all",
    });
    expect(malformed.ok).toBe(false);

    const first = await call(handler, "runs/executionActivityPage", { botId: "bot-1", runId: "run-1" });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      json: { items: [], olderCursor: null, truncated: false },
    });
  });
});
