import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  type PrismaClient,
  readSteeringCandidates,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendThreadMessage, type ThreadTarget } from "./thread-target.js";

/**
 * RT-27 route decisions against real PostgreSQL. The pure decision table lives
 * in @rakazo/core; this file proves the write path picks the same target, keeps
 * a rejection at zero writes, and stays idempotent under a replayed nonce.
 */
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("RT-27 deterministic message routing (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let actor: Actor;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("rt27_routing");
    prisma = isolated.db.prisma;
    await prisma.user.create({
      data: { id, name: "RT-27 owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "RT-27", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "RT-27" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: {
        id,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    actor = { userId: id, spaceId: id, email: `${id}@example.test`, isDeploymentOwner: true };
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  async function newBotThread(label: string, spaceId: string = id) {
    const bot = await prisma.bot.create({
      data: { spaceId, userId: id, name: `RT-27 ${label}`, color: "test" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId, userId: id, botId: bot.id },
    });
    return { botId: bot.id, threadId: thread.id, spaceId };
  }

  async function newRun(
    target: { botId: string; threadId: string; spaceId: string },
    input: {
      status: string;
      trigger?: string;
      prompt?: string;
      consumedRevision?: number | null;
    },
  ) {
    const task = await prisma.task.create({
      data: {
        spaceId: target.spaceId,
        userId: id,
        botId: target.botId,
        threadId: target.threadId,
        prompt: input.prompt ?? "Original task",
        status: input.status === "queued" ? "queued" : "queued",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: target.spaceId,
        userId: id,
        botId: target.botId,
        threadId: target.threadId,
        taskId: task.id,
        status: input.status,
        trigger: input.trigger ?? "user",
        consumedRevision: input.consumedRevision ?? null,
      },
    });
    return { task, run };
  }

  function targetOf(target: { botId: string; threadId: string; spaceId: string }): ThreadTarget {
    return {
      kind: "bot",
      botId: target.botId,
      threadId: target.threadId,
      spaceId: target.spaceId,
      bot: { computer: null },
    } as ThreadTarget;
  }

  function send(
    target: ThreadTarget,
    input: { text: string; clientNonce: string; targetTaskId?: string },
  ) {
    return sendThreadMessage(
      {
        prisma,
        events: { notify: async () => undefined } as never,
        jobs: { enqueue: async () => undefined } as never,
      },
      actor,
      target,
      input,
    );
  }

  it("steers the only eligible conversational run", async () => {
    const target = await newBotThread("single");
    const { task, run } = await newRun(target, { status: "running" });

    const result = await send(targetOf(target), {
      text: "also check the footer",
      clientNonce: "rt27-single",
    });

    const message = await prisma.message.findUniqueOrThrow({
      where: { threadId_clientNonce: { threadId: target.threadId, clientNonce: "rt27-single" } },
    });
    expect(result.runId).toBe(run.id);
    expect(result.taskId).toBe(task.id);
    expect(message.runId).toBe(run.id);
    expect(
      await prisma.steeringMessage.findUniqueOrThrow({
        where: { messageId_botId: { messageId: message.id, botId: target.botId } },
      }),
    ).toMatchObject({ runId: run.id, userId: id });
    expect(await prisma.task.count({ where: { threadId: target.threadId } })).toBe(1);
    expect(await prisma.run.count({ where: { threadId: target.threadId } })).toBe(1);
  });

  it("never steers a peer support turn", async () => {
    const target = await newBotThread("support");
    const peer = await newRun(target, { status: "running", trigger: "bot_message" });
    const groupPeer = await newRun(target, { status: "running", trigger: "message_group" });

    const result = await send(targetOf(target), {
      text: "answer me instead",
      clientNonce: "rt27-support",
    });

    expect(result.runId).not.toBe(peer.run.id);
    expect(result.runId).not.toBe(groupPeer.run.id);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: result.runId! } })).toMatchObject({
      status: "queued",
      trigger: "user",
    });
    expect(
      await prisma.steeringMessage.count({
        where: { runId: { in: [peer.run.id, groupPeer.run.id] } },
      }),
    ).toBe(0);
  });

  it("creates its own queued task and run when two runs can take steering", async () => {
    const target = await newBotThread("multiple");
    const { run: running } = await newRun(target, { status: "running" });
    const { run: queued } = await newRun(target, {
      status: "queued",
      trigger: "follow_up",
    });

    const result = await send(targetOf(target), {
      text: "which of you is right?",
      clientNonce: "rt27-multiple",
    });

    expect(result.runId).not.toBe(running.id);
    expect(result.runId).not.toBe(queued.id);
    expect(
      await prisma.steeringMessage.count({
        where: { message: { threadId: target.threadId } },
      }),
    ).toBe(0);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: result.runId! } })).toMatchObject({
      status: "queued",
      trigger: "user",
      botId: target.botId,
    });
    expect(await prisma.task.count({ where: { threadId: target.threadId } })).toBe(3);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({
      status: "queued",
    });
  });

  it("creates an independent queued run for a request in another thread", async () => {
    const direct = await newBotThread("cross-thread-source");
    // X02: the same Bot is busy in a group Thread. The direct Thread has no
    // candidate, so the request owns a queued Run and never touches that turn.
    const group = await prisma.chatGroup.create({
      data: { spaceId: id, userId: id, name: "X02 group", leadBotId: direct.botId },
    });
    await prisma.chatGroupMember.create({ data: { groupId: group.id, botId: direct.botId } });
    const groupThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, groupId: group.id },
    });
    const active = await newRun(
      { botId: direct.botId, threadId: groupThread.id, spaceId: id },
      { status: "running" },
    );

    const result = await send(targetOf(direct), {
      text: "start the interview notes",
      clientNonce: "rt27-cross-thread",
    });

    expect(result.runId).not.toBe(active.run.id);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: result.runId! } })).toMatchObject({
      threadId: direct.threadId,
      botId: direct.botId,
      status: "queued",
      trigger: "user",
    });
    expect(
      await prisma.steeringMessage.count({
        where: { message: { threadId: direct.threadId } },
      }),
    ).toBe(0);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: active.run.id } })).toMatchObject({
      status: "running",
    });
    expect(await prisma.steeringMessage.count({ where: { runId: active.run.id } })).toBe(0);
  });

  it("amends exactly the explicitly addressed task", async () => {
    const target = await newBotThread("explicit");
    const addressed = await newRun(target, { status: "running" });
    const other = await newRun(target, { status: "running" });

    const result = await send(targetOf(target), {
      text: "use the second template",
      clientNonce: "rt27-explicit",
      targetTaskId: addressed.task.id,
    });

    expect(result.taskId).toBe(addressed.task.id);
    expect(result.runId).toBe(addressed.run.id);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: addressed.task.id } })).toMatchObject(
      { revision: 2 },
    );
    expect(await prisma.task.findUniqueOrThrow({ where: { id: other.task.id } })).toMatchObject({
      revision: 1,
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: addressed.run.id } })).toMatchObject({
      consumedRevision: 1,
    });
    const message = await prisma.message.findUniqueOrThrow({
      where: { threadId_clientNonce: { threadId: target.threadId, clientNonce: "rt27-explicit" } },
    });
    expect(message).toMatchObject({ runId: addressed.run.id, role: "user" });
    expect(
      await prisma.steeringMessage.findUniqueOrThrow({
        where: { messageId_botId: { messageId: message.id, botId: target.botId } },
      }),
    ).toMatchObject({ runId: addressed.run.id });
    // No new Task/Run: the supplement is one revision on the addressed Task.
    expect(await prisma.task.count({ where: { threadId: target.threadId } })).toBe(2);
    expect(await prisma.run.count({ where: { threadId: target.threadId } })).toBe(2);
  });

  it("rejects an unknown, cross-thread, or cross-space task without writing", async () => {
    const target = await newBotThread("reject");
    const addressed = await newRun(target, { status: "running" });

    const otherThread = await newBotThread("reject-other-thread");
    const otherThreadTask = await newRun(otherThread, { status: "running" });

    const otherSpaceId = randomUUID();
    await prisma.organization.create({
      data: { id: otherSpaceId, name: "Other space", slug: otherSpaceId, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: otherSpaceId, organizationId: otherSpaceId, name: "Other space" },
    });
    const otherSpace = await newBotThread("reject-other-space", otherSpaceId);
    const otherSpaceTask = await newRun(otherSpace, { status: "running" });

    const before = {
      messages: await prisma.message.count({ where: { threadId: target.threadId } }),
      events: await prisma.event.count({ where: { threadId: target.threadId } }),
      tasks: await prisma.task.count({ where: { threadId: target.threadId } }),
      runs: await prisma.run.count({ where: { threadId: target.threadId } }),
    };

    for (const targetTaskId of [randomUUID(), otherThreadTask.task.id, otherSpaceTask.task.id]) {
      await expect(
        send(targetOf(target), {
          text: "apply this elsewhere",
          clientNonce: `rt27-reject-${targetTaskId}`,
          targetTaskId,
        }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        data: { code: "target_task_not_found" },
      });
    }

    expect(await prisma.message.count({ where: { threadId: target.threadId } })).toBe(
      before.messages,
    );
    expect(await prisma.event.count({ where: { threadId: target.threadId } })).toBe(before.events);
    expect(await prisma.task.count({ where: { threadId: target.threadId } })).toBe(before.tasks);
    expect(await prisma.run.count({ where: { threadId: target.threadId } })).toBe(before.runs);
    expect(await prisma.steeringMessage.count({ where: { botId: target.botId } })).toBe(0);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: addressed.task.id } })).toMatchObject(
      { revision: 1 },
    );
    expect(
      await prisma.task.findUniqueOrThrow({ where: { id: otherThreadTask.task.id } }),
    ).toMatchObject({ revision: 1 });
  });

  it("rejects a Task that cannot take a revision without creating a new one", async () => {
    const target = await newBotThread("not-amendable");
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: target.botId,
        threadId: target.threadId,
        prompt: "Already finished",
        status: "completed",
      },
    });
    // The Task projection and its Run disagree, so the route must not assume
    // the Task can still take an instruction.
    await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: target.botId,
        threadId: target.threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });

    await expect(
      send(targetOf(target), {
        text: "one more thing",
        clientNonce: "rt27-not-amendable",
        targetTaskId: task.id,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      data: { code: "target_task_not_amendable" },
    });

    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      revision: 1,
    });
    expect(await prisma.task.count({ where: { threadId: target.threadId } })).toBe(1);
    expect(await prisma.run.count({ where: { threadId: target.threadId } })).toBe(1);
    expect(await prisma.message.count({ where: { threadId: target.threadId } })).toBe(0);
  });

  it("replays one nonce without a second task, run, or steering", async () => {
    const target = await newBotThread("replay");
    await newRun(target, { status: "running" });

    const first = await send(targetOf(target), {
      text: "same request",
      clientNonce: "rt27-replay-steer",
    });
    const second = await send(targetOf(target), {
      text: "same request",
      clientNonce: "rt27-replay-steer",
    });
    expect(second).toMatchObject({ runId: first.runId, taskId: first.taskId });
    expect(
      await prisma.message.count({
        where: { threadId: target.threadId, clientNonce: "rt27-replay-steer" },
      }),
    ).toBe(1);
    expect(
      await prisma.steeringMessage.count({ where: { message: { threadId: target.threadId } } }),
    ).toBe(1);

    const fresh = await newBotThread("replay-new-run");
    const created = await send(targetOf(fresh), {
      text: "first request",
      clientNonce: "rt27-replay-new",
    });
    const replayed = await send(targetOf(fresh), {
      text: "first request",
      clientNonce: "rt27-replay-new",
    });
    expect(replayed).toMatchObject({ runId: created.runId, taskId: created.taskId });
    expect(await prisma.task.count({ where: { threadId: fresh.threadId } })).toBe(1);
    expect(await prisma.run.count({ where: { threadId: fresh.threadId } })).toBe(1);
  });

  it("creates one task and one run for concurrent sends with one nonce", async () => {
    const target = await newBotThread("concurrent");

    const results = await Promise.allSettled([
      send(targetOf(target), { text: "duplicate", clientNonce: "rt27-concurrent" }),
      send(targetOf(target), { text: "duplicate", clientNonce: "rt27-concurrent" }),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await prisma.message.count({ where: { threadId: target.threadId } })).toBe(1);
    expect(await prisma.task.count({ where: { threadId: target.threadId } })).toBe(1);
    expect(await prisma.run.count({ where: { threadId: target.threadId } })).toBe(1);
    expect(
      await prisma.steeringMessage.count({ where: { message: { threadId: target.threadId } } }),
    ).toBe(0);
  });

  it("writes one steering row for concurrent duplicates", async () => {
    const target = await newBotThread("concurrent-steer");
    const { run } = await newRun(target, { status: "running" });

    const results = await Promise.allSettled([
      send(targetOf(target), { text: "duplicate steering", clientNonce: "rt27-concurrent-steer" }),
      send(targetOf(target), { text: "duplicate steering", clientNonce: "rt27-concurrent-steer" }),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await prisma.message.count({ where: { threadId: target.threadId } })).toBe(1);
    expect(await prisma.steeringMessage.count({ where: { runId: run.id } })).toBe(1);
    // The duplicate never turns into a second Task or Run.
    expect(await prisma.task.count({ where: { threadId: target.threadId } })).toBe(1);
    expect(await prisma.run.count({ where: { threadId: target.threadId } })).toBe(1);
  });

  it("reads candidates in a stable order without letting it pick a winner", async () => {
    const target = await newBotThread("order");
    const first = await newRun(target, { status: "running" });
    const second = await newRun(target, { status: "queued", trigger: "follow_up" });

    const candidates = await prisma.$transaction((tx) =>
      readSteeringCandidates(tx, { threadId: target.threadId, botIds: [target.botId] }),
    );
    expect(candidates.map((candidate) => candidate.runId)).toEqual([first.run.id, second.run.id]);
    expect(candidates.every((candidate) => candidate.botId === target.botId)).toBe(true);
  });
});
