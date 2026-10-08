import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { handoffToGroupBot } from "./group-handoff.js";

const run = {
  id: "run-a",
  spaceId: "workspace-1",
  threadId: "thread-1",
  botId: "bot-a",
  userId: "user-1",
};

function harness(
  sourceBlocks: unknown,
  existing?: { sourceRuns: { id: string; botId: string }[] },
  options?: { sourceOrchestration?: unknown; newUserMessage?: { id: string } | null },
) {
  const runCreate = vi.fn(async () => ({ id: "run-b" }));
  const messageCreate = vi.fn(async () => ({ id: "message-1" }));
  const eventCreate = vi.fn(async (_input: unknown) => ({ seq: 1 }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "group-1" }]),
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group-1",
        members: ["bot-a", "bot-b", "bot-c"].map((id) => ({
          bot: { id, name: id.toUpperCase() },
        })),
      })),
      update: vi.fn(async () => ({ id: "group-1" })),
    },
    run: {
      findFirst: vi.fn(async () => ({
        id: run.id,
        orchestration: options?.sourceOrchestration ?? null,
        sourceMessage: { blocks: sourceBlocks, seq: 5 },
      })),
      findUnique: vi.fn(async () => ({ status: "running" })),
      create: runCreate,
    },
    message: {
      findUnique: vi.fn(async () => existing ?? null),
      findFirst: vi.fn(async () => options?.newUserMessage ?? null),
      create: messageCreate,
    },
    thread: {
      update: vi.fn(async (args: { select: { nextMessageSeq?: boolean } }) =>
        args.select.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 2 },
      ),
    },
    task: { create: vi.fn(async () => ({ id: "task-b" })) },
    event: {
      findFirst: vi.fn(async () => ({ seq: 1 })),
      create: eventCreate,
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  return {
    deps: {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    },
    messageCreate,
    runCreate,
    eventCreate,
  };
}

describe("group handoff ownership", () => {
  it("marks a new ownership transfer as a follow-up with a chain hop", async () => {
    const { deps, messageCreate, runCreate } = harness([{ kind: "text", text: "user request" }]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Do the distinct next stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });

    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [
            expect.objectContaining({
              kind: "handoff",
              fromBotId: "bot-a",
              toBotId: "bot-b",
              hop: 1,
            }),
          ],
        }),
      }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "follow_up" }) }),
    );
  });

  it("refuses to bounce a handed-off stage straight back to its sender", async () => {
    const { deps, runCreate } = harness([
      { kind: "handoff", fromBotId: "bot-b", toBotId: "bot-a", text: "Investigate", hop: 1 },
    ]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "You investigate it",
      }),
    ).resolves.toEqual({
      error:
        "Do not hand this stage back merely to report completion. Complete it here or send a useful result/message instead.",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("caps longer multi-agent handoff chains", async () => {
    const { deps, runCreate } = harness([
      { kind: "handoff", fromBotId: "bot-b", toBotId: "bot-a", text: "Stage six", hop: 6 },
    ]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-c",
        message: "Stage seven",
      }),
    ).resolves.toEqual({
      error:
        "Handoff limit reached for this user turn. Complete the current stage yourself or explain the blocker.",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("reuses the recorded transfer when a source run is retried", async () => {
    const { deps, messageCreate, runCreate } = harness([], {
      sourceRuns: [{ id: "run-b", botId: "bot-b" }],
    });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-c",
        message: "A duplicate stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b", runId: "run-b" });
    expect(messageCreate).not.toHaveBeenCalled();
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("rejects malformed source ancestry instead of restarting its hop count", async () => {
    const { deps, runCreate } = harness({ kind: "not-an-array" });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Continue",
      }),
    ).resolves.toEqual({ error: "cannot verify the group handoff chain" });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("records the ownership lineage snapshot on the new owner's run", async () => {
    const { deps, runCreate } = harness([{ kind: "text", text: "user request" }]);

    await handoffToGroupBot(deps as never, run, "group-1", {
      bot_id: "bot-b",
      message: "Own the financial stage",
    });

    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-b",
          orchestration: {
            version: "v1",
            routing: { kind: "handoff" },
            ownership: { mode: "owner", ownerBotId: "bot-b" },
            responseMode: "single",
            execution: {
              interactive: true,
              planning: "auto",
              delegation: { mode: "auto", background: true, maxChildren: 3, maxDepth: 1 },
            },
            collaboration: {
              role: "owner",
              source: "handoff",
              fromBotId: "bot-a",
              parentRunId: "run-a",
              handoffDepth: 1,
              messageHop: 0,
            },
          },
        }),
      }),
    );
  });

  it("emits thread.turn.handed_off with the lineage payload", async () => {
    const { deps, eventCreate } = harness([{ kind: "text", text: "user request" }]);

    await handoffToGroupBot(deps as never, run, "group-1", {
      bot_id: "bot-b",
      message: "Own the financial stage",
    });

    const handedOff = eventCreate.mock.calls
      .map(([arg]) => arg as { data: { type: string; payload: Record<string, unknown> } })
      .filter((arg) => arg.data.type === "thread.turn.handed_off");
    expect(handedOff).toHaveLength(1);
    expect(handedOff[0]!.data.payload).toEqual({
      fromBotId: "bot-a",
      toBotId: "bot-b",
      fromRunId: "run-a",
      toRunId: "run-b",
      handoffDepth: 1,
    });
  });

  it("allows the second transfer and rejects the third (hard depth 2)", async () => {
    const second = harness([{ kind: "text", text: "user request" }], undefined, {
      sourceOrchestration: {
        version: "v1",
        routing: { kind: "handoff" },
        ownership: { mode: "owner", ownerBotId: "bot-a" },
        responseMode: "single",
        collaboration: {
          role: "owner",
          source: "handoff",
          fromBotId: "bot-c",
          parentRunId: "run-c",
          handoffDepth: 1,
          messageHop: 0,
        },
      },
    });
    await expect(
      handoffToGroupBot(second.deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Second transfer",
      }),
    ).resolves.toMatchObject({ ok: true });

    const third = harness([{ kind: "text", text: "user request" }], undefined, {
      sourceOrchestration: {
        version: "v1",
        routing: { kind: "handoff" },
        ownership: { mode: "owner", ownerBotId: "bot-a" },
        responseMode: "single",
        collaboration: {
          role: "owner",
          source: "handoff",
          fromBotId: "bot-c",
          parentRunId: "run-c",
          handoffDepth: 2,
          messageHop: 0,
        },
      },
    });
    await expect(
      handoffToGroupBot(third.deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Third transfer",
      }),
    ).resolves.toEqual({
      error:
        "Handoff limit reached for this user turn. Complete the current stage yourself or explain the blocker.",
    });
    expect(third.runCreate).not.toHaveBeenCalled();
  });

  it("rejects an invalid target and leaves ownership untouched", async () => {
    const { deps, runCreate, messageCreate } = harness([{ kind: "text", text: "user request" }]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-outsider",
        message: "Take this stage",
      }),
    ).resolves.toEqual({ error: "handoff target is not a group member" });
    expect(runCreate).not.toHaveBeenCalled();
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("releases the bounce rule when the user sent a new instruction after the handoff", async () => {
    const { deps, runCreate } = harness(
      [{ kind: "handoff", fromBotId: "bot-b", toBotId: "bot-a", text: "Investigate", hop: 1 }],
      undefined,
      { newUserMessage: { id: "msg-user-2" } },
    );

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "The user redirected; take the next stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });
    expect(runCreate).toHaveBeenCalled();
  });
});
