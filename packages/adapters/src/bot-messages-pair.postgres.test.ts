import { randomUUID } from "node:crypto";
import { resolveRoundtableFeatureGates } from "@rakazo/core";
import {
  CHAT_GROUP_KIND_AGENT_PAIR,
  cancelChildrenOfCancelledRuns,
  cancelRunsInTransaction,
  computerHomeKey,
  computerScopeKey,
  createIsolatedPostgresDatabase,
  createManualRetryRun,
  createThreadMessageInTransaction,
  createThreadPolicy,
  expireWaitingRuns,
  type IsolatedPostgresDatabase,
  ManualRetryDenied,
  type PrismaClient,
  pauseRunForInput,
  pauseRunForTakeover,
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

  it("returns an explicit live result through the persisted origin while the run is running", async () => {
    const sourceRun = await newSenderRun();
    const dispatched = await send(sourceRun, {
      bot_id: researcher.id,
      message: "collect the numbers",
      deliveryKey: "rt05-live-result",
    });
    if (!dispatched.ok) throw new Error("delivery failed");
    // Live: the delegated Run claimed and is still working when it answers.
    const pairRun = await prisma.run.update({
      where: { id: dispatched.targetRunId },
      data: { status: "running" },
    });

    const liveRun = {
      id: pairRun.id,
      spaceId,
      threadId: pairRun.threadId,
      botId: pairRun.botId,
      userId: id,
      sourceMessageId: pairRun.sourceMessageId,
      originThreadId: pairRun.originThreadId,
      originRunId: pairRun.originRunId,
      originMessageId: pairRun.originMessageId,
    };
    const replied = await messageBot(
      deps(),
      liveRun,
      researcher,
      {
        bot_id: sender.id,
        message: "The numbers are in.",
        intent: "result",
        deliveryKey: "rt05-live-result-reply",
      },
      { allowTerminalSource: true },
    );
    expect(replied).toMatchObject({ ok: true, botId: sender.id });
    if (!replied.ok) throw new Error("live explicit result failed");

    // The requester is woken in its own visible Thread with the real answer.
    const wake = await prisma.message.findFirstOrThrow({
      where: { threadId: sourceThreadId, clientNonce: "bot-message:rt05-live-result-reply" },
    });
    expect(wake.role).toBe("user");
    expect(wake.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_received",
        fromBotId: researcher.id,
        text: "The numbers are in.",
        intent: "result",
      }),
    ]);

    // Idempotent: the same delivery key replays the recorded reply.
    const replay = await messageBot(
      deps(),
      liveRun,
      researcher,
      {
        bot_id: sender.id,
        message: "The numbers are in.",
        intent: "result",
        deliveryKey: "rt05-live-result-reply",
      },
      { allowTerminalSource: true },
    );
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(
      await prisma.message.count({
        where: { threadId: sourceThreadId, clientNonce: "bot-message:rt05-live-result-reply" },
      }),
    ).toBe(1);
  });

  it("suppresses the automatic outcome return after an explicit live result", async () => {
    const sourceRun = await newSenderRun();
    const dispatched = await send(sourceRun, {
      bot_id: researcher.id,
      message: "draft the summary",
      deliveryKey: "rt05-live-suppress",
    });
    if (!dispatched.ok) throw new Error("delivery failed");
    const pairRun = await prisma.run.update({
      where: { id: dispatched.targetRunId },
      data: { status: "running" },
    });
    const replied = await messageBot(
      deps(),
      {
        id: pairRun.id,
        spaceId,
        threadId: pairRun.threadId,
        botId: pairRun.botId,
        userId: id,
        sourceMessageId: pairRun.sourceMessageId,
        originThreadId: pairRun.originThreadId,
        originRunId: pairRun.originRunId,
        originMessageId: pairRun.originMessageId,
      },
      researcher,
      {
        bot_id: sender.id,
        message: "Summary drafted.",
        intent: "result",
        deliveryKey: "rt05-live-suppress-reply",
      },
      { allowTerminalSource: true },
    );
    expect(replied).toMatchObject({ ok: true });

    await prisma.run.update({
      where: { id: pairRun.id },
      data: { status: "completed", completedAt: new Date() },
    });
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
      "The final wrap-up.",
    );
    expect(returned).toBe(true);
    expect(
      await prisma.message.count({
        where: { threadId: sourceThreadId, clientNonce: `bot-message:auto-outcome:${pairRun.id}` },
      }),
    ).toBe(0);
  });

  it("keeps the automatic outcome return after an interim live status", async () => {
    const sourceRun = await newSenderRun();
    const dispatched = await send(sourceRun, {
      bot_id: researcher.id,
      message: "start the export",
      deliveryKey: "rt05-live-status",
    });
    if (!dispatched.ok) throw new Error("delivery failed");
    const pairRun = await prisma.run.update({
      where: { id: dispatched.targetRunId },
      data: { status: "running" },
    });
    const liveRun = {
      id: pairRun.id,
      spaceId,
      threadId: pairRun.threadId,
      botId: pairRun.botId,
      userId: id,
      sourceMessageId: pairRun.sourceMessageId,
      originThreadId: pairRun.originThreadId,
      originRunId: pairRun.originRunId,
      originMessageId: pairRun.originMessageId,
    };
    const status = await messageBot(
      deps(),
      liveRun,
      researcher,
      {
        bot_id: sender.id,
        message: "Export is halfway through.",
        intent: "status",
        deliveryKey: "rt05-live-status-reply",
      },
      { allowTerminalSource: true },
    );
    expect(status).toMatchObject({ ok: true });
    const statusWake = await prisma.message.findFirstOrThrow({
      where: { threadId: sourceThreadId, clientNonce: "bot-message:rt05-live-status-reply" },
    });
    expect(statusWake.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_received", intent: "status" }),
    ]);

    // An interim status must not suppress the automatic final return.
    await prisma.run.update({
      where: { id: pairRun.id },
      data: { status: "completed", completedAt: new Date() },
    });
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
      "The export finished.",
    );
    expect(returned).toBe(true);
    const finalWake = await prisma.message.findFirstOrThrow({
      where: { threadId: sourceThreadId, clientNonce: `bot-message:auto-outcome:${pairRun.id}` },
    });
    expect(finalWake.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_received", intent: "result" }),
    ]);
  });

  it("keeps a proactive result on the pair path while private_pair is enabled", async () => {
    // A user-started run with no origin sends an explicit result: the
    // terminal-source exception must not leak it into the target's legacy DM.
    const run = await newSenderRun();
    const sent = await messageBot(deps(), run, sender, {
      bot_id: writer.id,
      message: "Nightly result: all green.",
      intent: "result",
      deliveryKey: "rt05-proactive-result",
    });
    expect(sent).toMatchObject({ ok: true, botId: writer.id });
    if (!sent.ok) throw new Error("proactive result failed");

    // Delivered into the sender ↔ writer pair Thread, not the writer's DM.
    expect(await prisma.message.count({ where: { threadId: await threadOf(writer.id) } })).toBe(0);
    const groups = await pairGroups(sender.id, writer.id);
    expect(groups).toHaveLength(1);
    const pairThreadId = groups[0]!.thread!.id;
    const pairMessages = await prisma.message.findMany({
      where: { threadId: pairThreadId, runId: run.id },
      orderBy: { seq: "asc" },
    });
    expect(pairMessages.map((message) => message.role)).toEqual(["bot"]);
    expect(pairMessages[0]!.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_sent",
        toBotId: writer.id,
        text: "Nightly result: all green.",
        intent: "result",
      }),
    ]);
    const inbound = await prisma.message.findFirstOrThrow({
      where: { threadId: pairThreadId, clientNonce: "bot-message:rt05-proactive-result" },
    });
    expect(inbound.role).toBe("user");
    expect(inbound.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_received",
        fromBotId: sender.id,
        intent: "result",
      }),
    ]);
  });

  it("routes an origin run's reply to a different bot through the pair path", async () => {
    const sourceRun = await newSenderRun();
    const dispatched = await send(sourceRun, {
      bot_id: researcher.id,
      message: "prepare the export",
      deliveryKey: "rt05-third-bot",
    });
    if (!dispatched.ok) throw new Error("delivery failed");
    const pairRun = await prisma.run.update({
      where: { id: dispatched.targetRunId },
      data: { status: "running" },
    });

    // The delegated run messages a THIRD bot: not a verified origin reply, so
    // this is a new private delivery into its own pair, never the legacy DM.
    const sent = await messageBot(
      deps(),
      {
        id: pairRun.id,
        spaceId,
        threadId: pairRun.threadId,
        botId: pairRun.botId,
        userId: id,
        sourceMessageId: pairRun.sourceMessageId,
        originThreadId: pairRun.originThreadId,
        originRunId: pairRun.originRunId,
        originMessageId: pairRun.originMessageId,
      },
      researcher,
      {
        bot_id: writer.id,
        message: "Need the archive numbers for the export.",
        intent: "request",
        deliveryKey: "rt05-third-bot-request",
      },
      { allowTerminalSource: true },
    );
    expect(sent).toMatchObject({ ok: true, botId: writer.id });
    if (!sent.ok) throw new Error("third-bot delivery failed");

    // A new researcher ↔ writer pair appeared; the origin Thread got nothing.
    const groups = await pairGroups(researcher.id, writer.id);
    expect(groups).toHaveLength(1);
    const thirdPairThreadId = groups[0]!.thread!.id;
    expect(thirdPairThreadId).not.toBe(pairRun.threadId);
    expect(
      await prisma.message.count({
        where: { threadId: sourceThreadId, clientNonce: "bot-message:rt05-third-bot-request" },
      }),
    ).toBe(0);
    const inbound = await prisma.message.findFirstOrThrow({
      where: { threadId: thirdPairThreadId, role: "user" },
    });
    expect(inbound.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_received",
        fromBotId: researcher.id,
        intent: "request",
      }),
    ]);
  });

  /** A → B → C: deliver, delegate, and return C's outcome to resume B. */
  async function nestedChain(deliveryKey: string) {
    const sourceRun = await newSenderRun();
    const toB = await send(sourceRun, {
      bot_id: researcher.id,
      message: "produce the report",
      deliveryKey: `${deliveryKey}-ab`,
    });
    if (!toB.ok) throw new Error("A→B delivery failed");
    const runB = await prisma.run.update({
      where: { id: toB.targetRunId },
      data: { status: "running" },
    });
    const toC = await messageBot(
      deps(),
      {
        id: runB.id,
        spaceId,
        threadId: runB.threadId,
        botId: runB.botId,
        userId: id,
        sourceMessageId: runB.sourceMessageId,
        originThreadId: runB.originThreadId,
        originRunId: runB.originRunId,
        originMessageId: runB.originMessageId,
      },
      researcher,
      {
        bot_id: writer.id,
        message: "collect the appendix",
        intent: "request",
        deliveryKey: `${deliveryKey}-bc`,
      },
    );
    if (!toC.ok || !("targetRunId" in toC)) throw new Error("B→C delivery failed");
    const runC = await prisma.run.update({
      where: { id: toC.targetRunId },
      data: { status: "completed", completedAt: new Date() },
    });
    // C returns: B resumes in the A↔B pair Thread with the nested origin.
    const returned = await returnBotMessageOutcome(
      {
        prisma,
        events: { notify: vi.fn(async () => undefined) },
        jobs: { enqueue: vi.fn(async () => undefined) },
      } as unknown as Parameters<typeof returnBotMessageOutcome>[0],
      {
        id: runC.id,
        spaceId,
        threadId: runC.threadId,
        botId: runC.botId,
        userId: id,
        sourceMessageId: runC.sourceMessageId,
        orchestration: runC.orchestration,
        originThreadId: runC.originThreadId,
        originRunId: runC.originRunId,
        originMessageId: runC.originMessageId,
      },
      writer,
      "Appendix collected.",
    );
    expect(returned).toBe(true);
    const resumedB = await prisma.run.findFirstOrThrow({
      where: { sourceMessageId: { not: null }, botId: researcher.id, trigger: "bot_message" },
      orderBy: { createdAt: "desc" },
    });
    expect(resumedB).toMatchObject({
      threadId: runB.threadId,
      originThreadId: runB.threadId,
      originRunId: runB.id,
    });
    return { sourceRun, runB, runC, resumedB };
  }

  it("returns a nested run's explicit result to the original visible Thread", async () => {
    const { runB, resumedB } = await nestedChain("rt05-nested-explicit");
    const liveResumed = await prisma.run.update({
      where: { id: resumedB.id },
      data: { status: "running" },
    });

    const replied = await messageBot(
      deps(),
      {
        id: liveResumed.id,
        spaceId,
        threadId: liveResumed.threadId,
        botId: liveResumed.botId,
        userId: id,
        sourceMessageId: liveResumed.sourceMessageId,
        originThreadId: liveResumed.originThreadId,
        originRunId: liveResumed.originRunId,
        originMessageId: liveResumed.originMessageId,
      },
      researcher,
      {
        bot_id: sender.id,
        message: "The report is ready: growth is flat.",
        intent: "result",
        deliveryKey: "rt05-nested-explicit-reply",
      },
      { allowTerminalSource: true },
    );
    expect(replied).toMatchObject({ ok: true, botId: sender.id });
    if (!replied.ok) throw new Error("nested explicit result failed");

    // The answer lands in A's visible chat — walked through the nested origin
    // — not as another pair-side delivery.
    const wake = await prisma.message.findFirstOrThrow({
      where: { threadId: sourceThreadId, clientNonce: "bot-message:rt05-nested-explicit-reply" },
    });
    expect(wake.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_received",
        fromBotId: researcher.id,
        text: "The report is ready: growth is flat.",
        intent: "result",
      }),
    ]);
    expect(await pairGroups(sender.id, researcher.id)).toHaveLength(1);
    // The pair-side copy carries the explicit result for later suppression.
    const pairCopy = await prisma.message.findFirstOrThrow({
      where: { threadId: runB.threadId, runId: liveResumed.id, role: "bot" },
    });
    expect(pairCopy.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_sent", intent: "result" }),
    ]);
  });

  it("returns a nested run's automatic outcome to the original visible Thread", async () => {
    const { resumedB } = await nestedChain("rt05-nested-auto");
    await prisma.run.update({
      where: { id: resumedB.id },
      data: { status: "completed", completedAt: new Date() },
    });
    const returned = await returnBotMessageOutcome(
      {
        prisma,
        events: { notify: vi.fn(async () => undefined) },
        jobs: { enqueue: vi.fn(async () => undefined) },
      } as unknown as Parameters<typeof returnBotMessageOutcome>[0],
      {
        id: resumedB.id,
        spaceId,
        threadId: resumedB.threadId,
        botId: resumedB.botId,
        userId: id,
        sourceMessageId: resumedB.sourceMessageId,
        orchestration: resumedB.orchestration,
        originThreadId: resumedB.originThreadId,
        originRunId: resumedB.originRunId,
        originMessageId: resumedB.originMessageId,
      },
      researcher,
      "The final report body.",
    );
    expect(returned).toBe(true);
    const wake = await prisma.message.findFirstOrThrow({
      where: { threadId: sourceThreadId, clientNonce: `bot-message:auto-outcome:${resumedB.id}` },
    });
    expect(wake.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_received",
        fromBotId: researcher.id,
        text: "The final report body.",
        intent: "result",
      }),
    ]);
  });

  it("hops nested outcomes one requester at a time until the visible Thread", async () => {
    // A → B(researcher) → C(writer) → D(fixer): each return climbs exactly one
    // generation — C's outcome wakes B in the A↔B pair, B's outcome wakes A in
    // the visible chat — and never bounces back down the chain.
    const fixerBot = await prisma.bot.create({
      data: { spaceId, userId: id, name: "Fixer", color: "test" },
    });
    await prisma.thread.create({ data: { spaceId, userId: id, botId: fixerBot.id } });
    const fixer = { id: fixerBot.id, name: fixerBot.name };

    const sourceRun = await newSenderRun();
    const toB = await send(sourceRun, {
      bot_id: researcher.id,
      message: "own the report",
      deliveryKey: "rt05-4l-ab",
    });
    if (!toB.ok) throw new Error("A→B failed");
    const runB = await prisma.run.update({
      where: { id: toB.targetRunId },
      data: { status: "running" },
    });
    const toC = await messageBot(
      deps(),
      {
        id: runB.id,
        spaceId,
        threadId: runB.threadId,
        botId: runB.botId,
        userId: id,
        sourceMessageId: runB.sourceMessageId,
        originThreadId: runB.originThreadId,
        originRunId: runB.originRunId,
        originMessageId: runB.originMessageId,
      },
      researcher,
      {
        bot_id: writer.id,
        message: "collect the data",
        intent: "request",
        deliveryKey: "rt05-4l-bc",
      },
    );
    if (!toC.ok || !("targetRunId" in toC)) throw new Error("B→C failed");
    const runC = await prisma.run.update({
      where: { id: toC.targetRunId },
      data: { status: "running" },
    });
    const toD = await messageBot(
      deps(),
      {
        id: runC.id,
        spaceId,
        threadId: runC.threadId,
        botId: runC.botId,
        userId: id,
        sourceMessageId: runC.sourceMessageId,
        originThreadId: runC.originThreadId,
        originRunId: runC.originRunId,
        originMessageId: runC.originMessageId,
      },
      writer,
      {
        bot_id: fixer.id,
        message: "verify the numbers",
        intent: "request",
        deliveryKey: "rt05-4l-cd",
      },
    );
    if (!toD.ok || !("targetRunId" in toD)) throw new Error("C→D failed");
    const runD = await prisma.run.update({
      where: { id: toD.targetRunId },
      data: { status: "completed", completedAt: new Date() },
    });

    const outcomeDeps = {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof returnBotMessageOutcome>[0];
    const asRun = (row: {
      id: string;
      threadId: string;
      botId: string;
      sourceMessageId: string | null;
      orchestration: unknown;
      originThreadId: string | null;
      originRunId: string | null;
      originMessageId: string | null;
    }) => ({
      id: row.id,
      spaceId,
      threadId: row.threadId,
      botId: row.botId,
      userId: id,
      sourceMessageId: row.sourceMessageId,
      orchestration: row.orchestration,
      originThreadId: row.originThreadId,
      originRunId: row.originRunId,
      originMessageId: row.originMessageId,
    });

    // D returns to C: the wake lands in C's execution pair (B↔C).
    expect(
      await returnBotMessageOutcome(outcomeDeps, asRun(runD), fixer, "Numbers verified."),
    ).toBe(true);
    const wakeD = await prisma.message.findFirstOrThrow({
      where: { threadId: runC.threadId, clientNonce: `bot-message:auto-outcome:${runD.id}` },
    });
    expect(wakeD.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_received", fromBotId: fixer.id }),
    ]);
    const resumedC = await prisma.run.findFirstOrThrow({
      where: { sourceMessageId: wakeD.id },
    });

    // C resumes and completes: its outcome climbs one generation to B —
    // delivered into the A↔B pair, never sideways into C's own pair copy.
    await prisma.run.update({
      where: { id: resumedC.id },
      data: { status: "completed", completedAt: new Date() },
    });
    expect(
      await returnBotMessageOutcome(outcomeDeps, asRun(resumedC), writer, "Data collected."),
    ).toBe(true);
    const wakeC = await prisma.message.findFirstOrThrow({
      where: { threadId: runB.threadId, clientNonce: `bot-message:auto-outcome:${resumedC.id}` },
    });
    expect(wakeC.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_received", fromBotId: writer.id }),
    ]);
    expect(resumedC.originThreadId).toBe(runC.threadId);
    expect(
      await prisma.message.count({
        where: {
          threadId: resumedC.threadId,
          clientNonce: `bot-message:auto-outcome:${resumedC.id}`,
        },
      }),
    ).toBe(0);
    const resumedB = await prisma.run.findFirstOrThrow({
      where: { sourceMessageId: wakeC.id },
    });
    expect(resumedB).toMatchObject({ botId: researcher.id, threadId: runB.threadId });

    // B resumes and completes: its outcome reaches A's visible chat — the end
    // of the routing (no further hop, no bounce back to C).
    await prisma.run.update({
      where: { id: resumedB.id },
      data: { status: "completed", completedAt: new Date() },
    });
    expect(
      await returnBotMessageOutcome(outcomeDeps, asRun(resumedB), researcher, "Report owned."),
    ).toBe(true);
    const wakeB = await prisma.message.findFirstOrThrow({
      where: { threadId: sourceThreadId, clientNonce: `bot-message:auto-outcome:${resumedB.id}` },
    });
    expect(wakeB.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_received", fromBotId: researcher.id }),
    ]);
    for (const run of [runD, resumedC, resumedB]) {
      expect(
        (await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).botOutcomeReturnedAt,
      ).not.toBeNull();
    }
    expect(
      await prisma.message.count({
        where: {
          threadId: runC.threadId,
          clientNonce: { startsWith: "bot-message:auto-outcome:" },
        },
      }),
    ).toBe(1);
  });

  it("skips same-bot resumptions and restores the recipient's policy", async () => {
    // A → B, B → C, C returns (B resumes), B re-delegates to C again, C
    // returns (B resumes once more). B's final outcome must skip its own
    // earlier runs and reach A in the visible chat, with A's resumed Run
    // keeping the owner policy — not C's support policy.
    const sourceRun = await newSenderRun();
    const toB = await send(sourceRun, {
      bot_id: researcher.id,
      message: "iterate the draft",
      deliveryKey: "rt05-seq-ab",
    });
    if (!toB.ok) throw new Error("A→B failed");
    const asRun = (row: {
      id: string;
      threadId: string;
      botId: string;
      sourceMessageId: string | null;
      orchestration: unknown;
      originThreadId: string | null;
      originRunId: string | null;
      originMessageId: string | null;
    }) => ({
      id: row.id,
      spaceId,
      threadId: row.threadId,
      botId: row.botId,
      userId: id,
      sourceMessageId: row.sourceMessageId,
      orchestration: row.orchestration,
      originThreadId: row.originThreadId,
      originRunId: row.originRunId,
      originMessageId: row.originMessageId,
    });
    const outcomeDeps = {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof returnBotMessageOutcome>[0];
    const delegateFrom = async (
      run: Awaited<ReturnType<typeof prisma.run.findUniqueOrThrow>>,
      targetBotId: string,
      key: string,
    ) => {
      const sent = await messageBot(
        deps(),
        asRun(run),
        { id: run.botId, name: run.botId === researcher.id ? "Researcher" : "Writer" },
        { bot_id: targetBotId, message: "another pass", intent: "request", deliveryKey: key },
      );
      if (!sent.ok || !("targetRunId" in sent)) throw new Error(`delegation failed: ${key}`);
      return sent.targetRunId;
    };

    const runB1 = await prisma.run.update({
      where: { id: toB.targetRunId },
      data: { status: "running" },
    });
    const child1 = await delegateFrom(runB1, writer.id, "rt05-seq-b1c");
    const child1Run = await prisma.run.update({
      where: { id: child1 },
      data: { status: "completed", completedAt: new Date() },
    });
    expect(
      await returnBotMessageOutcome(
        outcomeDeps,
        asRun(child1Run),
        writer,
        "First pass done.",
      ),
    ).toBe(true);
    const b2 = await prisma.run.findFirstOrThrow({
      where: { botId: researcher.id, trigger: "bot_message" },
      orderBy: { createdAt: "desc" },
    });
    await prisma.run.update({ where: { id: b2.id }, data: { status: "running" } });

    const child2 = await delegateFrom(b2, writer.id, "rt05-seq-b2c");
    const child2Run = await prisma.run.update({
      where: { id: child2 },
      data: { status: "completed", completedAt: new Date() },
    });
    expect(
      await returnBotMessageOutcome(
        outcomeDeps,
        asRun(child2Run),
        writer,
        "Second pass done.",
      ),
    ).toBe(true);
    const b3 = await prisma.run.findFirstOrThrow({
      where: { botId: researcher.id, trigger: "bot_message" },
      orderBy: { createdAt: "desc" },
    });
    await prisma.run.update({
      where: { id: b3.id },
      data: { status: "completed", completedAt: new Date() },
    });

    // B's final outcome skips B's own resumption chain and reaches A.
    expect(
      await returnBotMessageOutcome(outcomeDeps, asRun(b3), researcher, "Draft iterated."),
    ).toBe(true);
    const wake = await prisma.message.findFirstOrThrow({
      where: { threadId: sourceThreadId, clientNonce: `bot-message:auto-outcome:${b3.id}` },
    });
    expect(wake.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_received",
        fromBotId: researcher.id,
        intent: "result",
      }),
    ]);
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: b3.id } })).botOutcomeReturnedAt,
    ).not.toBeNull();

    // A's resumed Run keeps the requester's owner policy, not C's support.
    const resumedA = await prisma.run.findFirstOrThrow({
      where: { sourceMessageId: wake.id },
    });
    expect(resumedA.botId).toBe(sender.id);
    expect(resumedA.threadId).toBe(sourceThreadId);
    const orchestration = JSON.stringify(resumedA.orchestration);
    expect(orchestration).toContain('"owner"');
    expect(orchestration).not.toContain('"support"');
  });

  it("routes a proactive cross-chain result to a new pair instead of upstream", async () => {
    // A→B→C while C is still working on B's REQUEST: C proactively sends a
    // result to A. C was not resumed by a child outcome, so this is a new
    // C↔A private delivery — never the nested origin_outcome return.
    const sourceRun = await newSenderRun();
    const toB = await send(sourceRun, {
      bot_id: researcher.id,
      message: "coordinate the export",
      deliveryKey: "rt05-proactive-ab",
    });
    if (!toB.ok) throw new Error("A→B failed");
    const runB = await prisma.run.update({
      where: { id: toB.targetRunId },
      data: { status: "running" },
    });
    const toC = await messageBot(
      deps(),
      {
        id: runB.id,
        spaceId,
        threadId: runB.threadId,
        botId: runB.botId,
        userId: id,
        sourceMessageId: runB.sourceMessageId,
        originThreadId: runB.originThreadId,
        originRunId: runB.originRunId,
        originMessageId: runB.originMessageId,
      },
      researcher,
      {
        bot_id: writer.id,
        message: "collect the numbers",
        intent: "request",
        deliveryKey: "rt05-proactive-bc",
      },
    );
    if (!toC.ok || !("targetRunId" in toC)) throw new Error("B→C failed");
    const runC = await prisma.run.update({
      where: { id: toC.targetRunId },
      data: { status: "running" },
    });

    // C's explicit result addressed at A: an ordinary C↔A pair delivery.
    const sent = await messageBot(
      deps(),
      {
        id: runC.id,
        spaceId,
        threadId: runC.threadId,
        botId: runC.botId,
        userId: id,
        sourceMessageId: runC.sourceMessageId,
        originThreadId: runC.originThreadId,
        originRunId: runC.originRunId,
        originMessageId: runC.originMessageId,
      },
      writer,
      {
        bot_id: sender.id,
        message: "Heads up: the numbers look wrong.",
        intent: "result",
        deliveryKey: "rt05-proactive-ca",
      },
      { allowTerminalSource: true },
    );
    expect(sent).toMatchObject({ ok: true, botId: sender.id });
    if (!sent.ok) throw new Error("C→A proactive delivery failed");

    // The delivery created a dedicated writer ↔ sender pair; A's visible chat
    // received no wake for this key (no upstream origin_outcome), and the
    // B↔C execution pair was not reused.
    const groups = await pairGroups(writer.id, sender.id);
    expect(groups).toHaveLength(1);
    const caThreadId = groups[0]!.thread!.id;
    expect(caThreadId).not.toBe(runC.threadId);
    const inbound = await prisma.message.findFirstOrThrow({
      where: { threadId: caThreadId, clientNonce: "bot-message:rt05-proactive-ca" },
    });
    expect(inbound.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_received",
        fromBotId: writer.id,
        intent: "result",
      }),
    ]);
    expect(
      await prisma.message.count({
        where: { threadId: sourceThreadId, clientNonce: "bot-message:rt05-proactive-ca" },
      }),
    ).toBe(0);
    expect(
      await prisma.message.count({
        where: { threadId: runC.threadId, clientNonce: "bot-message:rt05-proactive-ca" },
      }),
    ).toBe(0);
  });

  it("projects a delegated takeover request into the visible origin", async () => {
    // A delegated run's request_takeover must reach A's chat: the waiting
    // event lands in the persisted visible origin, while the run and the
    // computer control stay bound to the hidden execution run.
    const sourceRun = await newSenderRun();
    const dispatched = await send(sourceRun, {
      bot_id: researcher.id,
      message: "drive the browser",
      deliveryKey: "rt05-takeover",
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
    const computer = await prisma.computer.create({
      data: {
        spaceId,
        userId: id,
        scope: "team",
        scopeKey: computerScopeKey("team", spaceId),
        homeKey: computerHomeKey("team", spaceId),
        kind: "sandbox",
      },
    });

    const origin = await interventionOriginForRun(prisma, target);
    expect(origin.presentationThreadId).toBe(sourceThreadId);

    expect(
      await pauseRunForTakeover(prisma, {
        spaceId,
        threadId: target.threadId,
        botId: target.botId,
        runId: target.id,
        attemptId: attempt.id,
        leaseOwner: "worker",
        leaseFence: 1,
        reason: "Finish the login on the screen",
        computerId: computer.id,
        presentationThreadId: origin.presentationThreadId,
      }),
    ).toBe(true);

    // The waiting event and its notification target the user-visible chat.
    const waitingEvent = await prisma.event.findFirstOrThrow({
      where: { runId: target.id, type: "computer.takeover.requested" },
    });
    expect(waitingEvent.threadId).toBe(sourceThreadId);
    // The run waits in its hidden execution pair; the computer control is
    // bound to that execution run, not to anything in the visible chat.
    const waiting = await prisma.run.findUniqueOrThrow({ where: { id: target.id } });
    expect(waiting.status).toBe("waiting_takeover");
    expect(waiting.threadId).toBe(target.threadId);
    const bound = await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } });
    expect(bound.controlRunId).toBe(target.id);
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
