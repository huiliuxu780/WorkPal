import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { callClientNonce } from "@rakazo/core";
import type * as MessageQuoteModule from "@rakazo/core/message-quote";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  cancelSupersededQueuedRuns,
  reactToThreadMessage,
  sendThreadMessage,
  stopThreadRuns,
  type ThreadTarget,
  threadHead,
  threadSnapshot,
} from "./thread-target.js";

// Passthrough mock: every hint derives for real except the sentinel that
// exercises the "derivation must never cost the send" path.
vi.mock("@rakazo/core/message-quote", async (importOriginal) => {
  const actual = await importOriginal<typeof MessageQuoteModule>();
  return {
    ...actual,
    deriveMessageQuote: (
      blocks: MessageBlock[],
      hint: string,
      format: "markdown" | "plain-text",
    ) => {
      if (hint === "explode derivation") throw new Error("derivation blew up");
      return actual.deriveMessageQuote(blocks, hint, format);
    },
  };
});

describe("threadHead", () => {
  it("returns the durable cursor without loading a snapshot", async () => {
    const findFirst = vi.fn().mockResolvedValue({ seq: 12 });
    const prisma = { event: { findFirst } } as unknown as PrismaClient;
    const target = { threadId: "thread-1" } as ThreadTarget;

    await expect(threadHead(prisma, target)).resolves.toEqual({
      threadId: "thread-1",
      cursor: 12,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { threadId: "thread-1" },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
  });
});

describe("queued run supersession", () => {
  it("only cancels queued runs started by user messages or reactions", async () => {
    const tx = {
      $queryRaw: vi.fn(),
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 1 }) },
      run: {
        findMany: vi.fn(async (args?: { where?: { id?: { in?: string[] }; trigger?: string } }) => {
          if (args?.where?.trigger) return [];
          if (args?.where?.id?.in?.includes("run-new")) {
            return [
              {
                id: "run-new",
                botId: "bot-1",
                threadId: "thread-1",
                status: "queued",
              },
            ];
          }
          return [
            {
              id: "run-old",
              taskId: "task-old",
              threadId: "thread-1",
              spaceId: "workspace-1",
              botId: "bot-1",
            },
          ];
        }),
        updateManyAndReturn: vi.fn().mockResolvedValue([
          {
            id: "run-old",
            taskId: "task-old",
            threadId: "thread-1",
            spaceId: "workspace-1",
            botId: "bot-1",
          },
        ]),
        findUnique: vi.fn(async (args?: { where?: { id?: string } }) =>
          args?.where?.id === "run-new"
            ? { id: "run-new", botId: "bot-1", threadId: "thread-1", status: "queued" }
            : { status: "cancelled" },
        ),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      steeringMessage: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      event: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data) },
    };
    await cancelSupersededQueuedRuns(tx as never, {
      threadId: "thread-1",
      botIds: ["bot-1"],
      keepRunIds: ["run-new"],
    });
    expect(tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ trigger: "user", sourceMessage: { role: "user" } }, { trigger: "reaction" }],
        }),
      }),
    );
    expect(tx.run.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "cancelled",
          waitKind: null,
          waitStartedAt: null,
          retryAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        }),
      }),
    );
    expect(tx.attempt.updateMany).toHaveBeenCalled();
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["task-old"] } },
      data: { status: "cancelled" },
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "run.cancelled",
        runId: "run-old",
        payload: expect.objectContaining({
          reason: "superseded",
          steering: "migrate",
          reportDelegationOutcome: true,
          replacementRunId: "run-new",
        }),
      }),
    });
  });
});

describe("reaction messages", () => {
  it("appends repeated reactions as quiet replies and deduplicates retries", async () => {
    const messages = new Map<string, { id: string }>();
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      message: {
        findFirst: vi.fn().mockResolvedValue({ id: "parent" }),
        findUnique: vi.fn(
          async ({ where }: { where: { threadId_clientNonce: { clientNonce: string } } }) =>
            messages.get(where.threadId_clientNonce.clientNonce) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: { clientNonce: string } }) => {
          const message = { id: `reaction-${messages.size}`, ...data };
          messages.set(data.clientNonce, message);
          return message;
        }),
      },
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: `event-${eventSeq}`,
          createdAt: new Date(),
          ...data,
        })),
      },
      task: { create: vi.fn() },
      run: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "space-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;
    for (const [clientNonce, reaction] of [
      ["first", "❤️"],
      ["second", "👍"],
      ["third", "❤️"],
      ["third", "❤️"],
    ] as const) {
      await reactToThreadMessage({ prisma }, actor, target, {
        messageId: "parent",
        reaction,
        clientNonce,
      });
    }
    expect(tx.message.create).toHaveBeenCalledTimes(3);
    expect(tx.event.create).toHaveBeenCalledTimes(3);
    expect(tx.message.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        role: "user",
        blocks: [{ kind: "text", text: "❤️" }],
        replyToMessageId: "parent",
        clientNonce: "third",
      }),
    });
    expect(tx.event.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        type: "thread.message.created",
        payload: {
          messageId: "reaction-2",
          role: "user",
          blocks: [{ kind: "text", text: "❤️" }],
          replyToMessageId: "parent",
        },
      }),
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.message.findFirst).toHaveBeenCalledWith({
      where: { id: "parent", threadId: "thread-1" },
      select: { id: true },
    });
    tx.message.findFirst.mockResolvedValueOnce(null);
    await expect(
      reactToThreadMessage({ prisma }, actor, target, {
        messageId: "elsewhere",
        reaction: "❤️",
        clientNonce: "fourth",
      }),
    ).rejects.toThrow();
    expect(tx.message.create).toHaveBeenCalledTimes(3);
  });
});

describe("CARD-01 snapshot gate", () => {
  function fixture() {
    const tx = {
      backgroundAgentTask: { findMany: vi.fn().mockResolvedValue([]) },
      runPlan: { findMany: vi.fn().mockResolvedValue([]) },
      runStep: { findMany: vi.fn().mockResolvedValue([]) },
      runTodo: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue({ seq: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      run: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
      thread: { findMany: vi.fn().mockResolvedValue([]) },
      bot: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      spaceId: "space-1",
      bot: { name: "Bot", computer: null },
    } as ThreadTarget;
    return { prisma, target, tx };
  }

  it("leaves the old snapshot shape untouched while the gate is off", async () => {
    const { prisma, target } = fixture();
    const snapshot = await threadSnapshot({ prisma }, target);
    expect(snapshot).not.toHaveProperty("interactionCapabilities");
    expect(snapshot).not.toHaveProperty("interactions");
    expect(snapshot).not.toHaveProperty("displayBlocks");
  });

  it("projects the capability and strict arrays only when the gate is on", async () => {
    const { prisma, target } = fixture();
    const snapshot = await threadSnapshot({ prisma, cardsUnifiedV2: true }, target);
    expect(snapshot.interactionCapabilities).toEqual({ cardsUnifiedV2: true });
    expect(snapshot.interactions).toEqual([]);
    expect(snapshot.displayBlocks).toEqual([]);
    expect(snapshot).not.toHaveProperty("attention");
  });

  it("projects a delegated takeover into the visible origin thread", async () => {
    const { prisma, target, tx } = fixture();
    const delegatedRun = {
      id: "run-delegated",
      spaceId: "space-1",
      threadId: "pair-thread-1",
      botId: "bot-2",
      status: "waiting_takeover",
      waitKind: "takeover",
      createdAt: new Date("2026-10-24T10:00:00.000Z"),
      waitStartedAt: new Date("2026-10-24T10:00:00.000Z"),
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    tx.run.findMany.mockImplementation(async (args: { where?: { originThreadId?: unknown } }) =>
      args?.where?.originThreadId ? [delegatedRun] : [],
    );
    tx.bot.findMany.mockResolvedValue([
      {
        id: "bot-2",
        computer: {
          id: "computer-2",
          controlHolder: "none",
          controlBotId: null,
          controlRunId: "run-delegated",
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
        },
      },
    ]);

    const snapshot = await threadSnapshot({ prisma, cardsUnifiedV2: true }, target);

    expect(snapshot.interactions).toEqual([
      expect.objectContaining({
        kind: "session_control",
        action: "takeover",
        runId: "run-delegated",
        botId: "bot-2",
        computerId: "computer-2",
        source: expect.objectContaining({
          threadId: "thread-1",
          runId: "run-delegated",
          botId: "bot-2",
        }),
      }),
    ]);
    // The hidden pair Thread must never reach the visible snapshot.
    expect(JSON.stringify(snapshot)).not.toContain("pair-thread-1");
  });

  it("projects a delegated takeover into the visible origin group thread", async () => {
    const { prisma, target: botTarget, tx } = fixture();
    const delegatedRun = {
      id: "run-delegated",
      spaceId: "space-1",
      threadId: "pair-thread-1",
      botId: "bot-2",
      status: "waiting_takeover",
      waitKind: "takeover",
      createdAt: new Date("2026-10-24T10:00:00.000Z"),
      waitStartedAt: new Date("2026-10-24T10:00:00.000Z"),
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    tx.run.findMany.mockImplementation(async (args: { where?: { originThreadId?: unknown } }) =>
      args?.where?.originThreadId ? [delegatedRun] : [],
    );
    tx.bot.findMany.mockResolvedValue([
      {
        id: "bot-2",
        computer: {
          id: "computer-2",
          controlHolder: "none",
          controlBotId: null,
          controlRunId: "run-delegated",
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
        },
      },
    ]);
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      spaceId: botTarget.kind === "bot" ? botTarget.spaceId : "space-1",
      leadBotId: null,
      members: [],
      memberBotIds: [],
      threadId: "thread-1",
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma, cardsUnifiedV2: true }, target);

    expect(snapshot.interactions).toEqual([
      expect.objectContaining({
        kind: "session_control",
        action: "takeover",
        runId: "run-delegated",
        computerId: "computer-2",
        source: expect.objectContaining({ threadId: "thread-1", botId: "bot-2" }),
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("pair-thread-1");
  });

  it("resolves a direct group Run's hand-back against its own Bot computer", async () => {
    const { prisma, tx } = fixture();
    const activeRun = {
      id: "run-group",
      spaceId: "space-1",
      threadId: "thread-1",
      taskId: "task-1",
      botId: "bot-2",
      status: "waiting_takeover",
      waitKind: "takeover",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      waitStartedAt: new Date("2026-10-24T10:00:00.000Z"),
      leaseOwner: null,
      leaseExpiresAt: null,
      createdAt: new Date("2026-10-24T10:00:00.000Z"),
      updatedAt: new Date("2026-10-24T10:00:00.000Z"),
      snapshotRev: 0,
    };
    tx.run.findMany.mockImplementation(
      async (args: { where?: { status?: { in?: string[] }; originThreadId?: unknown } }) => {
        if (args?.where?.originThreadId) return [];
        const statuses = args?.where?.status?.in ?? [];
        return statuses.includes("waiting_takeover") ? [activeRun] : [];
      },
    );
    tx.bot.findMany.mockResolvedValue([
      {
        id: "bot-2",
        computer: {
          id: "computer-2",
          controlHolder: "user",
          controlBotId: "bot-2",
          controlRunId: "run-group",
          controlLeaseId: "lease-2",
          controlLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
      },
    ]);
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      spaceId: "space-1",
      leadBotId: null,
      members: [],
      memberBotIds: [],
      threadId: "thread-1",
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma, cardsUnifiedV2: true }, target);

    expect(snapshot.interactions).toEqual([
      expect.objectContaining({
        kind: "session_control",
        action: "return",
        runId: "run-group",
        computerId: "computer-2",
      }),
    ]);
  });
});

describe("threadSnapshot", () => {
  it("reloads tool-only live messages for an active run", async () => {
    const run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
      updatedAt: new Date("2026-08-23T00:00:00.000Z"),
      snapshotRev: 0,
    };
    const findManyEvents = vi.fn().mockResolvedValue([
      {
        id: "event-1",
        threadId: "thread-1",
        botId: "bot-1",
        seq: 4,
        type: "agent.tool.called",
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
        createdAt: new Date("2026-08-23T00:00:00.000Z"),
        updatedAt: new Date("2026-08-23T00:00:00.000Z"),
      },
    ]);
    const tx = {
      backgroundAgentTask: { findMany: vi.fn().mockResolvedValue([]) },
      runPlan: { findMany: vi.fn().mockResolvedValue([]) },
      runStep: { findMany: vi.fn().mockResolvedValue([]) },
      runTodo: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue({ seq: 4 }),
        findMany: findManyEvents,
      },
      run: { findFirst: botRunFindFirst([run]), findMany: vi.fn().mockResolvedValue([]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    // The FOR SHARE thread lock only: the summary builder keys its grouped
    // event scans off the AUTHORIZED run rows, and this fixture's findMany
    // returns none — so no ceiling/generation scans are issued at all.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(findManyEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: {
            in: ["thread.progress", "thread.subagent", "agent.tool.called", "agent.tool.completed"],
          },
        }),
      }),
    );
    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        botId: "bot-1",
        blocks: [
          {
            kind: "steps",
            steps: [{ label: "Slack find channels", count: 1 }],
          },
        ],
      }),
    ]);
  });

  it("returns the latest failed run so the client can show its error", async () => {
    const run = {
      id: "run-failed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "Provider is not configured: openrouter",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
      updatedAt: new Date("2026-08-23T00:00:00.000Z"),
      snapshotRev: 0,
    };
    const findManyEvents = vi.fn().mockResolvedValue([]);
    const findFirstRun = botRunFindFirst([run]);
    const tx = {
      backgroundAgentTask: { findMany: vi.fn().mockResolvedValue([]) },
      runPlan: { findMany: vi.fn().mockResolvedValue([]) },
      runStep: { findMany: vi.fn().mockResolvedValue([]) },
      runTodo: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: findManyEvents,
      },
      run: { findFirst: findFirstRun, findMany: vi.fn().mockResolvedValue([run]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-1",
          threadId: "thread-1",
          trigger: { not: "bot_message" },
          status: {
            in: ["queued", "leased", "running", "waiting_input", "waiting_takeover", "failed"],
          },
        }),
      }),
    );
    expect(snapshot.recentRuns).toEqual([
      expect.objectContaining({ id: "run-failed", status: "failed" }),
    ]);
    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          botId: "bot-1",
          threadId: "thread-1",
          status: { in: ["waiting_input", "waiting_takeover"] },
        },
      }),
    );
    expect(snapshot.run).toEqual(
      expect.objectContaining({
        id: "run-failed",
        status: "failed",
        error: "Provider is not configured: openrouter",
      }),
    );
    // Only the bounded activity projection may query events for an inactive
    // run — never the live-events fold.
    expect(findManyEvents).toHaveBeenCalledTimes(1);
    expect(
      (findManyEvents.mock.calls[0]![0] as { where: { runId?: unknown } }).where.runId,
    ).toBeUndefined();
  });

  it("prefers a waiting peer ask over a concurrent user run", async () => {
    const waitingPeer = {
      id: "run-peer-waiting",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
      updatedAt: new Date("2026-08-23T00:00:02.000Z"),
      snapshotRev: 0,
    };
    const olderUser = {
      id: "run-user",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-user",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
      updatedAt: new Date("2026-08-23T00:00:01.000Z"),
      snapshotRev: 0,
    };
    const snapshot = await threadSnapshot(
      {
        prisma: {
          $transaction: vi.fn(async (callback: (client: unknown) => unknown) =>
            callback({
              $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
              backgroundAgentTask: { findMany: vi.fn().mockResolvedValue([]) },
              runPlan: { findMany: vi.fn().mockResolvedValue([]) },
              runStep: { findMany: vi.fn().mockResolvedValue([]) },
              runTodo: { findMany: vi.fn().mockResolvedValue([]) },
              message: { findMany: vi.fn().mockResolvedValue([]) },
              event: {
                findFirst: vi.fn().mockResolvedValue(null),
                findMany: vi.fn().mockResolvedValue([]),
              },
              run: {
                findFirst: botRunFindFirst([waitingPeer, olderUser]),
                findMany: vi.fn().mockResolvedValue([]),
              },
            }),
          ),
        } as unknown as PrismaClient,
      },
      {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget,
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-peer-waiting", status: "waiting_input" }),
    );
  });

  it("drops a failed run once a newer run has finished", async () => {
    const failed = {
      id: "run-failed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "This operation was aborted",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
      updatedAt: new Date("2026-08-23T00:00:00.000Z"),
      snapshotRev: 0,
    };
    const completed = {
      id: "run-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:03.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
      updatedAt: new Date("2026-08-23T00:00:02.000Z"),
      snapshotRev: 0,
    };
    const findFirstRun = botRunFindFirst([failed, completed]);
    const tx = {
      backgroundAgentTask: { findMany: vi.fn().mockResolvedValue([]) },
      runPlan: { findMany: vi.fn().mockResolvedValue([]) },
      runStep: { findMany: vi.fn().mockResolvedValue([]) },
      runTodo: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
      run: { findFirst: findFirstRun, findMany: vi.fn().mockResolvedValue([]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: { not: "bot_message" },
          status: { in: ["failed", "completed", "cancelled"] },
        }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    expect(snapshot.run).toBeNull();
  });

  it("does not return a cancelled or completed run", async () => {
    const findManyEvents = vi.fn().mockResolvedValue([]);
    const findFirstRun = botRunFindFirst([]);
    const tx = {
      backgroundAgentTask: { findMany: vi.fn().mockResolvedValue([]) },
      runPlan: { findMany: vi.fn().mockResolvedValue([]) },
      runStep: { findMany: vi.fn().mockResolvedValue([]) },
      runTodo: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: findManyEvents,
      },
      run: { findFirst: findFirstRun, findMany: vi.fn().mockResolvedValue([]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: ["queued", "leased", "running", "waiting_input", "waiting_takeover", "failed"],
          },
        }),
      }),
    );
    expect(snapshot.run).toBeNull();
    // Only the bounded activity projection may query events for an inactive
    // run — never the live-events fold.
    expect(findManyEvents).toHaveBeenCalledTimes(1);
    expect(
      (findManyEvents.mock.calls[0]![0] as { where: { runId?: unknown } }).where.runId,
    ).toBeUndefined();
  });
  it("returns a group's latest failed run so a refresh keeps its error", async () => {
    const run = {
      id: "run-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "member exploded",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
      updatedAt: new Date("2026-08-23T00:00:00.000Z"),
      snapshotRev: 0,
    };
    const findManyRuns = groupRunFindMany({ terminals: [run] });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          trigger: { not: "bot_message" },
          status: { in: ["failed", "completed", "cancelled"] },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 50,
      }),
    );
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
          OR: [
            { trigger: { not: "bot_message" } },
            { status: { in: ["waiting_input", "waiting_takeover"] } },
          ],
        },
      }),
    );
    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([]);
    expect(snapshot.recentRuns).toEqual([
      expect.objectContaining({ id: "run-failed", status: "failed" }),
    ]);
  });

  it("omits peer bot_message runs from group activeRuns and displayed terminal run", async () => {
    const peerActive = {
      id: "run-peer-active",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "running",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
      updatedAt: new Date("2026-08-23T00:00:05.000Z"),
      snapshotRev: 0,
    };
    const peerFailed = {
      id: "run-peer-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-peer-fail",
      status: "failed",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: "peer exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
      updatedAt: new Date("2026-08-23T00:00:01.000Z"),
      snapshotRev: 0,
    };
    const findManyRuns = groupRunFindMany({
      active: [peerActive],
      terminals: [peerFailed],
    });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(snapshot.activeRuns).toEqual([]);
    expect(snapshot.run).toBeNull();
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { trigger: { not: "bot_message" } },
            { status: { in: ["waiting_input", "waiting_takeover"] } },
          ],
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        }),
      }),
    );
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: { not: "bot_message" },
          status: { in: ["failed", "completed", "cancelled"] },
        }),
      }),
    );
  });

  it("includes waiting peer bot_message runs in group activeRuns", async () => {
    const peerWaiting = {
      id: "run-peer-waiting",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
      updatedAt: new Date("2026-08-23T00:00:05.000Z"),
      snapshotRev: 0,
    };
    const findManyRuns = groupRunFindMany({ active: [peerWaiting] });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-peer-waiting", status: "waiting_input" }),
    ]);
    // HISTORY-001: the same window comes back as per-Run execution summaries.
    expect(snapshot.executions).toEqual([
      expect.objectContaining({
        runId: "run-peer-waiting",
        entry: "collaboration",
        status: "waiting_input",
        rev: 0,
      }),
    ]);
  });

  it("keeps a waiting peer ask as the primary run even when a newer busy run exists", async () => {
    // Real DB order is createdAt desc, so the newer busy run for bot-b comes
    // first here, ahead of the older waiting peer run for bot-a.
    const newerBusy = {
      id: "run-newer-busy",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-busy",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:10.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:10.000Z"),
      updatedAt: new Date("2026-08-23T00:00:10.000Z"),
      snapshotRev: 0,
    };
    const olderWaiting = {
      id: "run-older-waiting",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
      updatedAt: new Date("2026-08-23T00:00:05.000Z"),
      snapshotRev: 0,
    };
    const findManyRuns = groupRunFindMany({ active: [newerBusy, olderWaiting] });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(snapshot.run).toEqual(expect.objectContaining({ id: "run-older-waiting" }));
    // activeRuns is unaffected by which one is chosen as primary.
    expect(snapshot.activeRuns.map((run) => run.id)).toEqual([
      "run-newer-busy",
      "run-older-waiting",
    ]);
  });

  it("does not revive an older group failure after a newer run completed", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
      updatedAt: new Date("2026-08-23T00:00:00.000Z"),
      snapshotRev: 0,
    };
    const completed = {
      id: "run-newer-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: new Date("2026-08-23T00:00:04.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
      updatedAt: new Date("2026-08-23T00:00:02.000Z"),
      snapshotRev: 0,
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [completed, failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
    expect(snapshot.activeRuns).toEqual([]);
  });

  it("does not revive a failure when a newer cancelled run has null completedAt", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
      updatedAt: new Date("2026-08-23T00:00:00.000Z"),
      snapshotRev: 0,
    };
    const cancelled = {
      id: "run-newer-cancelled",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "cancelled",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:03.000Z"),
      updatedAt: new Date("2026-08-23T00:00:03.000Z"),
      snapshotRev: 0,
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [cancelled, failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
  });

  it("prefers a timestamped terminal over an older failure with null completedAt", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
      updatedAt: new Date("2026-08-23T00:00:00.000Z"),
      snapshotRev: 0,
    };
    const completed = {
      id: "run-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: new Date("2026-08-23T00:00:04.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
      updatedAt: new Date("2026-08-23T00:00:02.000Z"),
      snapshotRev: 0,
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [failed, completed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
  });

  it("clamps a long persisted group failure error on refresh", async () => {
    const longError = "x".repeat(400);
    const run = {
      id: "run-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: longError,
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
      updatedAt: new Date("2026-08-23T00:00:00.000Z"),
      snapshotRev: 0,
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [run] })) },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({
        id: "run-failed",
        status: "failed",
        error: `${"x".repeat(300)}…`,
      }),
    );
  });

  it("keeps a concurrent member failure in run while another member is still active", async () => {
    const active = {
      id: "run-active",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:00.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
      updatedAt: new Date("2026-08-23T00:00:00.000Z"),
      snapshotRev: 0,
    };
    const failed = {
      id: "run-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-b",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "member exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
      updatedAt: new Date("2026-08-23T00:00:01.000Z"),
      snapshotRev: 0,
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ active: [active], terminals: [failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-active", status: "running" }),
    ]);
  });

  it("keeps a failure on refresh when another member starts after it", async () => {
    const lateActive = {
      id: "run-late",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:03.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:03.000Z"),
      updatedAt: new Date("2026-08-23T00:00:03.000Z"),
      snapshotRev: 0,
    };
    const failed = {
      id: "run-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-b",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "member exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
      updatedAt: new Date("2026-08-23T00:00:01.000Z"),
      snapshotRev: 0,
    };
    const snapshot = await threadSnapshot(
      {
        prisma: groupPrisma(groupRunFindMany({ active: [lateActive], terminals: [failed] })),
      },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-late", status: "running" }),
    ]);
  });
});

function isTerminalRunQuery(where: { status?: { in?: string[] } } | undefined) {
  const statuses = where?.status?.in;
  return Array.isArray(statuses) && statuses.includes("failed") && statuses.includes("completed");
}

function matchesPeerActiveFilter(
  row: { id?: string; trigger?: string; status?: string; sourceMessageId?: string | null },
  where:
    | {
        trigger?: { not?: string };
        OR?: Array<{
          trigger?: { not?: string };
          status?: { in?: string[] };
          id?: { in?: string[] };
          sourceMessageId?: { in?: string[] };
        }>;
      }
    | undefined,
) {
  if (where?.trigger?.not === "bot_message") return row.trigger !== "bot_message";
  if (!where?.OR) return true;
  return where.OR.some((clause) => {
    if (clause.trigger?.not === "bot_message") return row.trigger !== "bot_message";
    if (clause.status?.in) return clause.status.in.includes(row.status ?? "");
    // PD-01P message→Runs window: match the explicit run ids and the durable
    // source-message links, exactly like the SQL where clause.
    if (clause.id?.in) return Boolean(row.id && clause.id.in.includes(row.id));
    if (clause.sourceMessageId?.in) {
      return Boolean(
        row.sourceMessageId && clause.sourceMessageId.in.includes(row.sourceMessageId),
      );
    }
    return false;
  });
}

function botRunFindFirst(
  rows: Array<{
    id: string;
    status: string;
    trigger?: string;
    createdAt?: Date;
  }>,
) {
  return vi.fn().mockImplementation(
    async (args: {
      where?: {
        status?: { in?: string[] };
        trigger?: { not?: string };
      };
      select?: { id?: boolean };
    }) => {
      const statuses = args.where?.status?.in;
      const matched = rows
        .filter((row) => !statuses || statuses.includes(row.status))
        .filter((row) =>
          args.where?.trigger?.not === "bot_message" ? row.trigger !== "bot_message" : true,
        )
        .sort((a, b) => {
          const byCreated = (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
          return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
        });
      const row = matched[0] ?? null;
      if (!row) return null;
      return args.select?.id ? { id: row.id } : row;
    },
  );
}

function groupRunFindMany(input: { active?: unknown[]; terminals?: unknown[] }) {
  return vi.fn().mockImplementation(
    async (args: {
      where?: {
        status?: { in?: string[] };
        trigger?: { not?: string };
        OR?: Array<{ trigger?: { not?: string }; status?: { in?: string[] } }>;
      };
    }) => {
      const rows = isTerminalRunQuery(args.where) ? (input.terminals ?? []) : (input.active ?? []);
      return rows.filter((row) =>
        matchesPeerActiveFilter(row as { trigger?: string; status?: string }, args.where),
      );
    },
  );
}

function groupPrisma(findManyRuns: ReturnType<typeof groupRunFindMany>) {
  const tx = {
    backgroundAgentTask: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    runPlan: { findMany: vi.fn().mockResolvedValue([]) },
    runStep: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    runTodo: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    // The ExecutionSummary pass: grouped raw scans resolve empty, model reads empty.
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
    task: { findMany: vi.fn().mockResolvedValue([]) },
    artifact: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    intervention: { findMany: vi.fn().mockResolvedValue([]) },
    message: { findMany: vi.fn().mockResolvedValue([]) },
    event: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    run: { findMany: findManyRuns },
  };
  return {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
}

function groupTarget() {
  return {
    kind: "group",
    groupId: "group-1",
    groupName: "Group",
    spaceId: "space-1",
    members: [],
    threadId: "thread-1",
  } as unknown as ThreadTarget;
}

describe("sendThreadMessage", () => {
  it("answers a waiting question with a free-text chat message", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Paris" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "ask-1",
            blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
          },
        ]),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === "ask-1"
            ? {
                id: "ask-1",
                role: "bot",
                blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
              }
            : {
                id: where.id,
                role: "user",
                blocks: [{ kind: "text", text: "Paris" }],
              },
        ),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "run-waiting", taskId: "task-1", status: "waiting_input", trigger: "user" },
          ]),
        findFirst: vi.fn().mockResolvedValue({
          botId: "bot-1",
          userId: "user-1",
          taskId: "task-1",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      task: {
        create: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({ id: "task-1" }),
        findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "Original task",
          revision: 1,
        })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "Paris",
          clientNonce: "nonce-ask",
        },
      ),
    ).resolves.toMatchObject({
      runId: "run-waiting",
      taskId: "task-1",
      seq: 1,
      runIds: ["run-waiting"],
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", revision: 1 },
      data: { revision: 2 },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "waiting_input" }),
        data: { status: "queued", waitKind: null },
      }),
    );
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.message.created",
        payload: expect.objectContaining({ runIds: ["run-waiting"] }),
      }),
    });
  });

  it("does not guess which waiting run a free-text answer satisfies", async () => {
    const waitingAsk = {
      id: "ask-1",
      blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Paris" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([waitingAsk]),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === "ask-1"
            ? { ...waitingAsk, role: "bot" }
            : { id: where.id, role: "user", blocks: [{ kind: "text", text: "Paris" }] },
        ),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-waiting-1", taskId: "task-1", status: "waiting_input" },
          { id: "run-waiting-2", taskId: "task-2", status: "waiting_input" },
        ]),
        findFirst: vi.fn().mockResolvedValue({
          botId: "bot-1",
          userId: "user-1",
          taskId: "task-1",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      task: {
        create: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({ id: "task-1" }),
        findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "Original task",
          revision: 1,
        })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "Paris",
          clientNonce: "nonce-ask-multi",
        },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Answer the pending ask first.",
    });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("replays every answered waiting run from a free-text send receipt", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          id: "msg-1",
          seq: 4,
          runId: "run-waiting-1",
          sourceRuns: [],
        }),
      },
      event: {
        findFirst: vi.fn(async ({ select }: { select?: { seq?: boolean } }) =>
          select?.seq
            ? { seq: 9 }
            : {
                payload: {
                  messageId: "msg-1",
                  role: "user",
                  runIds: ["run-waiting-1", "run-waiting-2"],
                },
              },
        ),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-waiting-1", taskId: "task-1", status: "queued" },
          { id: "run-waiting-2", taskId: "task-2", status: "queued" },
        ]),
        findUnique: vi.fn().mockResolvedValue({
          id: "run-waiting-1",
          taskId: "task-1",
          status: "queued",
        }),
      },
      $transaction: vi.fn(),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "Paris",
          clientNonce: "nonce-ask-replay",
        },
      ),
    ).resolves.toMatchObject({
      runId: "run-waiting-1",
      taskId: "task-1",
      seq: 4,
      runIds: ["run-waiting-1", "run-waiting-2"],
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.run.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["run-waiting-1", "run-waiting-2"] } },
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-waiting-1" } }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-waiting-2" } }),
    );
  });

  it("does not guess which group waiting run a free-text answer satisfies", async () => {
    const waitingAsk = {
      id: "ask-1",
      blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Paris" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([waitingAsk]),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === "ask-1"
            ? { ...waitingAsk, role: "bot" }
            : { id: where.id, role: "user", blocks: [{ kind: "text", text: "Paris" }] },
        ),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-waiting-1", taskId: "task-1", botId: "bot-a", status: "waiting_input" },
          { id: "run-waiting-2", taskId: "task-2", botId: "bot-a", status: "waiting_input" },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-a", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        create: vi.fn(),
      },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      task: {
        create: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({ id: "task-1" }),
        findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "Original task",
          revision: 1,
        })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          thread: { id: "thread-1" },
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "Paris",
          clientNonce: "nonce-ask-group-multi",
        },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Answer the pending ask first.",
    });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("still requires the card for a pending approval ask", async () => {
    const tx = {
      thread: {
        update: vi.fn().mockResolvedValue({ nextMessageSeq: 2 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "allow" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "ask-1",
            blocks: [
              {
                kind: "ask",
                approvalEffectId: "effect-1",
                text: "Review before writing",
                status: "pending",
                actions: [
                  { id: "allow", label: "Allow once" },
                  { id: "deny", label: "Deny" },
                ],
              },
            ],
          },
        ]),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_input" }]),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn() },
      task: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        {
          text: "allow",
          clientNonce: "nonce-1",
        },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Answer the pending ask first.",
    });
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
  });

  it("waits for the creation intro instead of starting a second run", async () => {
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Check the inbox" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "intro-run", taskId: "intro-task", status: "running", trigger: "created" },
          ]),
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
        updateMany: vi.fn(),
      },
      task: { create: vi.fn(), updateMany: vi.fn() },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "Check the inbox", clientNonce: "nonce-during-intro" },
      ),
    ).resolves.toMatchObject({
      runId: "intro-run",
      taskId: "intro-task",
      runIds: ["intro-run"],
    });
    // Pending steering: the intro never claims it, so only that turn replies.
    // The continuation after it finishes answers with tools.
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-1", userId: "user-1", runId: null },
    });
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: { runId: "intro-run" },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("steers a waiting-takeover run instead of refusing the message", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 2 })
          .mockResolvedValueOnce({ nextEventSeq: 3 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "skip that" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_takeover" }]),
        findUnique: vi.fn().mockResolvedValue({
          status: "waiting_takeover",
          startedAt: new Date(),
        }),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2 }) },
      task: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "skip that",
          clientNonce: "nonce-takeover",
        },
      ),
    ).resolves.toMatchObject({
      runId: "run-waiting",
      taskId: "task-1",
      seq: 1,
      runIds: ["run-waiting"],
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: "msg-1",
        botId: "bot-1",
        userId: "user-1",
        runId: "run-waiting",
      },
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
  });
  it("keeps a message pending instead of steering into an active routine run", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "what are the alternatives?" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { id: "run-routine", taskId: "task-routine", status: "running", trigger: "routine" },
          ])
          .mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi
          .fn()
          .mockResolvedValue({ id: "run-user", taskId: "task-user", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-user" }) },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 2, createdAt: new Date() }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "what are the alternatives?", clientNonce: "nonce-routine" },
      ),
    ).resolves.toMatchObject({
      runId: "run-routine",
      taskId: "task-routine",
      runIds: ["run-routine"],
    });
    // Pending steering (no run): the routine's turn never claims it, and the continuation
    // that starts when the routine finishes answers with the full thread.
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-1", userId: "user-1", runId: null },
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: { runId: "run-routine" },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("keeps a group message pending instead of steering into a member's webhook run", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "status?" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "run-webhook",
              taskId: "task-webhook",
              botId: "bot-a",
              status: "running",
              trigger: "webhook",
            },
          ])
          .mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi
          .fn()
          .mockResolvedValue({ id: "run-a", taskId: "task-a", botId: "bot-a", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-a" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          thread: { id: "thread-1" },
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      { text: "status?", clientNonce: "nonce-group-webhook" },
    );

    expect(result).toMatchObject({ runId: "run-webhook", taskId: "task-webhook" });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-a", userId: "user-1", runId: null },
    });
    expect(tx.run.create).not.toHaveBeenCalled();
  });
  it("answers a routine run waiting for input from the composer", async () => {
    const waitingAsk = {
      id: "ask-1",
      blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Paris" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([waitingAsk]),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === "ask-1"
            ? { ...waitingAsk, role: "bot" }
            : { id: where.id, role: "user", blocks: [{ kind: "text", text: "Paris" }] },
        ),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-routine",
            taskId: "task-routine",
            status: "waiting_input",
            trigger: "routine",
          },
        ]),
        findFirst: vi.fn().mockResolvedValue({
          botId: "bot-1",
          userId: "user-1",
          taskId: "task-routine",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        create: vi.fn(),
      },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      task: {
        create: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({ id: "task-1" }),
        findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "Original task",
          revision: 1,
        })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "Paris", clientNonce: "nonce-routine-waiting" },
      ),
    ).resolves.toMatchObject({
      runId: "run-routine",
      taskId: "task-routine",
      runIds: ["run-routine"],
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: "task-routine", revision: 1 },
      data: { revision: 2 },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-routine", status: "waiting_input" }),
        data: { status: "queued", waitKind: null },
      }),
    );
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-routine" } }),
    );
  });
  it("answers a group webhook run waiting for input from the composer", async () => {
    const waitingAsk = {
      id: "ask-1",
      blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Paris" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([waitingAsk]),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === "ask-1"
            ? { ...waitingAsk, role: "bot" }
            : { id: where.id, role: "user", blocks: [{ kind: "text", text: "Paris" }] },
        ),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-webhook",
            taskId: "task-webhook",
            botId: "bot-a",
            status: "waiting_input",
            trigger: "webhook",
          },
        ]),
        findFirst: vi.fn().mockResolvedValue({
          botId: "bot-a",
          userId: "user-1",
          taskId: "task-webhook",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        create: vi.fn(),
      },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      task: {
        create: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({ id: "task-1" }),
        findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "Original task",
          revision: 1,
        })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          thread: { id: "thread-1" },
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "Paris", clientNonce: "nonce-group-webhook-waiting" },
      ),
    ).resolves.toMatchObject({
      runId: "run-webhook",
      taskId: "task-webhook",
      runIds: ["run-webhook"],
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: "task-webhook", revision: 1 },
      data: { revision: 2 },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-webhook", status: "waiting_input" }),
        data: { status: "queued", waitKind: null },
      }),
    );
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-webhook" } }),
    );
  });
  it("steers a conversational run instead of answering a waiting routine", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "what about the watch?" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "run-routine",
              taskId: "task-routine",
              status: "waiting_input",
              trigger: "routine",
            },
            { id: "run-user", taskId: "task-user", status: "running", trigger: "user" },
          ])
          .mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
        updateMany: vi.fn(),
        create: vi.fn(),
      },
      task: { create: vi.fn(), updateMany: vi.fn() },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 2, createdAt: new Date() }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "what about the watch?", clientNonce: "nonce-routine-and-chat" },
      ),
    ).resolves.toMatchObject({
      runId: "run-user",
      taskId: "task-user",
      runIds: ["run-user"],
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-1", userId: "user-1", runId: "run-user" },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: { runId: "run-user" },
    });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("steers a group conversational run instead of answering a waiting webhook", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "what about the watch?" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "run-webhook",
              taskId: "task-webhook",
              botId: "bot-a",
              status: "waiting_input",
              trigger: "webhook",
            },
            {
              id: "run-user",
              taskId: "task-user",
              botId: "bot-a",
              status: "running",
              trigger: "user",
            },
          ])
          .mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
        updateMany: vi.fn(),
        create: vi.fn(),
      },
      task: { create: vi.fn(), updateMany: vi.fn() },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          thread: { id: "thread-1" },
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "what about the watch?", clientNonce: "nonce-group-webhook-and-chat" },
      ),
    ).resolves.toMatchObject({
      runId: "run-user",
      taskId: "task-user",
      runIds: ["run-user"],
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-a", userId: "user-1", runId: "run-user" },
    });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("rejects a quote excerpt without a reply target", async () => {
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        { text: "hi", replyQuote: "just this span", clientNonce: "nonce-1" },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("persists the quote excerpt alongside the reply target", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          blocks: [{ kind: "text", text: "the parent says just this span inside it" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: "just this span",
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    // Extra client fields cannot override the authenticated actor or the server's origin.
    const spoofedInput = {
      text: "why this?",
      replyToMessageId: "parent",
      replyQuote: "just this span",
      clientNonce: "nonce-1",
      originKind: "bot",
      authorUserId: "attacker",
    };
    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      spoofedInput,
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.findFirst).toHaveBeenCalledWith({
      where: { id: "parent", threadId: "thread-1" },
      select: { id: true, blocks: true, role: true, botId: true },
    });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        replyToMessageId: "parent",
        replyQuote: "just this span",
        originKind: "human_web",
        authorUserId: "user-1",
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({ replyQuote: "just this span" }),
      }),
    });
  });

  it("stamps the call id on the live event so the bubble joins the call card at once", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const clientNonce = callClientNonce("call-7");
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "book the flight" }],
          botId: null,
          runId: null,
          clientNonce,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      { spaceId: "workspace-1", userId: "user-1" } as Actor,
      { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget,
      { text: "book the flight", clientNonce },
    );

    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.message.created",
        payload: expect.objectContaining({ callId: "call-7" }),
      }),
    });
  });

  it("drops a quote excerpt when the parent's persisted blocks are malformed", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          blocks: [null],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: null,
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "words the parent never said",
        clientNonce: "nonce-1",
      },
    );

    // The send still lands as a plain reply — the fabricated excerpt is dropped.
    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        replyToMessageId: "parent",
        replyQuote: undefined,
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.not.objectContaining({ replyQuote: expect.anything() }),
      }),
    });
  });

  it("sends a plain reply when the reply target no longer exists", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        // The parent was deleted (or paged out) between arming and send.
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: null,
          replyQuote: null,
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "deleted-parent",
        replyQuote: "the span that was quoted",
        clientNonce: "nonce-1",
      },
    );

    // The send lands as a plain reply — no dangling target or quote is kept.
    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        replyToMessageId: undefined,
        replyQuote: undefined,
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.not.objectContaining({ replyToMessageId: expect.anything() }),
      }),
    });
  });

  it("accepts a quote excerpt that matches formatted parent text", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          // Rendered as "42% growth", stored with markdown source.
          blocks: [{ kind: "text", text: "we saw **42%** growth last week" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: "42% growth",
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "42% growth",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ replyQuote: "42% growth" }),
    });
  });

  it.each([
    ["table cells", "| Name | Value |\n|:-----|------:|\n| Alice | 5 |", "Alice 5", "Alice 5"],
    ["indented code", "    2. restart()", "2. restart()", "2. restart()"],
    ["fenced code", "```text\n2. restart()\n```", "2. restart()", "2. restart()"],
    [
      "lists after code fences",
      "```text\n1. code\n```\n1. First\n2. Second",
      "First\nSecond",
      "First\nSecond",
    ],
    ["tab-indented code", "\t2. restart()", "2. restart()", "2. restart()"],
    ["three-space lists", "   1. First\n   2. Second", "First\nSecond", "First\nSecond"],
    [
      "ordered list items",
      "1. Review the diff\n2. Run the tests",
      "Review the diff Run the tests",
      "Review the diff\nRun the tests",
    ],
    [
      "parenthesized list items",
      "1) Review the diff\n2) Run the tests",
      "Review the diff\nRun the tests",
      "Review the diff\nRun the tests",
    ],
    [
      "quoted list items",
      "> 1. Review the diff\n> 2. Run the tests",
      "Review the diff\nRun the tests",
      "Review the diff\nRun the tests",
    ],
  ])(
    "derives a quote excerpt spanning rendered %s",
    async (_name, parentText, requestedQuote, expectedQuote) => {
      let messageSeq = 0;
      let eventSeq = 0;
      const tx = {
        thread: {
          update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
            data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
          ),
        },
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "parent",
            role: "bot",
            blocks: [
              {
                kind: "text",
                text: parentText,
              },
            ],
          }),
          update: vi.fn(),
          create: vi.fn().mockResolvedValue({
            id: "msg-1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text: "why this?" }],
            botId: null,
            replyToMessageId: "parent",
            replyQuote: expectedQuote,
            runId: null,
            createdAt: new Date(),
          }),
        },
        run: {
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
          create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
        },
        task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
        event: {
          create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
        },
        steeringMessage: { create: vi.fn() },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
      const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

      const result = await sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        {
          text: "why this?",
          replyToMessageId: "parent",
          replyQuote: requestedQuote,
          clientNonce: "nonce-1",
        },
      );

      expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
      expect(tx.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ replyQuote: expectedQuote }),
      });
      expect(tx.event.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({ replyQuote: expectedQuote }),
        }),
      });
    },
  );

  it("drops a quote excerpt that only matches after stripping punctuation", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          blocks: [
            {
              kind: "text",
              text: "C++ is fast and key:value pairs; version 1.2 and 2. items\n    2. restart()\n```text\n1. alpha\n2. beta\n```\n~~~text\n1. gamma\n2. delta\n~~~\n```text\n> ```\n1. epsilon\n2. zeta\n```\n> ```text\n> > ```\n> 1. eta\n> 2. theta\n> ```\n```text\nalpha\n---\nomega\n```\nRead [docs](https://example.test/private)\nAlice\n# 1. heading\n# 2. another heading\n\n    > 1. literal\n    > 2. another literal",
            },
          ],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: null,
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    for (const replyQuote of [
      "C is fast",
      "key value pairs",
      "version 12",
      "and items",
      "3. restart()",
      "    3. restart()",
      "99. C++ is fast",
      "alpha\nbeta",
      "gamma\ndelta",
      "epsilon\nzeta",
      "eta\ntheta",
      "alpha\nomega",
      "text",
      "https://example.test/private",
      "alice",
      "heading\nanother heading",
      "literal\nanother literal",
    ]) {
      await sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        { text: "why this?", replyToMessageId: "parent", replyQuote },
      );
    }

    for (const call of tx.message.create.mock.calls) {
      expect(call[0].data.replyQuote).toBeUndefined();
    }
  });

  it("still sends a plain reply when quote derivation throws", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          blocks: [{ kind: "text", text: "the parent says just this span inside it" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: null,
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "explode derivation",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ replyToMessageId: "parent" }),
    });
    expect(tx.message.create.mock.calls[0][0].data.replyQuote).toBeUndefined();
  });

  it("persists the quote excerpt on a group send", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          blocks: [{ kind: "text", text: "the parent says just this span inside it" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: "just this span",
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi
          .fn()
          .mockResolvedValue({ id: "run-1", taskId: "task-1", botId: "bot-a", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          thread: { id: "thread-1" },
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "just this span",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        replyToMessageId: "parent",
        replyQuote: "just this span",
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({ replyQuote: "just this span" }),
      }),
    });
  });
});

describe("stopThreadRuns", () => {
  it("snapshots every lease when group members share a team computer", async () => {
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    });
    let nextEventSeq = 0;
    const transaction = {
      $queryRaw: vi.fn(),
      thread: {
        update: vi.fn(async () => ({ nextEventSeq: ++nextEventSeq })),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-a", taskId: "task-a" },
          { id: "run-b", taskId: "task-b" },
        ]),
        updateManyAndReturn: vi.fn().mockResolvedValue([
          { id: "run-a", botId: "bot-a" },
          { id: "run-b", botId: "bot-b" },
        ]),
        findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: {
        // Production team ownership is lease-only: Computer.executionRunId stays null.
        findMany: vi.fn().mockImplementation(async ({ where }: { where: { OR?: unknown[] } }) => {
          expect(where.OR).toEqual(
            expect.arrayContaining([
              { id: { in: ["computer-db-team"] } },
              { executionRunId: { in: ["run-a", "run-b"] } },
            ]),
          );
          return [
            {
              id: "computer-db-team",
              homeKey: "home-team",
              kind: "fake",
              providerRef: "computer-team",
              executionBotId: null,
              executionRunId: null,
            },
          ];
        }),
      },
      computerExecutionLease: {
        findMany: vi.fn().mockResolvedValue([
          { computerId: "computer-db-team", botId: "bot-a", runId: "run-a", fence: 2 },
          { computerId: "computer-db-team", botId: "bot-b", runId: "run-b", fence: 4 },
        ]),
      },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      // Simulate workers clearing leases / execution columns as soon as the
      // transaction commits. A post-commit lookup would now miss both sandboxes.
      computer: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computerExecutionLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      run: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    await stopThreadRuns(
      {
        prisma,
        sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
    );

    expect(transaction.computerExecutionLease.findMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-a", "run-b"] } },
      select: { computerId: true, botId: true, runId: true, fence: true },
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-team", "run-a"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-a", botId: "bot-a" }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-team", "run-b"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-b", botId: "bot-b" }),
    );
    expect(releaseScreen).toHaveBeenCalledTimes(2);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-a",
        cancelRunWork: true,
        runId: "run-a",
        screenLeaseId: "run-a:2",
      }),
    );
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-b",
        cancelRunWork: true,
        runId: "run-b",
        screenLeaseId: "run-b:4",
      }),
    );
    expect(prisma.computer.findMany).not.toHaveBeenCalled();
    expect(prisma.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-a", "run-b"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(prisma.computer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { executionRunId: { in: ["run-a", "run-b"] } } }),
    );
  });

  it("does not tear down a stale legacy execution run when the lease owns a cancelled run", async () => {
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    });
    const transaction = {
      $queryRaw: vi.fn(),
      thread: {
        update: vi.fn().mockResolvedValue({ nextEventSeq: 5 }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-a", taskId: "task-a" }]),
        updateManyAndReturn: vi.fn().mockResolvedValue([{ id: "run-a", botId: "bot-a" }]),
        findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: {
        // Selected via lease for cancelled run A, but legacy columns still name
        // unrelated live run B. Legacy teardown must not cancel/release B.
        findMany: vi.fn().mockResolvedValue([
          {
            id: "computer-db-a",
            homeKey: "home-a",
            kind: "fake",
            providerRef: "computer-a",
            executionBotId: "bot-b",
            executionRunId: "run-b",
          },
        ]),
      },
      computerExecutionLease: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computerId: "computer-db-a", botId: "bot-a", runId: "run-a", fence: 2 },
          ]),
      },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      run: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      computer: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computerExecutionLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    await stopThreadRuns(
      {
        prisma,
        sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-a" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-a", "run-a"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-a", botId: "bot-a" }),
    );
    expect(execute).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-a", "run-b"]),
      }),
      expect.anything(),
    );
    expect(releaseScreen).toHaveBeenCalledTimes(1);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-a" }),
      expect.objectContaining({
        botId: "bot-a",
        runId: "run-a",
        screenLeaseId: "run-a:2",
      }),
    );
    expect(releaseScreen).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: "run-b" }),
    );
  });

  it("writes a run.cancelled event per cancelled run ahead of the progress purge", async () => {
    // Two earlier progress events already hold seqs 0 and 1; a client may have
    // applied cursor 1 before Stop deletes those rows.
    let nextEventSeq = 2;
    const writes: string[] = [];
    const created: Array<Record<string, unknown>> = [];
    const transaction = {
      $queryRaw: vi.fn(),
      thread: {
        update: vi.fn(async () => ({ nextEventSeq: ++nextEventSeq })),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-a", taskId: "task-a" },
          { id: "run-b", taskId: "task-b" },
        ]),
        updateManyAndReturn: vi.fn().mockResolvedValue([
          { id: "run-a", botId: "bot-a" },
          { id: "run-b", botId: "bot-b" },
        ]),
        // appendEventInTransaction re-reads the run after the flip.
        findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: { findMany: vi.fn().mockResolvedValue([]) },
      computerExecutionLease: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          writes.push("event.create");
          created.push(data);
          return data;
        }),
        deleteMany: vi.fn(async () => {
          writes.push("event.deleteMany");
          return { count: 4 };
        }),
      },
    };
    const prisma = {
      run: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      // No event delegate: a post-commit progress delete would throw here.
    } as unknown as PrismaClient;
    const notify = vi.fn().mockResolvedValue(undefined);
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    await stopThreadRuns(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        events: { notify } as never,
      },
      actor,
      target,
    );

    expect(created).toEqual([
      expect.objectContaining({
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-a",
        type: "run.cancelled",
        runId: "run-a",
        payload: {
          reason: "user_stopped",
          reportDelegationOutcome: false,
          steering: "delete",
        },
        seq: 2,
      }),
      expect.objectContaining({
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-b",
        type: "run.cancelled",
        runId: "run-b",
        payload: {
          reason: "user_stopped",
          reportDelegationOutcome: false,
          steering: "delete",
        },
        seq: 3,
      }),
    ]);
    // The terminal seqs sit above every deleted progress seq, so max(seq) never
    // rewinds below an applied cursor — the freeze regression.
    expect(Math.max(...created.map((data) => data.seq as number))).toBeGreaterThan(1);
    expect(writes.lastIndexOf("event.create")).toBeLessThan(writes.indexOf("event.deleteMany"));
    expect(transaction.event.deleteMany).toHaveBeenCalledWith({
      where: { type: "thread.progress", runId: { in: ["run-a", "run-b"] } },
    });
    expect(notify).toHaveBeenCalledWith("thread-1", 3);
  });

  it("emits no event and skips the wake when nothing was running", async () => {
    const transaction = {
      $queryRaw: vi.fn(),
      thread: { update: vi.fn() },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        updateManyAndReturn: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: { findMany: vi.fn() },
      computerExecutionLease: { findMany: vi.fn() },
      event: { create: vi.fn(), deleteMany: vi.fn() },
    };
    const prisma = {
      run: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient;
    const notify = vi.fn().mockResolvedValue(undefined);
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await stopThreadRuns(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        events: { notify } as never,
      },
      actor,
      target,
    );

    expect(transaction.event.create).not.toHaveBeenCalled();
    expect(transaction.event.deleteMany).not.toHaveBeenCalled();
    expect(transaction.thread.update).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("cancels outstanding delegated work through completed intermediates", async () => {
    // RT-05: A delegated to B (completed), B delegated to C (running in a
    // deeper pair Thread). The visible Thread's Stop must traverse B and
    // reach C through the persisted origin chain.
    const stopTransaction = {
      $queryRaw: vi.fn(),
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        updateManyAndReturn: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      backgroundAgentTask: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: { findMany: vi.fn().mockResolvedValue([]) },
      computerExecutionLease: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const delegatedTransaction = {
      $queryRaw: vi.fn(),
      thread: { update: vi.fn(async () => ({ nextEventSeq: 7 })) },
      run: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            id: "run-c",
            taskId: "task-c",
            status: "running",
            threadId: "pair-thread-2",
            spaceId: "workspace-1",
            botId: "bot-c",
          })
          // appendEventInTransaction's cancelled-run assertion re-reads the row.
          .mockResolvedValue({ id: "run-c", status: "cancelled" }),
        updateManyAndReturn: vi.fn().mockResolvedValue([
          { id: "run-c", botId: "bot-c", threadId: "pair-thread-2", spaceId: "workspace-1", taskId: "task-c" },
        ]),
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn(async () => []),
      },
      steeringMessage: { findMany: vi.fn().mockResolvedValue([]) },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      computerExecutionLease: {
        findFirst: vi.fn().mockResolvedValue({
          computerId: "computer-pair",
          botId: "bot-c",
          runId: "run-c",
          fence: 3,
        }),
      },
      computer: {
        findUnique: vi.fn().mockResolvedValue({
          id: "computer-pair",
          homeKey: "home-pair",
          kind: "fake",
          providerRef: "computer-pair-ref",
          executionBotId: null,
          executionRunId: null,
        }),
      },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          seq: 7,
        })),
      },
    };
    let transactionIndex = 0;
    const prisma = {
      $transaction: vi.fn(async (callback: (client: unknown) => unknown) =>
        callback(transactionIndex++ === 0 ? stopTransaction : delegatedTransaction),
      ),
      computer: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      run: {
        // First generation from the visible Thread: B, already completed. The
        // walk then finds C — still running one pair deeper.
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { id: "run-b", threadId: "pair-thread-1", status: "completed" },
          ])
          .mockResolvedValueOnce([{ id: "run-c", threadId: "pair-thread-2", status: "running" }])
          .mockResolvedValue([]),
      },
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-a",
      threadId: "thread-visible-1",
      memberBotIds: ["bot-a"],
    } satisfies ThreadTarget;

    const execute = vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    });
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const result = await stopThreadRuns(
      {
        prisma,
        sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
    );

    expect(prisma.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          originThreadId: "thread-visible-1",
          spaceId: "workspace-1",
          userId: "user-1",
          threadId: { not: "thread-visible-1" },
        }),
      }),
    );
    expect(result.cancelledRunIds).toEqual(["run-c"]);
    expect(delegatedTransaction.run.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ error: "parent_cancelled", cancelReason: "parent_cancelled" }),
      }),
    );
    // Sandbox work on the delegated run's computer was torn down (cancel +
    // screen release) before the lease expired.
    expect(execute).toHaveBeenCalled();
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cancelRunWork: true, runId: "run-c" }),
    );
    expect(prisma.computerExecutionLease.updateMany).toHaveBeenCalled();
    expect(delegatedTransaction.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "run.cancelled",
          runId: "run-c",
          threadId: "pair-thread-2",
          payload: expect.objectContaining({
            reason: "parent_cancelled",
            reportDelegationOutcome: true,
            steering: "retain_unhandled",
          }),
        }),
      }),
    );
  });
});

describe("sendThreadMessage group turn ownership (Product Harness Phase 1)", () => {
  type MemberSeed = { id: string; name: string };

  function groupSendHarness(options: {
    members: MemberSeed[];
    leadBotId?: string | null;
    activeRuns?: Array<{
      id: string;
      taskId: string;
      botId: string;
      status: string;
      trigger: string;
    }>;
    reply?: { id: string; role: string; botId: string | null };
    preRoute?: ReturnType<typeof vi.fn>;
    transactionFailsOnce?: boolean;
  }) {
    const createdRuns: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 4 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "x" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findFirst: vi.fn().mockResolvedValue(options.reply ?? null),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({ id: "msg-1" }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue(options.activeRuns ?? []),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          createdRuns.push(data);
          return {
            id: `run-${String(data.botId)}`,
            taskId: String(data.taskId),
            botId: String(data.botId),
            status: "queued",
          };
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      task: {
        create: vi.fn().mockResolvedValue({ id: "task-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      steeringMessage: { create: vi.fn() },
      artifact: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({
            id,
            name: "file.txt",
            mimeType: "text/plain",
            size: 12,
            storageKey: `storage-${id}`,
          })),
        ),
      },
      event: {
        create: vi.fn().mockResolvedValue({
          id: "event-1",
          seq: 4,
          threadId: "thread-1",
          createdAt: new Date(),
        }),
      },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          thread: { id: "thread-1" },
          leadBotId: options.leadBotId === undefined ? null : options.leadBotId,
          members: options.members.map((member) => ({
            bot: { id: member.id, name: member.name, color: null },
          })),
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    let first = true;
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => {
        if (options.transactionFailsOnce && first) {
          first = false;
          throw { code: "P2034" };
        }
        return callback(tx);
      }),
    } as unknown as PrismaClient;
    const turnRouting = options.preRoute ? ({ preRoute: options.preRoute } as never) : undefined;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      leadBotId: options.leadBotId ?? null,
      members: [],
      memberBotIds: options.members.map((member) => member.id),
    } as unknown as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);
    return { tx, prisma, actor, target, turnRouting, createdRuns, enqueue };
  }

  async function sendGroup(
    harness: ReturnType<typeof groupSendHarness>,
    input: {
      text?: string;
      artifactIds?: string[];
      mentions?: Array<string | { kind: "bot" | "group" | "routine" | "connector"; id: string }>;
      mentionSpans?: Array<{ botId: string; start: number; end: number }>;
      replyToMessageId?: string;
      clientNonce: string;
    },
  ) {
    return sendThreadMessage(
      {
        prisma: harness.prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: harness.enqueue } as never,
        ...(harness.turnRouting ? { turnRouting: harness.turnRouting } : {}),
      },
      harness.actor,
      harness.target,
      input,
    );
  }

  function routedEventCalls(tx: { event: { create: ReturnType<typeof vi.fn> } }) {
    return tx.event.create.mock.calls
      .map(([arg]) => arg as { data: { type: string; payload: Record<string, unknown> } })
      .filter((arg) => arg.data.type === "thread.turn.routed")
      .map((arg) => arg.data.payload);
  }

  function spanAt(
    text: string,
    token: string,
    botId: string,
    from = 0,
  ): { botId: string; start: number; end: number } {
    const start = text.indexOf(token, from);
    if (start < 0) throw new Error(`missing ${token} after ${from}`);
    return { botId, start, end: start + token.length };
  }

  function taskPrompts(harness: ReturnType<typeof groupSendHarness>) {
    return harness.tx.task.create.mock.calls.map(
      ([arg]) => (arg as { data: { prompt: string } }).data.prompt,
    );
  }

  it("gives an explicitly mentioned turn to that bot alone, without routing", async () => {
    const preRoute = vi.fn().mockResolvedValue(null);
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
      preRoute,
    });

    const result = await sendGroup(harness, {
      text: "@Beta review this",
      clientNonce: "n-mention",
    });

    expect(result).toMatchObject({ runId: "run-bot-b" });
    expect(harness.createdRuns).toHaveLength(1);
    expect(harness.createdRuns[0]).toMatchObject({
      botId: "bot-b",
      orchestration: {
        version: "v1",
        routing: { kind: "explicit_mention" },
        ownership: { mode: "owner", ownerBotId: "bot-b" },
        responseMode: "single",
      },
    });
    expect(routedEventCalls(harness.tx)).toEqual([
      {
        messageId: "msg-1",
        ownerBotId: "bot-b",
        routeKind: "explicit_mention",
        responseMode: "single",
      },
    ]);
    // Provider pre-routing returns null for explicit turns, so no router runs.
    expect(preRoute).toHaveBeenCalledTimes(1);
  });

  it("gives a replied turn to the replied bot", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
      reply: { id: "parent", role: "bot", botId: "bot-b" },
    });

    const result = await sendGroup(harness, {
      text: "and the second quarter?",
      replyToMessageId: "parent",
      clientNonce: "n-reply",
    });

    expect(result).toMatchObject({ runId: "run-bot-b" });
    expect(harness.createdRuns[0]).toMatchObject({
      botId: "bot-b",
      orchestration: expect.objectContaining({
        routing: { kind: "reply_target" },
        responseMode: "single",
      }),
    });
  });

  it("routes an unaddressed group turn to the router-selected specialist only", async () => {
    const preRoute = vi.fn().mockResolvedValue({
      routeKind: "group_router",
      ownerBotIds: ["bot-b"],
      responseMode: "single",
      reasonCode: "specialist_match",
    });
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
      preRoute,
    });

    const result = await sendGroup(harness, {
      text: "看看这套架构合理吗",
      clientNonce: "n-router",
    });

    expect(result).toMatchObject({ runId: "run-bot-b" });
    expect(harness.createdRuns).toHaveLength(1);
    expect(harness.createdRuns[0]).toMatchObject({
      botId: "bot-b",
      orchestration: {
        version: "v1",
        routing: { kind: "group_router", reasonCode: "specialist_match" },
        ownership: { mode: "owner", ownerBotId: "bot-b" },
        responseMode: "single",
      },
    });
    expect(routedEventCalls(harness.tx)).toEqual([
      {
        messageId: "msg-1",
        ownerBotId: "bot-b",
        routeKind: "group_router",
        responseMode: "single",
        reasonCode: "specialist_match",
      },
    ]);
  });

  it("falls back to the lead when routing failed, and the send still succeeds", async () => {
    const preRoute = vi.fn().mockResolvedValue({
      routeKind: "fallback_lead",
      ownerBotIds: ["bot-a"],
      responseMode: "single",
      reasonCode: "fallback_lead",
    });
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
      preRoute,
    });

    const result = await sendGroup(harness, { text: "help with the plan", clientNonce: "n-lead" });

    expect(result).toMatchObject({ runId: "run-bot-a" });
    expect(harness.createdRuns[0]).toMatchObject({
      botId: "bot-a",
      orchestration: expect.objectContaining({
        routing: expect.objectContaining({ kind: "fallback_lead" }),
      }),
    });
  });

  it("drops a router owner that left the group before commit and repairs the stored lead", async () => {
    const preRoute = vi.fn().mockResolvedValue({
      routeKind: "group_router",
      ownerBotIds: ["bot-b"],
      responseMode: "single",
      reasonCode: "specialist_match",
    });
    // bot-b was removed concurrently: locked membership only holds bot-a + bot-c.
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-c", name: "Gamma" },
      ],
      leadBotId: "bot-b",
      preRoute,
    });

    const result = await sendGroup(harness, {
      text: "any thoughts?",
      clientNonce: "n-stale-owner",
    });

    expect(result).toMatchObject({ runId: "run-bot-a" });
    expect(harness.tx.chatGroup.update).toHaveBeenCalledWith({
      where: { id: "group-1" },
      data: { leadBotId: "bot-a" },
    });
  });

  it("keeps @everyone as all-member multi wake with per-run multi snapshots", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
    });

    const result = await sendGroup(harness, {
      text: "@everyone 分别说说",
      clientNonce: "n-everyone",
    });

    expect(result.runIds.sort()).toEqual(["run-bot-a", "run-bot-b"]);
    expect(harness.createdRuns).toHaveLength(2);
    for (const run of harness.createdRuns) {
      expect(run.orchestration).toMatchObject({
        responseMode: "multi",
        routing: { kind: "explicit_multi" },
      });
    }
    expect(routedEventCalls(harness.tx)).toEqual([
      {
        messageId: "msg-1",
        ownerBotId: "bot-a",
        ownerBotIds: ["bot-a", "bot-b"],
        routeKind: "explicit_multi",
        responseMode: "multi",
      },
    ]);
  });

  it("repairs a missing lead deterministically to the first active member", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: null,
    });

    const result = await sendGroup(harness, { text: "hello team", clientNonce: "n-nolead" });

    expect(result).toMatchObject({ runId: "run-bot-a" });
    expect(harness.tx.chatGroup.update).toHaveBeenCalledWith({
      where: { id: "group-1" },
      data: { leadBotId: "bot-a" },
    });
  });

  it("reuses the same routing decision across a serialized transaction retry", async () => {
    const preRoute = vi.fn().mockResolvedValue({
      routeKind: "group_router",
      ownerBotIds: ["bot-b"],
      responseMode: "single",
      reasonCode: "specialist_match",
    });
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
      preRoute,
      transactionFailsOnce: true,
    });

    const result = await sendGroup(harness, {
      text: "review the API design",
      clientNonce: "n-retry",
    });

    expect(preRoute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ runId: "run-bot-b" });
    expect(harness.createdRuns).toHaveLength(1);
  });

  it("stamps a single-bot thread's run with the direct ownership snapshot", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 4 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "hi" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({ id: "msg-1" }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi
          .fn()
          .mockResolvedValue({ id: "run-1", taskId: "task-1", botId: "bot-1", status: "queued" }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      task: {
        create: vi.fn().mockResolvedValue({ id: "task-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({
          id: "event-1",
          seq: 4,
          threadId: "thread-1",
          createdAt: new Date(),
        }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      { spaceId: "workspace-1", userId: "user-1" } as Actor,
      {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget,
      { text: "hi", clientNonce: "n-direct" },
    );

    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        botId: "bot-1",
        orchestration: expect.objectContaining({
          version: "v1",
          routing: { kind: "direct" },
          ownership: { mode: "owner", ownerBotId: "bot-1" },
          responseMode: "single",
          execution: expect.objectContaining({
            version: "v2",
            interactive: true,
            planning: "auto",
            delegation: { mode: "auto", background: true, maxChildren: 3, maxDepth: 1 },
          }),
          collaboration: {
            role: "owner",
            source: "user",
            fromBotId: null,
            parentRunId: null,
            handoffDepth: 0,
            messageHop: 0,
          },
        }),
      }),
    });
    // Single-bot threads never emit routing events: the owner is the thread itself.
    expect(
      tx.event.create.mock.calls.every(([arg]) => arg.data.type !== "thread.turn.routed"),
    ).toBe(true);
  });

  it("persists typed Bot mention identity on the user text block", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
    });

    await sendGroup(harness, {
      text: "@Beta review this",
      mentions: [{ kind: "bot", id: "bot-b" }],
      mentionSpans: [{ botId: "bot-b", start: 0, end: 5 }],
      clientNonce: "n-mention-inline",
    });

    expect(harness.tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        blocks: [
          {
            kind: "text",
            text: "@Beta review this",
            inlines: [
              { kind: "bot_mention", botId: "bot-b", label: "Beta" },
              { kind: "text", text: " review this" },
            ],
          },
        ],
      }),
    });
  });

  it("keeps a non-member mention as plain text instead of a link", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
    });
    const text = "我之前和 @Gamma 聊过，@Beta 请审查";
    const first = spanAt(text, "@Gamma", "bot-c");
    const second = spanAt(text, "@Beta", "bot-b", first.end);

    const result = await sendGroup(harness, {
      text,
      mentions: [
        { kind: "bot", id: "bot-c" },
        { kind: "bot", id: "bot-b" },
      ],
      mentionSpans: [first, second],
      clientNonce: "n-mention-nonmember",
    });

    expect(result.runIds).toEqual(["run-bot-b"]);
    expect(harness.createdRuns.map((run) => run.botId)).toEqual(["bot-b"]);
    expect(harness.tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        blocks: [
          {
            kind: "text",
            text,
            inlines: [
              { kind: "text", text: "我之前和 @Gamma 聊过，" },
              { kind: "bot_mention", botId: "bot-b", label: "Beta" },
              { kind: "text", text: " 请审查" },
            ],
          },
        ],
      }),
    });
  });

  it("keeps legacy sends text-only when no mention ranges are supplied", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
    });

    await sendGroup(harness, {
      text: "@Beta review this",
      mentions: [{ kind: "bot", id: "bot-b" }],
      clientNonce: "n-mention-legacy",
    });

    const createCall = harness.tx.message.create.mock.calls[0]?.[0] as {
      data: { blocks: unknown[] };
    };
    expect(createCall.data.blocks).toEqual([{ kind: "text", text: "@Beta review this" }]);
  });

  it("keeps steering an active single target on the typed-span path", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
      activeRuns: [
        {
          id: "run-active",
          taskId: "task-active",
          botId: "bot-b",
          status: "running",
          trigger: "user",
        },
      ],
    });
    const text = "@Beta review this";

    const result = await sendGroup(harness, {
      text,
      mentions: [{ kind: "bot", id: "bot-b" }],
      mentionSpans: [spanAt(text, "@Beta", "bot-b")],
      clientNonce: "n-span-single-active",
    });

    expect(result.runIds).toEqual(["run-active"]);
    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.steeringMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ botId: "bot-b", runId: "run-active" }),
    });
  });

  it("creates one Run for a typed-span single owner", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
    });
    const text = "@Beta review this";

    const result = await sendGroup(harness, {
      text,
      mentions: [{ kind: "bot", id: "bot-b" }],
      mentionSpans: [spanAt(text, "@Beta", "bot-b")],
      clientNonce: "n-span-single",
    });

    expect(result.runIds).toEqual(["run-bot-b"]);
    expect(harness.createdRuns).toHaveLength(1);
    expect(harness.createdRuns[0]).toMatchObject({
      botId: "bot-b",
      orchestration: {
        routing: { kind: "explicit_mention" },
        ownership: { mode: "owner", ownerBotId: "bot-b" },
        responseMode: "single",
      },
    });
    expect(taskPrompts(harness)).toEqual([text]);
  });

  it("creates one independent Run per shared multi target", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
    });
    const text = "@Alpha 和 @Beta 一起审查 X";
    const first = spanAt(text, "@Alpha", "bot-a");
    const second = spanAt(text, "@Beta", "bot-b", first.end);

    const result = await sendGroup(harness, {
      text,
      mentions: [
        { kind: "bot", id: "bot-a" },
        { kind: "bot", id: "bot-b" },
      ],
      mentionSpans: [first, second],
      clientNonce: "n-span-shared",
    });

    expect(result.runIds.sort()).toEqual(["run-bot-a", "run-bot-b"]);
    expect(harness.createdRuns).toHaveLength(2);
    for (const run of harness.createdRuns) {
      expect(run).toMatchObject({
        orchestration: {
          routing: { kind: "explicit_multi" },
          responseMode: "multi",
        },
      });
    }
    expect(taskPrompts(harness)).toEqual(["一起审查 X", "一起审查 X"]);
    expect(routedEventCalls(harness.tx)).toEqual([
      {
        messageId: "msg-1",
        ownerBotId: "bot-a",
        ownerBotIds: ["bot-a", "bot-b"],
        routeKind: "explicit_multi",
        responseMode: "multi",
      },
    ]);
  });

  it("keeps @everyone broadcast semantics when typed spans are present", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
    });
    const text = "@everyone @Beta review";

    const result = await sendGroup(harness, {
      text,
      mentions: [{ kind: "bot", id: "bot-b" }],
      mentionSpans: [spanAt(text, "@Beta", "bot-b")],
      clientNonce: "n-span-everyone",
    });

    expect(result.runIds.sort()).toEqual(["run-bot-a", "run-bot-b"]);
    expect(harness.createdRuns).toHaveLength(2);
    for (const run of harness.createdRuns) {
      expect(run).toMatchObject({
        orchestration: {
          routing: { kind: "explicit_multi" },
          responseMode: "multi",
        },
      });
    }
    expect(taskPrompts(harness)).toEqual([text, text]);
  });

  it("creates one independent Run per segmented target with its own prompt", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
    });
    const text = "@Alpha 做 X，@Beta 做 Y";
    const first = spanAt(text, "@Alpha", "bot-a");
    const second = spanAt(text, "@Beta", "bot-b", first.end);

    const result = await sendGroup(harness, {
      text,
      mentions: [
        { kind: "bot", id: "bot-a" },
        { kind: "bot", id: "bot-b" },
      ],
      mentionSpans: [first, second],
      clientNonce: "n-span-segmented",
    });

    expect(result.runIds.sort()).toEqual(["run-bot-a", "run-bot-b"]);
    expect(harness.createdRuns.map((run) => run.botId)).toEqual(["bot-a", "bot-b"]);
    expect(taskPrompts(harness)).toEqual(["做 X", "做 Y"]);
    expect(taskPrompts(harness)[0]).not.toContain("做 Y");
    expect(taskPrompts(harness)[1]).not.toContain("做 X");
    expect(harness.tx.run.create).toHaveBeenCalledTimes(2);
    // Display dedup/links stay separate from execution segmentation: the one
    // persisted user message still links both typed mentions.
    const createCall = harness.tx.message.create.mock.calls[0]?.[0] as {
      data: { blocks: Array<{ inlines?: Array<{ kind: string; botId?: string }> }> };
    };
    expect(
      createCall.data.blocks[0]?.inlines
        ?.filter((inline) => inline.kind === "bot_mention")
        .map((inline) => inline.botId),
    ).toEqual(["bot-a", "bot-b"]);
  });

  it("lets an explicit typed task override the reply target", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
      reply: { id: "parent", role: "bot", botId: "bot-a" },
    });
    const text = "@Beta 做 X";

    const result = await sendGroup(harness, {
      text,
      mentions: [{ kind: "bot", id: "bot-b" }],
      mentionSpans: [spanAt(text, "@Beta", "bot-b")],
      replyToMessageId: "parent",
      clientNonce: "n-span-reply",
    });

    expect(result.runIds).toEqual(["run-bot-b"]);
    expect(harness.createdRuns.map((run) => run.botId)).toEqual(["bot-b"]);
  });

  it("does not create a mention-triggered Run for an ordinary reference", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
      reply: { id: "parent", role: "bot", botId: "bot-b" },
    });
    const text = "我刚才和 @Alpha 讨论过";

    const result = await sendGroup(harness, {
      text,
      mentions: [{ kind: "bot", id: "bot-a" }],
      mentionSpans: [spanAt(text, "@Alpha", "bot-a")],
      replyToMessageId: "parent",
      clientNonce: "n-span-ordinary",
    });

    expect(result.runIds).toEqual(["run-bot-b"]);
    expect(harness.createdRuns).toHaveLength(1);
    expect(harness.createdRuns[0]).toMatchObject({
      botId: "bot-b",
      orchestration: { routing: { kind: "reply_target" } },
    });
    expect(harness.createdRuns.some((run) => run.botId === "bot-a")).toBe(false);
  });

  it("rejects ambiguous interleaved instructions with zero Task/Run", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
    });
    const text = "@Alpha 做 X @Beta 做 Y";
    const first = spanAt(text, "@Alpha", "bot-a");
    const second = spanAt(text, "@Beta", "bot-b", first.end);

    await expect(
      sendGroup(harness, {
        text,
        mentions: [
          { kind: "bot", id: "bot-a" },
          { kind: "bot", id: "bot-b" },
        ],
        mentionSpans: [first, second],
        clientNonce: "n-span-ambiguous",
      }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
      data: {
        code: "GROUP_MENTION_CLARIFICATION_REQUIRED",
        reasonCode: "ambiguous_attribution",
      },
    });

    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.tx.message.create).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized target without partially dispatching the rest", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
    });
    const text = "@Gamma 做 X，@Beta 做 Y";
    const first = spanAt(text, "@Gamma", "bot-c");
    const second = spanAt(text, "@Beta", "bot-b", first.end);

    await expect(
      sendGroup(harness, {
        text,
        mentions: [
          { kind: "bot", id: "bot-c" },
          { kind: "bot", id: "bot-b" },
        ],
        mentionSpans: [first, second],
        clientNonce: "n-span-unauthorized",
      }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
      data: {
        code: "GROUP_MENTION_CLARIFICATION_REQUIRED",
        reasonCode: "target_not_authorized",
        mentionBotIds: ["bot-c"],
      },
    });

    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("rejects attachments on segmented dispatch with zero Task/Run", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
    });
    const text = "@Alpha 做 X，@Beta 做 Y";
    const first = spanAt(text, "@Alpha", "bot-a");
    const second = spanAt(text, "@Beta", "bot-b", first.end);

    await expect(
      sendGroup(harness, {
        text,
        artifactIds: ["artifact-1"],
        mentions: [
          { kind: "bot", id: "bot-a" },
          { kind: "bot", id: "bot-b" },
        ],
        mentionSpans: [first, second],
        clientNonce: "n-span-attachment",
      }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
      data: {
        code: "GROUP_MENTION_CLARIFICATION_REQUIRED",
        reasonCode: "attachments_not_attributable",
      },
    });

    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("shares attachments across a shared multi dispatch", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
    });
    const text = "@Alpha 和 @Beta 一起看这个";
    const first = spanAt(text, "@Alpha", "bot-a");
    const second = spanAt(text, "@Beta", "bot-b", first.end);

    await sendGroup(harness, {
      text,
      artifactIds: ["artifact-1"],
      mentions: [
        { kind: "bot", id: "bot-a" },
        { kind: "bot", id: "bot-b" },
      ],
      mentionSpans: [first, second],
      clientNonce: "n-span-shared-attachment",
    });

    const prompts = taskPrompts(harness);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe(prompts[1]);
    expect(prompts[0]).toContain("一起看这个");
    expect(prompts[0]).toContain('User attached file "file.txt"');
  });

  it("rejects a multi dispatch while a target is busy", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      leadBotId: "bot-a",
      activeRuns: [
        { id: "run-busy", taskId: "task-busy", botId: "bot-a", status: "running", trigger: "user" },
      ],
    });
    const text = "@Alpha 做 X，@Beta 做 Y";
    const first = spanAt(text, "@Alpha", "bot-a");
    const second = spanAt(text, "@Beta", "bot-b", first.end);

    await expect(
      sendGroup(harness, {
        text,
        mentions: [
          { kind: "bot", id: "bot-a" },
          { kind: "bot", id: "bot-b" },
        ],
        mentionSpans: [first, second],
        clientNonce: "n-span-busy",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      data: { code: "GROUP_MULTI_TARGET_BUSY", botIds: ["bot-a"] },
    });

    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("segments Chinese instructions with UTF-16 spans", async () => {
    const harness = groupSendHarness({
      members: [
        { id: "bot-a", name: "阿尔法" },
        { id: "bot-b", name: "贝塔" },
      ],
      leadBotId: "bot-a",
    });
    const text = "@阿尔法 做甲；@贝塔 做乙";
    const first = spanAt(text, "@阿尔法", "bot-a");
    const second = spanAt(text, "@贝塔", "bot-b", first.end);

    const result = await sendGroup(harness, {
      text,
      mentions: [
        { kind: "bot", id: "bot-a" },
        { kind: "bot", id: "bot-b" },
      ],
      mentionSpans: [first, second],
      clientNonce: "n-span-chinese",
    });

    expect(result.runIds.sort()).toEqual(["run-bot-a", "run-bot-b"]);
    expect(taskPrompts(harness)).toEqual(["做甲", "做乙"]);
  });
});
