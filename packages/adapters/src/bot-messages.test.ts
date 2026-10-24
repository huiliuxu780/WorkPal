import { RoundtableFeatureDisabledError } from "@rakazo/core";
import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  currentBotMessageHop,
  loadBotMessageContext,
  messageBot,
  returnBotMessageOutcome,
} from "./bot-messages.js";
import type { ExecutorDeps } from "./executor.js";

const run = {
  id: "run-1",
  spaceId: "workspace-1",
  threadId: "thread-sender",
  botId: "bot-sender",
  userId: "user-1",
  sourceMessageId: null as string | null,
};
const sender = { id: "bot-sender", name: "Researcher" };

function deps(
  options: {
    bots?: unknown[];
    hopBlocks?: unknown[];
    senderRunning?: boolean;
    alreadyDelivered?: unknown;
    targetArchived?: boolean;
    /** Simulate a unique (threadId, clientNonce) race after both retries miss. */
    uniqueConflictOnCommit?: boolean;
    transactionConflictOnce?: boolean;
    /** Blocks of messages this run already sent (duplicate-delivery guard). */
    sentBlocks?: unknown[];
    /** Run id recorded on the wake message (requester resolution for outcome returns). */
    requesterRunId?: string | null;
    /** Orchestration snapshot of the requester run (role restoration source). */
    requesterOrchestration?: unknown;
    requesterTrigger?: string;
    /** Source Thread belongs to this group; null/absent keeps the DM path. */
    sourceGroupId?: string | null;
    groupMembers?: unknown[];
    /** Server-resolved roundtable gates passed to dispatch. */
    roundtableFeatures?: {
      private_pair: boolean;
      public_collaboration: boolean;
      message_group: boolean;
      background_helper: boolean;
    };
  } = {},
) {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);
  const messageFindUnique = vi
    .fn()
    .mockImplementation(async (args: { where?: { threadId_clientNonce?: unknown } }) =>
      args?.where?.threadId_clientNonce
        ? (options.alreadyDelivered ?? null)
        : { blocks: options.hopBlocks ?? [], runId: options.requesterRunId ?? null },
    );
  const messageFindMany = vi
    .fn()
    .mockResolvedValue(options.sentBlocks ? [{ blocks: options.sentBlocks }] : []);
  const groupMembers = options.groupMembers ?? [
    {
      botId: "bot-sender",
      bot: {
        id: "bot-sender",
        name: "Researcher",
        archivedAt: null,
        spaceId: "workspace-1",
        userId: "user-1",
      },
    },
    {
      botId: "bot-target",
      bot: {
        id: "bot-target",
        name: "Analyst",
        archivedAt: null,
        spaceId: "workspace-1",
        userId: "user-1",
      },
    },
  ];
  let messageSeq = 0;
  let taskSeq = 1;
  let runSeq = 2;
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread" }]),
    run: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          options.senderRunning === false
            ? null
            : { id: "run-1", orchestration: options.requesterOrchestration ?? null },
        ),
      findUnique: vi.fn().mockResolvedValue({
        status: "running",
        orchestration: options.requesterOrchestration ?? null,
        trigger: options.requesterTrigger ?? "user",
      }),
      create: vi.fn().mockImplementation(async () => ({ id: `run-${runSeq++}` })),
    },
    bot: {
      findFirst: vi.fn().mockResolvedValue(options.targetArchived ? null : { id: "bot-target" }),
    },
    task: {
      create: vi.fn().mockImplementation(async () => ({ id: `task-${taskSeq++}` })),
    },
    message: {
      findUnique: messageFindUnique,
      findMany: messageFindMany,
      create: vi.fn().mockImplementation(async () => ({
        id: `message-${messageSeq}`,
        seq: messageSeq,
      })),
      update: vi.fn().mockResolvedValue({}),
    },
    event: { create: vi.fn().mockResolvedValue({ seq: 7 }) },
    thread: {
      update: vi.fn().mockImplementation(async (args: { data?: Record<string, unknown> }) => {
        if (args?.data?.nextMessageSeq) {
          messageSeq += 1;
          return { nextMessageSeq: messageSeq };
        }
        return { nextEventSeq: 7 };
      }),
    },
    chatGroup: {
      findFirst: vi.fn().mockResolvedValue({
        id: "group-1",
        spaceId: "workspace-1",
        userId: "user-1",
        kind: "standard",
        archivedAt: null,
        thread: { id: "thread-sender" },
        members: groupMembers,
      }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  let transactionAttempts = 0;
  const prisma = {
    thread: {
      findUnique: vi.fn().mockResolvedValue({ groupId: options.sourceGroupId ?? null }),
    },
    bot: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          options.bots ?? [
            { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
          ],
        ),
    },
    message: {
      findUnique: messageFindUnique,
      findMany: messageFindMany,
    },
    run: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue(
        options.requesterRunId
          ? {
              orchestration: options.requesterOrchestration ?? null,
              trigger: options.requesterTrigger ?? "user",
            }
          : null,
      ),
    },
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => {
      transactionAttempts += 1;
      if (options.transactionConflictOnce && transactionAttempts === 1) {
        throw Object.assign(new Error("write conflict"), { code: "P2034" });
      }
      if (options.uniqueConflictOnCommit) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      return fn(tx);
    }),
  } as unknown as PrismaClient;
  return {
    deps: {
      prisma,
      events: { notify },
      jobs: { enqueue },
      roundtableFeatures: options.roundtableFeatures,
    } as unknown as Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "roundtableFeatures">,
    tx,
    enqueue,
    notify,
  };
}

describe("messaging another bot", () => {
  it("refuses an empty message", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "   ",
    });
    expect(sent).toEqual({ ok: false, error: "message is required" });
  });

  it("keeps the classic roster refusal while the private_pair gate is closed", async () => {
    const harness = deps({ bots: [] });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-unknown",
      message: "status update",
    });
    expect(sent).toEqual({ ok: false, error: "no bot found with that id or name" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("delivers into the target's own chat while the private_pair gate is closed", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "one-line status update",
    });
    expect(sent).toMatchObject({ ok: true, botId: "bot-target", name: "Analyst" });
    expect(harness.tx.message.create).toHaveBeenCalled();
  });

  it("lets a sanctioned reply answer from a running source", async () => {
    const harness = deps();
    const sent = await messageBot(
      harness.deps,
      run,
      sender,
      { bot_id: "bot-target", message: "collected", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent).toMatchObject({ ok: true });
    const where = harness.tx.run.findFirst.mock.lastCall?.[0]?.where as {
      status?: unknown;
    };
    expect(where.status).toEqual({
      in: expect.arrayContaining(["completed", "failed", "running"]),
    });

    // A plain request keeps the running-only source requirement.
    const request = deps();
    await messageBot(request.deps, run, sender, {
      bot_id: "bot-target",
      message: "do the thing",
      intent: "request",
    });
    const requestWhere = request.tx.run.findFirst.mock.lastCall?.[0]?.where as {
      status?: unknown;
    };
    expect(requestWhere.status).toBe("running");
  });

  it("rejects an oversized message instead of silently truncating it", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "x".repeat(8_001),
    });
    expect(sent).toEqual({ ok: false, error: "message exceeds the 8000 character limit" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("allows a final result back through after the request hop limit", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "please finish",
          hop: 6,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "finished", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent.ok).toBe(true);
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          replyToMessageId: "message-request",
          blocks: expect.arrayContaining([expect.objectContaining({ intent: "result" })]),
        }),
      }),
    );
  });

  it("does not exempt a terminal reply to another terminal reply", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "finished",
          hop: 6,
          intent: "result",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "acknowledged", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });
});

const publicCollaborationEnabled = {
  private_pair: false,
  public_collaboration: true,
  message_group: false,
  background_helper: false,
};

const groupMember = (id: string, name: string, archivedAt: Date | null = null) => ({
  botId: id,
  bot: {
    id,
    name,
    archivedAt,
    spaceId: "workspace-1",
    userId: "user-1",
  },
});

describe("public group delegation", () => {
  it("refuses public delegation while the gate is closed", async () => {
    const harness = deps({ sourceGroupId: "group-1" });

    await expect(
      messageBot(harness.deps, run, sender, {
        bot_id: "bot-target",
        message: "check the baseline",
      }),
    ).rejects.toBeInstanceOf(RoundtableFeatureDisabledError);
    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("writes both sender and target facts into the same group Thread", async () => {
    const harness = deps({
      sourceGroupId: "group-1",
      roundtableFeatures: publicCollaborationEnabled,
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "check the baseline",
      intent: "request",
      deliveryKey: "call-1",
    });

    expect(sent).toMatchObject({
      ok: true,
      botId: "bot-target",
      targetRunId: "run-2",
      destination: { kind: "current_group", groupId: "group-1", threadId: "thread-sender" },
      locator: {
        kind: "group_message",
        groupId: "group-1",
        threadId: "thread-sender",
        messageId: "message-1",
      },
    });
    expect(harness.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: "bot-target", threadId: "thread-sender" }),
      }),
    );
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-target",
          threadId: "thread-sender",
          trigger: "bot_message",
        }),
      }),
    );

    type CreatedMessage = {
      threadId: string;
      role: string;
      botId?: string | null;
      clientNonce?: string;
      blocks: Array<Record<string, unknown>>;
    };
    const messages = harness.tx.message.create.mock.calls.map(
      ([call]) => (call as { data: CreatedMessage }).data,
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      threadId: "thread-sender",
      role: "bot",
      botId: "bot-sender",
    });
    expect(messages[1]).toMatchObject({
      threadId: "thread-sender",
      role: "user",
      clientNonce: "bot-message:call-1",
    });
    expect(messages[0]!.blocks[0]).toMatchObject({
      kind: "bot_message_sent",
      toBotId: "bot-target",
      text: "check the baseline",
    });
    expect(messages[1]!.blocks[0]).toMatchObject({
      kind: "bot_message_received",
      fromBotId: "bot-sender",
      returnToMessageId: "message-1",
    });
    // The target speaks only from its real support Run; dispatch never fabricates
    // a confirmation authored by the target.
    expect(messages.some((message) => message.botId === "bot-target")).toBe(false);
    expect(harness.tx.message.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ threadId: "thread-target" }),
      }),
    );
    expect(harness.notify).toHaveBeenCalledWith("thread-sender", 7);
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects a target that is not a current group member", async () => {
    const harness = deps({
      sourceGroupId: "group-1",
      roundtableFeatures: publicCollaborationEnabled,
      groupMembers: [groupMember("bot-sender", "Researcher")],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "check the baseline",
    });

    expect(sent).toEqual({ ok: false, error: "target is not a current group member" });
    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("rejects an archived group member", async () => {
    const harness = deps({
      sourceGroupId: "group-1",
      roundtableFeatures: publicCollaborationEnabled,
      groupMembers: [
        groupMember("bot-sender", "Researcher"),
        groupMember("bot-target", "Analyst", new Date("2026-10-01T00:00:00Z")),
      ],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "check the baseline",
    });

    expect(sent).toEqual({ ok: false, error: "Analyst is not available in this group" });
    expect(harness.tx.task.create).not.toHaveBeenCalled();
  });

  it("keeps per-target deliveries from one source Run independent", async () => {
    const harness = deps({
      sourceGroupId: "group-1",
      roundtableFeatures: publicCollaborationEnabled,
      groupMembers: [
        groupMember("bot-sender", "Researcher"),
        groupMember("bot-target", "Analyst"),
        groupMember("bot-target-2", "Writer"),
      ],
    });
    const targetIds = ["bot-target", "bot-target-2"];
    const deliveryKeys = targetIds.map((botId) =>
      toolEffectIdempotencyKey(run.id, "message_bot", {
        bot_id: botId,
        message: "split the work",
      }),
    );
    expect(new Set(deliveryKeys).size).toBe(2);

    const first = await messageBot(harness.deps, run, sender, {
      bot_id: targetIds[0],
      message: "split the work",
      deliveryKey: deliveryKeys[0],
    });
    const second = await messageBot(harness.deps, run, sender, {
      bot_id: targetIds[1],
      message: "split the work",
      deliveryKey: deliveryKeys[1],
    });

    expect(first).toMatchObject({ ok: true, botId: "bot-target", targetRunId: "run-2" });
    expect(second).toMatchObject({ ok: true, botId: "bot-target-2", targetRunId: "run-3" });
    expect(harness.tx.task.create).toHaveBeenCalledTimes(2);
    expect(harness.tx.run.create).toHaveBeenCalledTimes(2);
    expect(harness.tx.message.create).toHaveBeenCalledTimes(4);
    const nonces = harness.tx.message.create.mock.calls
      .map(([call]) => (call as { data: { clientNonce?: string } }).data.clientNonce)
      .filter((nonce): nonce is string => Boolean(nonce));
    expect(nonces).toEqual([`bot-message:${deliveryKeys[0]}`, `bot-message:${deliveryKeys[1]}`]);
  });

  it("replays a recorded public delivery without another Run", async () => {
    const harness = deps({
      sourceGroupId: "group-1",
      roundtableFeatures: publicCollaborationEnabled,
      alreadyDelivered: {
        id: "message-inbound",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-sender",
            fromBotName: "Researcher",
            text: "check the baseline",
            intent: "request",
            returnToMessageId: "message-public",
          },
        ],
        sourceRuns: [{ id: "run-9", botId: "bot-target", bot: { name: "Analyst" } }],
      },
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "check the baseline",
      deliveryKey: "call-1",
    });

    expect(sent).toMatchObject({
      ok: true,
      replayed: true,
      targetRunId: "run-9",
      locator: {
        kind: "group_message",
        groupId: "group-1",
        threadId: "thread-sender",
        messageId: "message-public",
      },
    });
    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("retries a serialization conflict without dropping the group delivery", async () => {
    const harness = deps({
      sourceGroupId: "group-1",
      roundtableFeatures: publicCollaborationEnabled,
      transactionConflictOnce: true,
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "check the baseline",
      intent: "request",
      deliveryKey: "call-1",
    });
    expect(sent).toMatchObject({ ok: true, botId: "bot-target", targetRunId: "run-2" });
    expect(harness.deps.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });
});

describe("hop lookup", () => {
  it("treats a run a person started as the start of a chain", async () => {
    const prisma = { message: { findUnique: vi.fn() } } as unknown as PrismaClient;
    expect(await currentBotMessageHop(prisma, null)).toBe(0);
    expect(prisma.message.findUnique).not.toHaveBeenCalled();
  });

  it("reads the hop back off the message that woke the bot", async () => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            { kind: "text", text: "noise" },
            { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "x", hop: 3 },
          ],
        }),
      },
    } as unknown as PrismaClient;
    expect(await currentBotMessageHop(prisma, "message-1")).toBe(3);
  });

  it("loads peer context directly from the source message", async () => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "b",
              fromBotName: "B",
              text: "late FYI",
              intent: "fyi",
            },
          ],
          replyTo: {
            blocks: [
              {
                kind: "bot_message_sent",
                toBotId: "b",
                toBotName: "B",
                text: "check Gmail",
                intent: "request",
              },
            ],
          },
        }),
      },
    } as unknown as PrismaClient;
    expect(await loadBotMessageContext(prisma, "message-old")).toMatchObject({
      intent: "fyi",
      repliesToRequest: true,
    });
    expect(prisma.message.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "message-old" } }),
    );
  });
});

const ownerRequesterSnapshot = {
  version: "v1",
  routing: { kind: "explicit_mention" },
  ownership: { mode: "owner", ownerBotId: "bot-target" },
  responseMode: "single",
  execution: {
    interactive: true,
    planning: "auto",
    delegation: { mode: "auto", background: true, maxChildren: 3, maxDepth: 1 },
  },
  collaboration: {
    role: "owner",
    source: "user",
    fromBotId: null,
    parentRunId: null,
    handoffDepth: 0,
    messageHop: 0,
  },
};

const supportRequesterSnapshot = {
  version: "v1",
  routing: { kind: "bot_message" },
  ownership: { mode: "support", ownerBotId: "bot-mid" },
  responseMode: "single",
  execution: {
    interactive: false,
    planning: "disabled",
    delegation: { mode: "auto", background: false, maxChildren: 3, maxDepth: 1 },
  },
  collaboration: {
    role: "support",
    source: "bot_message",
    fromBotId: "bot-target",
    parentRunId: "run-alice",
    handoffDepth: 0,
    messageHop: 1,
  },
};

const handoffOwnerSnapshot = {
  version: "v1",
  routing: { kind: "handoff" },
  ownership: { mode: "owner", ownerBotId: "bot-target" },
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
    handoffDepth: 2,
    messageHop: 0,
  },
};

function readCreatedOrchestration(harness: ReturnType<typeof deps>) {
  const call = harness.tx.run.create.mock.calls[0]![0] as {
    data: {
      orchestration: {
        ownership: { mode: string; ownerBotId: string };
        execution: { interactive: boolean; planning: string };
        collaboration: {
          role: string;
          source: string;
          fromBotId: string;
          handoffDepth: number;
          messageHop: number;
        };
      };
    };
  };
  return call.data.orchestration;
}

describe("automatic outcome return", () => {
  it("routes a delegated run's final text back to its coordinator", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
      requesterRunId: "run-alice",
      requesterOrchestration: ownerRequesterSnapshot,
    });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );
    expect(returned).toBe(true);
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "bot_message" }) }),
    );
    // The outcome hop restores the REQUESTER's role: an owner requester
    // resumes as owner with its owner-grade policy (never branded support).
    const orchestration = readCreatedOrchestration(harness);
    expect(orchestration.ownership.mode).toBe("owner");
    expect(orchestration.execution).toMatchObject({ interactive: true, planning: "auto" });
    expect(orchestration.collaboration).toMatchObject({
      role: "owner",
      source: "bot_message",
      fromBotId: "bot-sender",
      parentRunId: "run-1",
      messageHop: 2,
    });
    expect(harness.tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["completed", "failed", "running"] },
        }),
      }),
    );
    expect(harness.enqueue).toHaveBeenCalledOnce();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: run.id,
        status: { in: ["completed", "failed"] },
        botOutcomeReturnedAt: null,
      },
      data: { botOutcomeReturnedAt: expect.any(Date) },
    });
  });

  it("marks fyi wakes handled without a reply", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "fyi only",
          hop: 1,
          intent: "fyi",
        },
      ],
    });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer.",
    );
    expect(returned).toBe(true);
    expect(harness.tx.message.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("still returns a final result after an interim status update", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    vi.mocked(harness.deps.prisma.message.findMany).mockResolvedValue([
      {
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-target",
            toBotName: "Coordinator",
            text: "still looking",
            hop: 2,
            intent: "status",
          },
        ],
      },
    ] as never);

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });

  it("skips the automatic return when a result was already sent", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    vi.mocked(harness.deps.prisma.message.findMany).mockResolvedValue([
      {
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-target",
            toBotName: "Coordinator",
            text: "done",
            hop: 2,
            intent: "result",
          },
        ],
      },
    ] as never);

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalled();
  });
});

describe("outcome-return role preservation (P1)", () => {
  const requestHopBlocks = [
    {
      kind: "bot_message_received",
      fromBotId: "bot-target",
      fromBotName: "Coordinator",
      text: "research this",
      hop: 1,
      intent: "request",
      returnToMessageId: "message-request",
    },
  ];

  it("keeps a nested support requester in support (no promotion to owner)", async () => {
    const harness = deps({
      hopBlocks: requestHopBlocks,
      requesterRunId: "run-bob",
      requesterOrchestration: supportRequesterSnapshot,
    });

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "Charlie's answer: 7.",
    );

    expect(returned).toBe(true);
    const orchestration = readCreatedOrchestration(harness);
    expect(orchestration.ownership.mode).toBe("support");
    expect(orchestration.execution).toMatchObject({ interactive: false, planning: "disabled" });
    expect(orchestration.collaboration).toMatchObject({
      role: "support",
      source: "bot_message",
      fromBotId: "bot-sender",
    });
  });

  it("preserves a handoff owner's role and stage depth", async () => {
    const harness = deps({
      hopBlocks: requestHopBlocks,
      requesterRunId: "run-handoff-owner",
      requesterOrchestration: handoffOwnerSnapshot,
    });

    await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The numbers check out.",
    );

    const orchestration = readCreatedOrchestration(harness);
    expect(orchestration.ownership.mode).toBe("owner");
    expect(orchestration.execution).toMatchObject({ interactive: true, planning: "auto" });
    expect(orchestration.collaboration).toMatchObject({
      role: "owner",
      handoffDepth: 2,
      messageHop: 2,
    });
  });

  it("applies the same preservation rule to status returns", async () => {
    const harness = deps({
      hopBlocks: requestHopBlocks,
      requesterRunId: "run-alice",
      requesterOrchestration: ownerRequesterSnapshot,
    });

    await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "Halfway there; initial numbers look good.",
      "status",
    );

    const orchestration = readCreatedOrchestration(harness);
    expect(orchestration.ownership.mode).toBe("owner");
    expect(orchestration.collaboration.role).toBe("owner");
  });

  it("derives owner for a legacy user-triggered requester without a snapshot", async () => {
    const harness = deps({
      hopBlocks: requestHopBlocks,
      requesterRunId: "run-legacy",
      requesterOrchestration: null,
      requesterTrigger: "user",
    });

    await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "Legacy answer.",
    );

    const orchestration = readCreatedOrchestration(harness);
    expect(orchestration.ownership.mode).toBe("owner");
    expect(orchestration.execution).toMatchObject({ planning: "auto" });
  });

  it("derives support for a legacy bot_message-triggered requester", async () => {
    const harness = deps({
      hopBlocks: requestHopBlocks,
      requesterRunId: "run-legacy-support",
      requesterOrchestration: null,
      requesterTrigger: "bot_message",
    });

    await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "Nested legacy answer.",
    );

    expect(readCreatedOrchestration(harness).ownership.mode).toBe("support");
  });

  it("never promotes to owner when the requester run cannot be resolved", async () => {
    const harness = deps({
      hopBlocks: requestHopBlocks,
      // no requesterRunId: the reply linkage is broken
    });

    await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "Answer with a broken chain.",
    );

    expect(readCreatedOrchestration(harness).ownership.mode).toBe("support");
  });

  it("replays an idempotent outcome return without a second continuation run", async () => {
    const harness = deps({
      hopBlocks: requestHopBlocks,
      requesterRunId: "run-alice",
      requesterOrchestration: ownerRequesterSnapshot,
      alreadyDelivered: { id: "message-delivered" },
    });

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });
});
