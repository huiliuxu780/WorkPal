import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acknowledgeAvatarFailure, loadBotAvatarStates } from "./avatar-activity.js";
import { clearThread } from "./events.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("Bot avatar state projection (PostgreSQL)", () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const spaceId = randomUUID();
  const otherSpaceId = randomUUID();
  let isolated: IsolatedPostgresDatabase;
  let botId: string;
  let threadId: string;

  const viewer = { userId, spaceId };
  const db = () => isolated.db.prisma;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("avatar_activity");
    const prisma = db();
    for (const id of [userId, otherUserId]) {
      await prisma.user.create({
        data: { id, name: "Avatar viewer", email: `${id}@example.test` },
      });
    }
    await prisma.organization.create({
      data: { id: spaceId, name: "Avatar", slug: spaceId, createdAt: new Date() },
    });
    for (const id of [spaceId, otherSpaceId]) {
      await prisma.space.create({ data: { id, organizationId: spaceId, name: "Avatar" } });
    }
    const bot = await prisma.bot.create({ data: { spaceId, userId, name: "One", color: "#fff" } });
    botId = bot.id;
    threadId = (await prisma.thread.create({ data: { spaceId, userId, botId } })).id;
    const foreign = await prisma.bot.create({
      data: { spaceId: otherSpaceId, userId: otherUserId, name: "Foreign", color: "#fff" },
    });
    await prisma.thread.create({
      data: { spaceId: otherSpaceId, userId: otherUserId, botId: foreign.id },
    });
  });

  afterAll(async () => isolated?.drop());

  async function run(status: string) {
    const task = await db().task.create({
      data: { spaceId, userId, botId, threadId, prompt: "Avatar test", status: "running" },
    });
    return db().run.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId,
        taskId: task.id,
        status,
        trigger: "user",
        ...(status === "failed" ? { completedAt: new Date() } : {}),
      },
    });
  }

  it("uses persisted multi-Run priority; generic thread read does not acknowledge failure", async () => {
    const work = await run("running");
    expect(await loadBotAvatarStates(db(), viewer)).toMatchObject([
      { botId, state: "working", runId: work.id },
    ]);

    const awaiting = await run("waiting_input");
    await db().intervention.create({
      data: {
        id: randomUUID(),
        kind: "approval",
        status: "pending",
        spaceId,
        threadId,
        runId: awaiting.id,
        attemptId: randomUUID(),
        botId,
        messageId: randomUUID(),
      },
    });
    expect(await loadBotAvatarStates(db(), viewer)).toMatchObject([
      { botId, state: "approval", runId: awaiting.id },
    ]);
    const failure = await run("failed");
    expect(await loadBotAvatarStates(db(), viewer)).toMatchObject([
      { botId, state: "failed", runId: failure.id },
    ]);
    await db().thread.update({ where: { id: threadId }, data: { unread: false } });
    expect((await loadBotAvatarStates(db(), viewer))[0]?.state).toBe("failed");
    expect(await acknowledgeAvatarFailure(db(), { userId: otherUserId, spaceId }, failure.id)).toBe(
      false,
    );
    expect(
      await acknowledgeAvatarFailure(db(), { userId, spaceId: otherSpaceId }, failure.id),
    ).toBe(false);
    expect(await acknowledgeAvatarFailure(db(), viewer, failure.id)).toBe(true);
    expect(await acknowledgeAvatarFailure(db(), viewer, failure.id)).toBe(true);
    expect(await loadBotAvatarStates(db(), viewer)).toMatchObject([
      { botId, state: "approval", runId: awaiting.id },
    ]);
    expect(await loadBotAvatarStates(db(), { userId: otherUserId, spaceId })).toEqual([]);

    await clearThread(db(), { spaceId, threadId, botId });
    expect(await loadBotAvatarStates(db(), viewer)).toMatchObject([
      { botId, state: "idle", runId: null },
    ]);
  });

  it("keeps a live background task visible after its parent Run completes", async () => {
    const parent = await run("completed");
    const taskId = randomUUID();
    await db().backgroundAgentTask.create({
      data: {
        taskId,
        parentRunId: parent.id,
        userId,
        spaceId,
        botId,
        threadId,
        agentId: "helper",
        sessionId: "session",
        toolNames: [],
        status: "running",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(await loadBotAvatarStates(db(), viewer)).toMatchObject([
      { botId, state: "working", runId: parent.id },
    ]);
    await db().backgroundAgentTask.update({
      where: { taskId },
      data: { status: "completed", finishedAt: new Date() },
    });
    expect((await loadBotAvatarStates(db(), viewer))[0]?.state).toBe("idle");
  });

  it("surfaces group and external-thread Runs regardless of who triggered them", async () => {
    // PR #52 review P1 regression: Runs in group chats and external conversations
    // live on threads keyed by groupId/externalConversationId, not bot.thread, and
    // group members other than the Bot owner can trigger them. Authorization is
    // Bot ownership, so none of that may hide the Bot's real activity.
    const memberUserId = randomUUID();
    await db().user.create({
      data: { id: memberUserId, name: "Group member", email: `${memberUserId}@example.test` },
    });
    const group = await db().chatGroup.create({
      data: { spaceId, userId: memberUserId, name: "Avatar group" },
    });
    const groupThreadId = (
      await db().thread.create({ data: { spaceId, userId: memberUserId, groupId: group.id } })
    ).id;
    const external = await db().externalConversation.create({
      data: {
        provider: "test",
        workspaceId: "avatar-ws",
        externalKey: `avatar-external-${randomUUID()}`,
        conversationId: "avatar-conv",
        spaceId,
        botId,
        userId,
      },
    });
    const externalThreadId = (
      await db().thread.create({
        data: { spaceId, userId, externalConversationId: external.id },
      })
    ).id;

    async function runIn(threadId: string, asUserId: string, status: string) {
      const task = await db().task.create({
        data: {
          spaceId,
          userId: asUserId,
          botId,
          threadId,
          prompt: "Avatar test",
          status: "running",
        },
      });
      return db().run.create({
        data: {
          spaceId,
          userId: asUserId,
          botId,
          threadId,
          taskId: task.id,
          status,
          trigger: "user",
          ...(status === "failed" ? { completedAt: new Date() } : {}),
        },
      });
    }

    const groupRun = await runIn(groupThreadId, memberUserId, "running");
    expect(await loadBotAvatarStates(db(), viewer)).toMatchObject([
      { botId, state: "working", runId: groupRun.id },
    ]);

    // A background task triggered by another member keeps the Bot working after
    // its parent group Run completes (asserted before any approval exists, since
    // a pending approval legitimately outranks working).
    await db().run.update({
      where: { id: groupRun.id },
      data: { status: "completed", completedAt: new Date() },
    });
    const memberTaskId = randomUUID();
    await db().backgroundAgentTask.create({
      data: {
        taskId: memberTaskId,
        parentRunId: groupRun.id,
        userId: memberUserId,
        spaceId,
        botId,
        threadId: groupThreadId,
        agentId: "helper",
        sessionId: "session",
        toolNames: [],
        status: "running",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(await loadBotAvatarStates(db(), viewer)).toMatchObject([
      { botId, state: "working", runId: groupRun.id },
    ]);
    await db().backgroundAgentTask.update({
      where: { taskId: memberTaskId },
      data: { status: "completed", finishedAt: new Date() },
    });
    expect(await loadBotAvatarStates(db(), viewer)).toMatchObject([
      { botId, state: "idle", runId: null },
    ]);

    const externalRun = await runIn(externalThreadId, userId, "waiting_input");
    await db().intervention.create({
      data: {
        id: randomUUID(),
        kind: "approval",
        status: "pending",
        spaceId,
        threadId: externalThreadId,
        runId: externalRun.id,
        attemptId: randomUUID(),
        botId,
        messageId: randomUUID(),
      },
    });
    expect(await loadBotAvatarStates(db(), viewer)).toMatchObject([
      { botId, state: "approval", runId: externalRun.id },
    ]);

    const groupFailure = await runIn(groupThreadId, memberUserId, "failed");
    expect(await loadBotAvatarStates(db(), viewer)).toMatchObject([
      { botId, state: "failed", runId: groupFailure.id },
    ]);
    expect(await acknowledgeAvatarFailure(db(), viewer, groupFailure.id)).toBe(true);
    expect(await loadBotAvatarStates(db(), viewer)).toMatchObject([
      { botId, state: "approval", runId: externalRun.id },
    ]);

    // Clearing the group thread suppresses a failure recorded before the clear.
    const lateFailure = await runIn(groupThreadId, memberUserId, "failed");
    expect(await loadBotAvatarStates(db(), viewer)).toMatchObject([
      { botId, state: "failed", runId: lateFailure.id },
    ]);
    await clearThread(db(), { spaceId, threadId: groupThreadId, groupId: group.id, botId });
    expect(await loadBotAvatarStates(db(), viewer)).toMatchObject([
      { botId, state: "approval", runId: externalRun.id },
    ]);
  });
});
