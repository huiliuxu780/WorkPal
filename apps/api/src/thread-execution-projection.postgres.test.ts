import { randomUUID } from "node:crypto";
import {
  appendEvent,
  createIsolatedPostgresDatabase,
  createThreadMessage,
  type IsolatedPostgresDatabase,
  type PrismaClient,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ThreadTarget, threadMessagePage, threadSnapshot } from "./thread-target.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

/**
 * PD-01P API evidence: a group turn dispatched to two Bots creates two Runs,
 * but the message row can only carry the first run id. The Thread history
 * projections must return both Runs of that message, from the older-page read
 * and from a full Thread reload, without leaking other Threads or Spaces.
 */
describePostgres("thread history message → Runs projection (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let target: ThreadTarget;
  let messageId: string;
  let firstRunId: string;
  let secondRunId: string;
  let foreignRunId: string;
  let foreignSpaceRunId: string;
  let pageBefore: number;

  const base = Date.parse("2026-10-22T00:00:00.000Z");

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("pd01p_api");
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
      data: {
        spaceId: id,
        userId: id,
        name: "PD group",
        kind: "standard",
        leadBotId: firstBot.id,
      },
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
      blocks: [{ kind: "text", text: "Plan and implement the fix" }],
    });
    messageId = message.id;

    const createCancelledRun = async (input: {
      botId: string;
      sourceMessageId: string;
      threadId: string;
      spaceId: string;
      createdAt: Date;
    }) => {
      const task = await prisma.task.create({
        data: {
          spaceId: input.spaceId,
          userId: id,
          botId: input.botId,
          threadId: input.threadId,
          prompt: "Plan and implement the fix",
          status: "cancelled",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: input.spaceId,
          userId: id,
          botId: input.botId,
          threadId: input.threadId,
          taskId: task.id,
          status: "cancelled",
          trigger: "user",
          sourceMessageId: input.sourceMessageId,
          createdAt: input.createdAt,
          completedAt: new Date(base + 30_000),
        },
      });
      await appendEvent(prisma, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        runId: run.id,
        type: "run.cancelled",
        payload: {},
      });
      return run;
    };

    const first = await createCancelledRun({
      botId: firstBot.id,
      sourceMessageId: message.id,
      threadId: thread.id,
      spaceId: id,
      createdAt: new Date(base),
    });
    const second = await createCancelledRun({
      botId: secondBot.id,
      sourceMessageId: message.id,
      threadId: thread.id,
      spaceId: id,
      createdAt: new Date(base + 1_000),
    });
    firstRunId = first.id;
    secondRunId = second.id;
    // Legacy compatibility: the column records only the first Run.
    await prisma.message.update({ where: { id: message.id }, data: { runId: first.id } });

    // Newer turns push the target message onto an older history page.
    await createThreadMessage(prisma, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "Follow-up one" }],
    });
    await createThreadMessage(prisma, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "Follow-up two" }],
    });
    pageBefore = message.seq + 1;

    // Isolation fixtures: same message id reachable from another Thread in the
    // same Space and from a Thread in another Space must never project here.
    // Each fixture Thread needs its own owner Bot (`threads_owner_chk`).
    const foreignAnchor = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Foreign anchor", color: "gray" },
    });
    const foreignThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: foreignAnchor.id },
    });
    foreignRunId = (
      await createCancelledRun({
        botId: firstBot.id,
        sourceMessageId: message.id,
        threadId: foreignThread.id,
        spaceId: id,
        createdAt: new Date(base + 2_000),
      })
    ).id;

    const foreignSpaceId = `${id}-foreign`;
    await prisma.space.create({
      data: { id: foreignSpaceId, organizationId: id, name: "PD foreign" },
    });
    const foreignSpaceThread = await prisma.thread.create({
      data: {
        spaceId: foreignSpaceId,
        userId: id,
        botId: (
          await prisma.bot.create({
            data: {
              spaceId: foreignSpaceId,
              userId: id,
              name: "Foreign space anchor",
              color: "gray",
            },
          })
        ).id,
      },
    });
    foreignSpaceRunId = (
      await createCancelledRun({
        botId: firstBot.id,
        sourceMessageId: message.id,
        threadId: foreignSpaceThread.id,
        spaceId: foreignSpaceId,
        createdAt: new Date(base + 3_000),
      })
    ).id;

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

  it("returns both Runs of the older-page message, including the second Bot", async () => {
    const page = await threadMessagePage({ prisma }, target, { before: pageBefore });
    expect(page.messages.map((message) => message.id)).toEqual([messageId]);

    const linked = (page.executions ?? []).filter(
      (summary) => summary.sourceMessageId === messageId,
    );
    expect(linked.map((summary) => summary.runId)).toEqual([firstRunId, secondRunId]);
    expect(linked[0]!.botId).not.toBe(linked[1]!.botId);
    // The second Bot's Run is not named by Message.runId but is still linked.
    expect(secondRunId).not.toBe(firstRunId);
    expect(linked[1]!.status).toBe("cancelled");
    expect(linked[1]!.manualRetry).toEqual({ allowed: true });
  }, 60_000);

  it("projects the same relationship on a full Thread reload", async () => {
    const first = await threadSnapshot({ prisma }, target);
    const second = await threadSnapshot({ prisma }, target);
    const runsOf = (snapshot: Awaited<ReturnType<typeof threadSnapshot>>) =>
      (snapshot.executions ?? []).filter((summary) => summary.sourceMessageId === messageId);

    expect(runsOf(second)).toEqual(runsOf(first));
    expect(runsOf(first).map((summary) => summary.runId)).toEqual([firstRunId, secondRunId]);
    // One row per Run even though the recent-terminal window and the message
    // link both reach it.
    expect(new Set(runsOf(first).map((summary) => summary.runId)).size).toBe(2);
  }, 60_000);

  it("excludes Runs from another Thread or Space that share the message id", async () => {
    const page = await threadMessagePage({ prisma }, target, { before: pageBefore });
    const ids = (page.executions ?? []).map((summary) => summary.runId);
    expect(ids).toContain(firstRunId);
    expect(ids).toContain(secondRunId);
    expect(ids).not.toContain(foreignRunId);
    expect(ids).not.toContain(foreignSpaceRunId);
  }, 60_000);
});
