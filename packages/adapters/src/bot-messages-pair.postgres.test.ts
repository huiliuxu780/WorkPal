import { randomUUID } from "node:crypto";
import { resolveRoundtableFeatureGates } from "@rakazo/core";
import {
  CHAT_GROUP_KIND_AGENT_PAIR,
  cancelChildrenOfCancelledRuns,
  cancelRunsInTransaction,
  createIsolatedPostgresDatabase,
  createManualRetryRun,
  createThreadMessageInTransaction,
  createThreadPolicy,
  expireWaitingRuns,
  type IsolatedPostgresDatabase,
  ManualRetryDenied,
  type PrismaClient,
  pauseRunForInput,
  resolveIntervention,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { messageBot, returnBotMessageOutcome } from "./bot-messages.js";
import { interventionOriginForRun } from "./run-origin.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

const PAIR_GATES = resolveRoundtableFeatureGates({ ROUNDTABLE_PRIVATE_PAIR_ENABLED: "true" });

/** RT-05: private message_bot delivers through the fixed A ↔ B pair Thread. */
describePostgres("private pair delivery (PostgreSQL)", () => {
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  const id = randomUUID();
  let spaceId: string;
  let sender: { id: string; name: string };
  let researcher: { id: string; name: string };
  let writer: { id: string; name: string };
  let sourceThreadId: string;
  const dmThreads = new Map<string, string>();

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("rt05_pair");
    prisma = isolated.db.prisma;
    spaceId = id;
    await prisma.user.create({
      data: { id, name: "RT05 owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "RT05 org", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "RT05 space" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: {
        id,
        spaceId,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const makeBot = async (name: string) => {
      const bot = await prisma.bot.create({ data: { spaceId, userId: id, name, color: "test" } });
      const thread = await prisma.thread.create({
        data: { spaceId, userId: id, botId: bot.id },
      });
      dmThreads.set(bot.id, thread.id);
      return { id: bot.id, name: bot.name };
    };
    sender = await makeBot("Sender");
    researcher = await makeBot("Researcher");
    writer = await makeBot("Writer");
    sourceThreadId = dmThreads.get(sender.id)!;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  function deps() {
    return {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
      roundtableFeatures: PAIR_GATES,
    } as unknown as Parameters<typeof messageBot>[0];
  }

  /** Deliver successfully or fail the test with the returned reason. */
  async function send(
    run: {
      id: string;
      spaceId: string;
      threadId: string;
      botId: string;
      userId: string;
      sourceMessageId?: string | null;
    },
    input: Parameters<typeof messageBot>[3],
  ): Promise<{
    ok: true;
    botId: string;
    name: string;
    targetRunId: string;
    delivered: string;
    replayed?: true;
    note: string;
  }> {
    const result = await messageBot(deps(), run, sender, input);
    if (!result.ok || !("targetRunId" in result)) {
      throw new Error(`private delivery failed: ${JSON.stringify(result)}`);
    }
    return result;
  }

  async function newSenderRun(options: { sourceMessageId?: string; status?: string } = {}) {
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId: id,
        botId: sender.id,
        threadId: sourceThreadId,
        prompt: "Private delegation source",
        status: "running",
      },
    });
    return prisma.run.create({
      data: {
        spaceId,
        userId: id,
        botId: sender.id,
        threadId: sourceThreadId,
        taskId: task.id,
        status: options.status ?? "running",
        trigger: "user",
        sourceMessageId: options.sourceMessageId,
      },
    });
  }

  async function sourceMessage(
    blocks: Parameters<typeof createThreadMessageInTransaction>[1]["blocks"],
  ) {
    return prisma.$transaction((tx) =>
      createThreadMessageInTransaction(tx, {
        threadId: sourceThreadId,
        role: "user",
        originKind: "human_web",
        authorUserId: id,
        botId: sender.id,
        blocks,
      }),
    );
  }

  async function pairGroups(botA: string, botB: string) {
    const groups = await prisma.chatGroup.findMany({
      where: { spaceId, userId: id, kind: CHAT_GROUP_KIND_AGENT_PAIR },
      select: {
        id: true,
        thread: { select: { id: true } },
        members: { select: { botId: true } },
      },
    });
    return groups.filter((group) => {
      const ids = new Set(group.members.map((member) => member.botId));
      return ids.size === 2 && ids.has(botA) && ids.has(botB);
    });
  }

  async function threadOf(botId: string) {
    return dmThreads.get(botId)!;
  }

  it("delivers into one pair Thread with a lightweight receipt and a durable origin", async () => {
    expect(await pairGroups(sender.id, researcher.id)).toHaveLength(0);
    const run = await newSenderRun();
    const sent = await send(run, {
      bot_id: researcher.id,
      message: "chart the q3 numbers",
      deliveryKey: "rt05-single",
    });
    expect(sent).toMatchObject({ ok: true, botId: researcher.id, name: "Researcher" });
    if (!sent.ok) throw new Error("delivery failed");

    const groups = await pairGroups(sender.id, researcher.id);
    expect(groups).toHaveLength(1);
    const pairThreadId = groups[0]!.thread!.id;
    expect(pairThreadId).not.toBe(sourceThreadId);

    // B's own chat is never used for private collaboration.
    expect(await prisma.message.count({ where: { threadId: await threadOf(researcher.id) } })).toBe(
      0,
    );

    // The source Thread keeps only the receipt: target identity, no body.
    const receipts = await prisma.message.findMany({
      where: { runId: run.id, threadId: sourceThreadId },
    });
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt.threadId).toBe(sourceThreadId);
    expect(receipt.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_sent",
        toBotId: researcher.id,
        toBotName: "Researcher",
        text: "",
      }),
    ]);

    // The pair Thread holds the full collaboration plus its wake.
    const pairMessages = await prisma.message.findMany({
      where: { threadId: pairThreadId },
      orderBy: { seq: "asc" },
    });
    expect(pairMessages.map((message) => message.role)).toEqual(["bot", "user"]);
    expect(pairMessages[0]!.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_sent",
        toBotId: researcher.id,
        text: "chart the q3 numbers",
      }),
    ]);
    const inbound = pairMessages[1]!;
    expect(inbound.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_received",
        fromBotId: sender.id,
        text: "chart the q3 numbers",
      }),
    ]);

    const targetRun = await prisma.run.findUniqueOrThrow({ where: { id: sent.targetRunId } });
    expect(targetRun).toMatchObject({
      threadId: pairThreadId,
      botId: researcher.id,
      status: "queued",
      trigger: "bot_message",
      sourceMessageId: inbound.id,
      originThreadId: sourceThreadId,
      originRunId: run.id,
      originMessageId: receipt.id,
    });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: targetRun.taskId } })).toMatchObject({
      threadId: pairThreadId,
      botId: researcher.id,
    });

    // Both pair messages are authorized against the receipt the user can see.
    const origins = await prisma.agentPairMessageOrigin.findMany({
      where: { pairThreadId },
    });
    expect(origins.map((origin) => origin.messageId).sort()).toEqual(
      pairMessages.map((message) => message.id).sort(),
    );
    for (const origin of origins) {
      expect(origin).toMatchObject({
        sourceThreadId,
        sourceRunId: run.id,
        sourceReceiptMessageId: receipt.id,
      });
    }

    const policy = createThreadPolicy(prisma);
    const page = await policy.readPairMessages({
      actor: { spaceId, userId: id },
      originLocator: {
        sourceReceiptMessageId: receipt.id,
        pairThreadId,
        messageId: inbound.id,
      },
      limit: 10,
    });
    expect(page.messages).toHaveLength(2);

    // Humans may read this projection but never write the pair Thread itself.
    await expect(
      policy.assertHumanCanWrite({ actor: { spaceId, userId: id }, threadId: pairThreadId }),
    ).rejects.toThrow();
    await expect(
      policy.assertResolvedHumanCanWrite({
        actor: { spaceId, userId: id },
        threadId: pairThreadId,
        classification: "agent_pair",
      }),
    ).rejects.toThrow();
  });

  it("reuses the same pair for the next private request", async () => {
    const before = await pairGroups(sender.id, researcher.id);
    const run = await newSenderRun();
    const sent = await send(run, {
      bot_id: researcher.id,
      message: "second private note",
    });
    expect(sent.ok).toBe(true);
    expect(await pairGroups(sender.id, researcher.id)).toHaveLength(before.length);
    if (!sent.ok) throw new Error("delivery failed");
    const targetRun = await prisma.run.findUniqueOrThrow({ where: { id: sent.targetRunId } });
    expect(targetRun.threadId).toBe(before[0]!.thread!.id);
  });

  it("creates an independent pair Thread and Run for each target in one turn", async () => {
    const run = await newSenderRun();
    const [toResearcher, toWriter] = await Promise.all([
      send(run, {
        bot_id: researcher.id,
        message: "research this",
        deliveryKey: "rt05-multi-a",
      }),
      send(run, {
        bot_id: writer.id,
        message: "write this",
        deliveryKey: "rt05-multi-b",
      }),
    ]);
    expect(toResearcher.ok && toWriter.ok).toBe(true);
    if (!toResearcher.ok || !toWriter.ok) throw new Error("delivery failed");
    expect(toResearcher.targetRunId).not.toBe(toWriter.targetRunId);

    const pairRuns = await prisma.run.findMany({
      where: { originRunId: run.id, originThreadId: sourceThreadId },
    });
    expect(pairRuns).toHaveLength(2);
    expect(new Set(pairRuns.map((row) => row.threadId)).size).toBe(2);
    for (const pairRun of pairRuns) {
      const thread = await prisma.thread.findUniqueOrThrow({
        where: { id: pairRun.threadId },
        select: { group: { select: { kind: true } } },
      });
      expect(thread.group?.kind).toBe(CHAT_GROUP_KIND_AGENT_PAIR);
    }
    expect(await prisma.message.count({ where: { threadId: await threadOf(writer.id) } })).toBe(0);
    // The source Thread gets one receipt per target, still without the body.
    const receipts = await prisma.message.findMany({
      where: { runId: run.id, threadId: sourceThreadId },
    });
    expect(receipts).toHaveLength(2);
    expect(receipts.every((message) => JSON.stringify(message.blocks).includes('"text":""'))).toBe(
      true,
    );
  });

  it("refuses archived, unknown and cross-workspace targets without writing", async () => {
    const archived = await prisma.bot.create({
      data: {
        spaceId,
        userId: id,
        name: "Retired",
        color: "test",
        archivedAt: new Date(),
      },
    });
    await prisma.thread.create({ data: { spaceId, userId: id, botId: archived.id } });
    const run = await newSenderRun();

    const archivedResult = await messageBot(deps(), run, sender, {
      bot_id: archived.id,
      message: "hello",
    });
    expect(archivedResult).toEqual({ ok: false, error: "Retired is no longer available" });

    const unknown = await messageBot(deps(), run, sender, {
      bot_id: `missing-${randomUUID()}`,
      message: "hello",
    });
    expect(unknown).toEqual({ ok: false, error: "no bot found with that id or name" });

    // A Bot of another workspace never becomes addressable by name.
    const otherSpace = randomUUID();
    await prisma.user.create({
      data: {
        id: otherSpace,
        name: "Outsider",
        email: `${otherSpace}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id: otherSpace, name: "Outsider", slug: otherSpace, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: otherSpace, organizationId: otherSpace, name: "Outsider" },
    });
    await prisma.member.create({
      data: {
        id: otherSpace,
        organizationId: otherSpace,
        userId: otherSpace,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: otherSpace,
        spaceId: otherSpace,
        organizationId: otherSpace,
        userId: otherSpace,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.bot.create({
      data: { spaceId: otherSpace, userId: otherSpace, name: "Outsider Bot", color: "test" },
    });
    const crossWorkspace = await messageBot(deps(), run, sender, {
      confirm_name: "Outsider Bot",
      message: "hello",
    });
    expect(crossWorkspace).toEqual({ ok: false, error: "no bot found with that id or name" });

    const self = await messageBot(deps(), run, sender, {
      bot_id: sender.id,
      message: "hello",
    });
    expect(self).toEqual({ ok: false, error: "a bot cannot message itself" });

    expect(await prisma.run.count({ where: { originRunId: run.id } })).toBe(0);
  });

  it("replays a delivery key without a second message, Task or Run", async () => {
    const run = await newSenderRun();
    const first = await send(run, {
      bot_id: researcher.id,
      message: "idempotent",
      deliveryKey: "rt05-replay",
    });
    const second = await send(run, {
      bot_id: researcher.id,
      message: "idempotent",
      deliveryKey: "rt05-replay",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("delivery failed");
    expect(second.replayed).toBe(true);
    expect(second.targetRunId).toBe(first.targetRunId);

    const targetRun = await prisma.run.findUniqueOrThrow({ where: { id: first.targetRunId } });
    expect(await prisma.run.count({ where: { originRunId: run.id } })).toBe(1);
    expect(await prisma.task.count({ where: { id: targetRun.taskId } })).toBe(1);
    // One inbound wake for the pair, one receipt in the source Thread.
    expect(
      await prisma.message.count({
        where: { threadId: targetRun.threadId, clientNonce: "bot-message:rt05-replay" },
      }),
    ).toBe(1);
    expect(await prisma.message.count({ where: { runId: run.id, threadId: sourceThreadId } })).toBe(
      1,
    );
  });

  it("serializes two concurrent deliveries of one key into one Run", async () => {
    const run = await newSenderRun();
    const calls = await Promise.allSettled([
      send(run, {
        bot_id: writer.id,
        message: "concurrent",
        deliveryKey: "rt05-concurrent",
      }),
      send(run, {
        bot_id: writer.id,
        message: "concurrent",
        deliveryKey: "rt05-concurrent",
      }),
    ]);
    expect(calls.some((call) => call.status === "fulfilled" && call.value.ok)).toBe(true);
    expect(await prisma.run.count({ where: { originRunId: run.id } })).toBe(1);
  });

  it("rolls the whole delivery back when one write fails", async () => {
    const target = await prisma.bot.create({
      data: { spaceId, userId: id, name: "Atomic", color: "test" },
    });
    await prisma.thread.create({ data: { spaceId, userId: id, botId: target.id } });
    const run = await newSenderRun();
    const key = "rt05-atomic";
    // A pre-existing receipt with the same nonce makes the receipt insert fail
    // after the pair messages were written in the same transaction.
    await prisma.message.create({
      data: {
        threadId: sourceThreadId,
        seq: 900_001,
        role: "bot",
        originKind: "bot",
        botId: sender.id,
        runId: run.id,
        blocks: [],
        clientNonce: `receipt:bot-message:${key}`,
      },
    });

    await expect(
      messageBot(deps(), run, sender, {
        bot_id: target.id,
        message: "must not half-commit",
        deliveryKey: key,
      }),
    ).rejects.toThrow();

    const groups = await pairGroups(sender.id, target.id);
    for (const group of groups) {
      if (group.thread) {
        expect(await prisma.message.count({ where: { threadId: group.thread.id } })).toBe(0);
      }
    }
    expect(await prisma.run.count({ where: { botId: target.id } })).toBe(0);
    expect(await prisma.task.count({ where: { botId: target.id } })).toBe(0);
  });

  it("stops an exhausted chain before it writes into a pair", async () => {
    const source = await sourceMessage([
      {
        kind: "bot_message_received",
        fromBotId: researcher.id,
        fromBotName: researcher.name,
        text: "one more",
        hop: 6,
        intent: "request",
      },
    ]);
    const run = await newSenderRun({ sourceMessageId: source.id });
    const sent = await messageBot(deps(), run, sender, {
      bot_id: researcher.id,
      message: "again",
    });
    expect(sent).toMatchObject({ ok: false });
    if (sent.ok) throw new Error("delivery should fail");
    expect(sent.error).toContain("limit reached");
    expect(await prisma.run.count({ where: { originRunId: run.id } })).toBe(0);
  });

  it("refuses an acknowledgement loop and a duplicate body in one turn", async () => {
    const source = await sourceMessage([
      {
        kind: "bot_message_received",
        fromBotId: researcher.id,
        fromBotName: researcher.name,
        text: "the report is done",
        hop: 1,
        intent: "result",
      },
    ]);
    const loopRun = await newSenderRun({ sourceMessageId: source.id });
    const loop = await messageBot(deps(), loopRun, sender, {
      bot_id: researcher.id,
      message: "thanks",
      intent: "fyi",
    });
    expect(loop).toMatchObject({ ok: false });
    if (loop.ok) throw new Error("ack loop should fail");
    expect(loop.error).toContain("Do not acknowledge");

    const run = await newSenderRun();
    const first = await send(run, {
      bot_id: writer.id,
      message: "same body",
    });
    const second = await messageBot(deps(), run, sender, {
      bot_id: writer.id,
      message: "same body",
    });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false });
    if (second.ok) throw new Error("duplicate should fail");
    expect(second.error).toContain("already sent");
  });

  it("returns the result to the origin Thread and reuses the same pair", async () => {
    const sourceRun = await newSenderRun();
    const dispatched = await send(sourceRun, {
      bot_id: researcher.id,
      message: "summarize the deck",
      deliveryKey: "rt05-outcome",
    });
    if (!dispatched.ok) throw new Error("delivery failed");
    const pairRun = await prisma.run.update({
      where: { id: dispatched.targetRunId },
      data: { status: "completed", completedAt: new Date() },
    });
    const pairThreadId = pairRun.threadId;
    const groupsBefore = await pairGroups(sender.id, researcher.id);

    const returned = await returnBotMessageOutcome(
      {
        prisma,
        events: { notify: vi.fn(async () => undefined) },
        jobs: { enqueue: vi.fn(async () => undefined) },
      } as unknown as Parameters<typeof returnBotMessageOutcome>[0],
      {
        id: pairRun.id,
        spaceId,
        threadId: pairRun.threadId,
        botId: pairRun.botId,
        userId: id,
        sourceMessageId: pairRun.sourceMessageId,
        orchestration: pairRun.orchestration,
        originThreadId: pairRun.originThreadId,
        originRunId: pairRun.originRunId,
        originMessageId: pairRun.originMessageId,
      },
      researcher,
      "The deck says growth is flat.",
    );
    expect(returned).toBe(true);

    // The requester is woken in its own visible Thread with the real answer.
    const wake = await prisma.message.findFirstOrThrow({
      where: { threadId: sourceThreadId, clientNonce: `bot-message:auto-outcome:${pairRun.id}` },
    });
    expect(wake.role).toBe("user");
    expect(wake.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_received",
        fromBotId: researcher.id,
        text: "The deck says growth is flat.",
        intent: "result",
      }),
    ]);

    const resumed = await prisma.run.findFirstOrThrow({
      where: { sourceMessageId: wake.id },
    });
    expect(resumed).toMatchObject({
      threadId: sourceThreadId,
      botId: sender.id,
      trigger: "bot_message",
      originThreadId: sourceThreadId,
      originRunId: sourceRun.id,
      originMessageId: pairRun.originMessageId,
    });
    expect(pairRun.originThreadId).toBe(sourceThreadId);

    // The result lands in the same pair Thread and stays visible to the user;
    // no second pair identity is invented and B's own chat stays empty.
    expect(await pairGroups(sender.id, researcher.id)).toHaveLength(groupsBefore.length);
    const pairCopy = await prisma.message.findFirstOrThrow({
      where: { threadId: pairThreadId, runId: pairRun.id, role: "bot" },
      orderBy: { seq: "desc" },
    });
    expect(pairCopy.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_sent",
        toBotId: sender.id,
        text: "The deck says growth is flat.",
      }),
    ]);
    expect(
      await prisma.agentPairMessageOrigin.count({
        where: { messageId: pairCopy.id, sourceReceiptMessageId: pairRun.originMessageId! },
      }),
    ).toBe(1);
    expect(await prisma.message.count({ where: { threadId: await threadOf(researcher.id) } })).toBe(
      0,
    );
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: pairRun.id } })).botOutcomeReturnedAt,
    ).not.toBeNull();
  });

  it("cancels the delegated Run with its origin and never fabricates a reply", async () => {
    const sourceRun = await newSenderRun();
    const dispatched = await send(sourceRun, {
      bot_id: researcher.id,
      message: "cancel me",
      deliveryKey: "rt05-cancel",
    });
    if (!dispatched.ok) throw new Error("delivery failed");
    const messagesBefore = await prisma.message.count({
      where: { threadId: sourceThreadId, runId: dispatched.targetRunId },
    });

    await prisma.$transaction((tx) => cancelRunsInTransaction(tx, [sourceRun], new Date()));
    await cancelChildrenOfCancelledRuns(prisma, [sourceRun.id]);

    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: dispatched.targetRunId } }),
    ).toMatchObject({ status: "cancelled", error: "parent_cancelled" });
    expect(
      await prisma.message.count({
        where: { threadId: sourceThreadId, runId: dispatched.targetRunId },
      }),
    ).toBe(messagesBefore);
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: sourceRun.id } })).botOutcomeReturnedAt,
    ).toBeNull();
  });

  it("keeps retry scoped to the origin instead of resurrecting a pair Run", async () => {
    const sourceRun = await newSenderRun();
    const dispatched = await send(sourceRun, {
      bot_id: researcher.id,
      message: "retry scope",
      deliveryKey: "rt05-retry",
    });
    if (!dispatched.ok) throw new Error("delivery failed");
    await prisma.run.update({
      where: { id: dispatched.targetRunId },
      data: { status: "failed", error: "boom", completedAt: new Date() },
    });

    await expect(
      createManualRetryRun(prisma, {
        spaceId,
        userId: id,
        runId: dispatched.targetRunId,
        clientNonce: `rt05-retry-${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(ManualRetryDenied);
  });

  it("walks a nested pair origin up to the visible Thread for its intervention", async () => {
    const sourceRun = await newSenderRun();
    const pairs = await pairGroups(sender.id, researcher.id);
    const outerPairThreadId = pairs[0]!.thread!.id;
    const innerPairThreadId = (await pairGroups(sender.id, writer.id))[0]!.thread!.id;

    const makeRun = async (
      threadId: string,
      botId: string,
      origin?: {
        threadId: string;
        runId: string;
        messageId: string;
      },
    ) => {
      const task = await prisma.task.create({
        data: { spaceId, userId: id, botId, threadId, prompt: "nested", status: "running" },
      });
      return prisma.run.create({
        data: {
          spaceId,
          userId: id,
          botId,
          threadId,
          taskId: task.id,
          status: "running",
          trigger: "bot_message",
          originThreadId: origin?.threadId,
          originRunId: origin?.runId,
          originMessageId: origin?.messageId,
        },
      });
    };
    const outerRun = await makeRun(outerPairThreadId, researcher.id, {
      threadId: sourceThreadId,
      runId: sourceRun.id,
      messageId: "outer-receipt",
    });
    const innerRun = await makeRun(innerPairThreadId, writer.id, {
      threadId: outerPairThreadId,
      runId: outerRun.id,
      messageId: "inner-receipt",
    });

    const origin = await interventionOriginForRun(prisma, innerRun);
    expect(origin.presentationThreadId).toBe(sourceThreadId);
    expect(origin.origin).toMatchObject({
      sourceThreadId,
      sourceRunId: sourceRun.id,
      sourceMessageId: "outer-receipt",
    });

    // A plain Run keeps the same-Thread default.
    expect(await interventionOriginForRun(prisma, sourceRun)).toEqual({});
  });

  it("projects an approval into the origin Thread and resumes from there", async () => {
    const sourceRun = await newSenderRun();
    const dispatched = await send(sourceRun, {
      bot_id: researcher.id,
      message: "needs approval",
      deliveryKey: "rt05-approval",
    });
    if (!dispatched.ok) throw new Error("delivery failed");
    const target = await prisma.run.update({
      where: { id: dispatched.targetRunId },
      data: {
        status: "running",
        leaseOwner: "worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: target.id, fence: 1, status: "running" },
    });

    const origin = await interventionOriginForRun(prisma, target);
    expect(origin.presentationThreadId).toBe(sourceThreadId);
    expect(origin.origin).toMatchObject({
      sourceThreadId,
      sourceRunId: sourceRun.id,
      sourceMessageId: target.originMessageId,
    });

    expect(
      await pauseRunForInput(prisma, {
        spaceId,
        threadId: target.threadId,
        botId: target.botId,
        runId: target.id,
        attemptId: attempt.id,
        leaseOwner: "worker",
        leaseFence: 1,
        gates: PAIR_GATES,
        blocks: [{ kind: "ask", text: "Which release?", status: "pending" }],
        ...origin,
      }),
    ).toBe(true);

    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: target.id } });
    expect(row.threadId).toBe(sourceThreadId);
    expect(
      await prisma.message.count({ where: { threadId: target.threadId, runId: target.id } }),
    ).toBe(2);

    const resolved = await resolveIntervention(prisma, {
      spaceId,
      threadId: sourceThreadId,
      interventionId: row.id,
      clientSubmissionId: randomUUID(),
      answeredByUserId: id,
      answer: "v2.1",
      gates: PAIR_GATES,
    });
    expect(resolved).toMatchObject({ outcome: "accepted", applied: true, resume: true });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      status: "queued",
    });
  });

  it("expires a pair Run's wait without waking the origin with a fake result", async () => {
    const sourceRun = await newSenderRun();
    const dispatched = await send(sourceRun, {
      bot_id: researcher.id,
      message: "timeout me",
      deliveryKey: "rt05-timeout",
    });
    if (!dispatched.ok) throw new Error("delivery failed");
    const target = await prisma.run.update({
      where: { id: dispatched.targetRunId },
      data: {
        status: "running",
        leaseOwner: "worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: target.id, fence: 1, status: "running" },
    });
    const origin = await interventionOriginForRun(prisma, target);
    expect(
      await pauseRunForInput(prisma, {
        spaceId,
        threadId: target.threadId,
        botId: target.botId,
        runId: target.id,
        attemptId: attempt.id,
        leaseOwner: "worker",
        leaseFence: 1,
        gates: PAIR_GATES,
        blocks: [{ kind: "ask", text: "Still there?", status: "pending" }],
        ...origin,
      }),
    ).toBe(true);
    const waiting = await prisma.run.findFirstOrThrow({ where: { id: target.id } });
    expect(waiting.status).toBe("waiting_input");
    const staleWait = new Date(waiting.waitStartedAt!.getTime() - 25 * 60 * 60_000);
    await prisma.run.update({ where: { id: target.id }, data: { waitStartedAt: staleWait } });

    const messagesBefore = await prisma.message.count({ where: { threadId: sourceThreadId } });
    const expired = await expireWaitingRuns(prisma);
    expect(expired.some((row) => row.runId === target.id)).toBe(true);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      status: "cancelled",
      error: "wait_timeout",
    });
    // Expiry is recorded where the user answered, and it is not a returned result.
    expect(await prisma.message.count({ where: { threadId: sourceThreadId } })).toBe(
      messagesBefore,
    );
  });
});
