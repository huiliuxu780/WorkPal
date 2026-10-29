import { randomUUID } from "node:crypto";
import {
  appendEvent,
  createIsolatedPostgresDatabase,
  createThreadMessage,
  type IsolatedPostgresDatabase,
  type PrismaClient,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ThreadTarget, threadSnapshot } from "./thread-target.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

/**
 * P1 regression for the PD-01 message-level retry entry.
 *
 * The entry lives on the triggering message and is rebuilt from the server's
 * message → Runs projection. The FIRST `threads/get` page previously projected
 * only active/asked Runs plus the 50 most recent terminals, so a cardless
 * cancelled Run fell out of the snapshot as soon as 50 later Runs terminated
 * while its triggering message stayed on the first page. A reload then showed
 * the message without its retry entry, and pagination could not restore it:
 * the message was already loaded, so `threads/messages` never returned it.
 *
 * The fixture keeps the triggering message inside the initial 100-message page
 * and pushes the two linked Runs outside the 50-row terminal window, then reads
 * the same `threads/get` snapshot the Web uses on reload.
 */
describePostgres("thread snapshot keeps message-linked Runs outside the terminal window", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let target: ThreadTarget;
  let messageId: string;
  let firstRunId: string;
  let secondRunId: string;
  let overflowedRunId: string;

  const base = Date.parse("2026-10-29T00:00:00.000Z");

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("pd01_window");
    prisma = isolated.db.prisma;

    await prisma.user.create({
      data: { id, name: "PD owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "PD org", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "PD space" } });
    await prisma.member.create({
      data: { id: `${id}-m`, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: {
        id: `${id}-sm`,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });

    const firstBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Planner", color: "blue" },
    });
    const secondBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Coder", color: "green" },
    });
    const group = await prisma.chatGroup.create({
      data: { spaceId: id, userId: id, name: "PD group", leadBotId: firstBot.id },
    });
    await prisma.chatGroupMember.createMany({
      data: [
        { groupId: group.id, botId: firstBot.id },
        { groupId: group.id, botId: secondBot.id },
      ],
    });
    const thread = await prisma.thread.create({
      data: { spaceId: id, userId: id, groupId: group.id },
    });

    const message = await createThreadMessage(prisma, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "Draft and send the weekly update" }],
    });
    messageId = message.id;

    const cancelledRun = async (botId: string, createdAt: Date) => {
      const task = await prisma.task.create({
        data: {
          spaceId: id,
          userId: id,
          botId,
          threadId: thread.id,
          prompt: "Draft and send the weekly update",
          status: "cancelled",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: id,
          userId: id,
          botId,
          threadId: thread.id,
          taskId: task.id,
          status: "cancelled",
          trigger: "user",
          sourceMessageId: message.id,
          createdAt,
          completedAt: new Date(base + 30_000),
        },
      });
      await appendEvent(prisma, {
        spaceId: id,
        threadId: thread.id,
        botId,
        runId: run.id,
        type: "run.cancelled",
        payload: {},
      });
      return run;
    };

    firstRunId = (await cancelledRun(firstBot.id, new Date(base))).id;
    secondRunId = (await cancelledRun(secondBot.id, new Date(base + 1_000))).id;
    // The legacy column only ever names the first Run of the message.
    await prisma.message.update({ where: { id: message.id }, data: { runId: firstRunId } });

    // 55 newer terminal Runs: the two linked Runs leave the 50-row window and
    // the oldest flood Run must be absent from the snapshot, proving the
    // overflow is real rather than incidental.
    for (let index = 0; index < 55; index += 1) {
      const at = new Date(base + 60_000 + index * 1_000);
      const task = await prisma.task.create({
        data: {
          spaceId: id,
          userId: id,
          botId: firstBot.id,
          threadId: thread.id,
          prompt: `later turn ${index}`,
          status: "completed",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: id,
          userId: id,
          botId: firstBot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "completed",
          trigger: "user",
          createdAt: at,
          completedAt: at,
        },
      });
      if (index === 0) overflowedRunId = run.id;
    }

    target = {
      kind: "group",
      groupId: group.id,
      groupName: group.name,
      threadId: thread.id,
      spaceId: id,
      leadBotId: firstBot.id,
      members: [
        { botId: firstBot.id, name: firstBot.name, color: firstBot.color },
        { botId: secondBot.id, name: secondBot.name, color: secondBot.color },
      ],
      memberBotIds: [firstBot.id, secondBot.id],
    };
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  it("keeps both Runs of the triggering message on the initial snapshot", async () => {
    const snapshot = await threadSnapshot({ prisma }, target);
    const runIds = (snapshot.executions ?? []).map((summary) => summary.runId);

    // Preconditions: the message is on the first page and the window overflowed.
    expect(snapshot.messages.map((message) => message.id)).toContain(messageId);
    expect(snapshot.recentRuns).toHaveLength(50);
    expect(runIds).not.toContain(overflowedRunId);

    // The regression: both linked Runs survive the reload through sourceMessageId,
    // even though neither is in the terminal window and the second Bot is not
    // named by `Message.runId`.
    const linked = (snapshot.executions ?? []).filter(
      (summary) => summary.sourceMessageId === messageId,
    );
    expect(linked.map((summary) => summary.runId)).toEqual([firstRunId, secondRunId]);
    expect(linked.every((summary) => summary.status === "cancelled")).toBe(true);
    expect(linked.every((summary) => summary.manualRetry?.allowed === true)).toBe(true);
  }, 60_000);
});
