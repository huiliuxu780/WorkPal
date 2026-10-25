import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyCancelTerminalPolicy,
  cancelPolicyFor,
  delegationOutcomeKey,
  settleReleasedSteeringForBot,
  supersededCancelPolicy,
} from "./cancel-terminal.js";
import type { PrismaClient } from "./client.js";
import { createThreadMessage } from "./messages.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";
import { expireWaitingRuns, WAIT_TIMEOUT_MS } from "./wait-timeouts.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

const FORBIDDEN_VISIBLE =
  /\blease\b|\bfence\b|\battempt\b|\brevision\b|\bstack\b|\/users\/|error:/i;

describePostgres("CANCEL-01 terminal policy (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let botId: string;
  let threadId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("cancel01");
    prisma = isolated.db.prisma;
    await prisma.user.create({
      data: { id, name: "Cancel policy", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Cancel policy", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Cancel policy" } });
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
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Policy bot", color: "test" },
    });
    botId = bot.id;
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId } });
    threadId = thread.id;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  beforeEach(async () => {
    await prisma.run.updateMany({
      where: {
        botId,
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      data: { status: "cancelled" },
    });
    await prisma.steeringMessage.deleteMany({ where: { botId } });
    await prisma.taughtSkill.updateMany({
      where: { botId, status: { in: ["recording", "drafting"] } },
      data: { status: "draft" },
    });
    await prisma.bot.update({ where: { id: botId }, data: { archivedAt: null } });
  });

  async function delegatedRun(
    status: "running" | "waiting_input" = "running",
    trigger = "bot_message",
  ) {
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Delegated", status: "running" },
    });
    return prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status,
        waitKind: status === "waiting_input" ? "input" : null,
        waitStartedAt:
          status === "waiting_input" ? new Date(Date.now() - WAIT_TIMEOUT_MS.input - 60_000) : null,
        trigger,
      },
    });
  }

  async function steer(
    runId: string | null,
    text: string,
    options?: {
      originTrigger?: string | null;
      blocks?: Array<Record<string, unknown>>;
      thread?: string;
    },
  ) {
    const message = await createThreadMessage(prisma, {
      threadId: options?.thread ?? threadId,
      role: "user",
      originKind: "human_web",
      authorUserId: id,
      blocks: (options?.blocks ?? [{ kind: "text", text }]) as never,
    });
    const row = await prisma.steeringMessage.create({
      data: {
        messageId: message.id,
        botId,
        userId: id,
        runId,
        originTrigger: options?.originTrigger ?? null,
      },
    });
    return { message, steering: row };
  }

  function effects() {
    return {
      callProvider: () => {
        throw new Error("provider");
      },
      callRuntime: () => {
        throw new Error("runtime");
      },
    };
  }

  async function visibleText() {
    const messages = await prisma.message.findMany({
      where: { threadId },
      select: { blocks: true },
    });
    return JSON.stringify(messages);
  }

  it("releases steering on wait timeout and creates one continuation", async () => {
    const run = await delegatedRun("waiting_input");
    const pending = await steer(run.id, "please continue");
    const calls = effects();
    await expireWaitingRuns(prisma);
    const steering = await prisma.steeringMessage.findUniqueOrThrow({
      where: { id: pending.steering.id },
    });
    const continuations = await prisma.run.findMany({
      where: { threadId, botId, id: { not: run.id }, status: "queued" },
    });
    expect(steering.runId).toBe(continuations[0]?.id ?? null);
    expect(continuations).toHaveLength(1);
    expect(continuations[0]?.trigger).toBe("follow_up");
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
      cancelReason: "wait_timeout",
    });
    expect(
      await prisma.cancelOutcomeOutbox.count({
        where: { idempotencyKey: delegationOutcomeKey(run.id) },
      }),
    ).toBe(1);
    await expireWaitingRuns(prisma);
    expect(await prisma.run.count({ where: { threadId, botId, status: "queued" } })).toBe(1);
    expect(await prisma.cancelOutcomeOutbox.count({ where: { runId: run.id } })).toBe(1);
    expect(await visibleText()).not.toMatch(FORBIDDEN_VISIBLE);
    expect(calls).toBeTruthy();
  });

  it("abandons pending steering when stop finds no active run", async () => {
    const pending = await steer(null, "left during teaching");
    const outcomesBefore = await prisma.cancelOutcomeOutbox.count();
    await prisma.$transaction((tx) =>
      applyCancelTerminalPolicy(tx, [], new Date(), {
        policy: cancelPolicyFor("user_stopped"),
        abandonThreadSteering: { threadId, botIds: [botId] },
        effects: effects(),
      }),
    );
    expect(
      await prisma.steeringMessage.findUnique({ where: { id: pending.steering.id } }),
    ).toBeNull();
    expect(await prisma.message.findUnique({ where: { id: pending.message.id } })).not.toBeNull();
    expect(await prisma.run.count({ where: { threadId, botId, status: "queued" } })).toBe(0);
    expect(await prisma.cancelOutcomeOutbox.count()).toBe(outcomesBefore);
  });

  it("does not report or keep steering when the user stops", async () => {
    const run = await delegatedRun();
    const pending = await steer(run.id, "abandoned");
    const loose = await steer(null, "also abandoned");
    await prisma.$transaction((tx) =>
      applyCancelTerminalPolicy(tx, [{ id: run.id, taskId: run.taskId }], new Date(), {
        policy: cancelPolicyFor("user_stopped"),
        abandonThreadSteering: { threadId, botIds: [botId] },
        effects: effects(),
      }),
    );
    expect(
      await prisma.steeringMessage.count({
        where: { id: { in: [pending.steering.id, loose.steering.id] } },
      }),
    ).toBe(0);
    expect(await prisma.message.findUnique({ where: { id: pending.message.id } })).not.toBeNull();
    expect(await prisma.cancelOutcomeOutbox.count({ where: { runId: run.id } })).toBe(0);
    expect(await prisma.run.count({ where: { threadId, botId, status: "queued" } })).toBe(0);
    const event = await prisma.event.findFirstOrThrow({
      where: { runId: run.id, type: "run.cancelled" },
    });
    expect(event.payload).toMatchObject({
      reason: "user_stopped",
      reportDelegationOutcome: false,
      steering: "delete",
    });
  });

  it.each(["plan_rejected", "budget_cancelled"] as const)(
    "releases %s steering into one continuation",
    async (reason) => {
      const run = await delegatedRun();
      const pending = await steer(run.id, reason);
      const active = await delegatedRun();
      await prisma.$transaction((tx) =>
        applyCancelTerminalPolicy(tx, [{ id: run.id, taskId: run.taskId }], new Date(), {
          policy: cancelPolicyFor(reason),
          effects: effects(),
        }),
      );
      const steering = await prisma.steeringMessage.findUniqueOrThrow({
        where: { id: pending.steering.id },
      });
      expect(steering.runId).toBeNull();
      expect(
        await prisma.run.count({
          where: { threadId, botId, status: { in: ["queued", "running"] }, id: { not: active.id } },
        }),
      ).toBe(0);
      await prisma.run.update({
        where: { id: active.id },
        data: { status: "cancelled", cancelReason: reason },
      });
      const resumed = await prisma.$transaction((tx) => settleReleasedSteeringForBot(tx, botId));
      expect(resumed).toHaveLength(1);
      expect(
        await prisma.cancelOutcomeOutbox.count({
          where: { idempotencyKey: delegationOutcomeKey(run.id) },
        }),
      ).toBe(1);
    },
  );

  it("does not continue while teaching is active, then continues once", async () => {
    const run = await delegatedRun();
    const pending = await steer(run.id, "after teaching");
    const skill = await prisma.taughtSkill.create({
      data: { spaceId: id, botId, userId: id, goal: "show me", status: "recording" },
    });
    const first = await prisma.$transaction((tx) =>
      applyCancelTerminalPolicy(tx, [{ id: run.id, taskId: run.taskId }], new Date(), {
        policy: cancelPolicyFor("teaching_started"),
        effects: effects(),
      }),
    );
    expect(first.continuationRunIds).toEqual([]);
    const deferredMessages = await prisma.message.findMany({
      where: { threadId, role: "system" },
      select: { blocks: true },
    });
    expect(
      deferredMessages.some((row) => JSON.stringify(row.blocks).includes("Policy bot正在教学")),
    ).toBe(true);
    const deferredEvent = await prisma.event.findFirst({
      where: { threadId, type: "thread.message.created" },
      orderBy: { seq: "desc" },
      select: { payload: true },
    });
    expect(deferredEvent?.payload).toMatchObject({
      role: "system",
      notice: "steering_deferred",
      reason: "teaching_started",
    });
    expect(
      (await prisma.steeringMessage.findUniqueOrThrow({ where: { id: pending.steering.id } }))
        .runId,
    ).toBeNull();
    await prisma.taughtSkill.update({ where: { id: skill.id }, data: { status: "draft" } });
    const resumed = await prisma.$transaction((tx) => settleReleasedSteeringForBot(tx, botId));
    expect(resumed).toHaveLength(1);
    const again = await prisma.$transaction((tx) => settleReleasedSteeringForBot(tx, botId));
    expect(again).toEqual([]);
    expect(await prisma.cancelOutcomeOutbox.count({ where: { runId: run.id } })).toBe(1);
    const deferredCount = (
      await prisma.message.findMany({
        where: { threadId, role: "system" },
        select: { blocks: true },
      })
    ).filter((row) => JSON.stringify(row.blocks).includes("正在教学")).length;
    expect(deferredCount).toBe(1);
  });

  it("keeps the message and does not continue when the bot cannot run", async () => {
    const other = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Other", color: "test" },
    });
    const group = await prisma.chatGroup.create({
      data: { spaceId: id, userId: id, name: "Policy group", kind: "standard" },
    });
    const groupThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, groupId: group.id },
    });
    await prisma.chatGroupMember.create({ data: { groupId: group.id, botId: other.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: other.id,
        threadId: groupThread.id,
        prompt: "Group",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: other.id,
        threadId: groupThread.id,
        taskId: task.id,
        status: "running",
        trigger: "bot_message",
      },
    });
    const message = await createThreadMessage(prisma, {
      threadId: groupThread.id,
      role: "user",
      originKind: "human_web",
      authorUserId: id,
      blocks: [{ kind: "text", text: "still here" }],
    });
    await prisma.steeringMessage.create({
      data: { messageId: message.id, botId: other.id, userId: id, runId: run.id },
    });
    await prisma.chatGroupMember.deleteMany({ where: { groupId: group.id, botId: other.id } });
    const calls = effects();
    await prisma.$transaction((tx) =>
      applyCancelTerminalPolicy(tx, [{ id: run.id, taskId: task.id }], new Date(), {
        policy: cancelPolicyFor("member_removed"),
        effects: calls,
      }),
    );
    expect(await prisma.message.findUnique({ where: { id: message.id } })).not.toBeNull();
    expect(await prisma.run.count({ where: { threadId: groupThread.id, status: "queued" } })).toBe(
      0,
    );
    const unhandled = await prisma.message.findMany({
      where: { threadId: groupThread.id, role: "system" },
      select: { blocks: true },
    });
    expect(
      unhandled.some((row) =>
        JSON.stringify(row.blocks).includes(
          "未处理：Other已经不在这个群里。这条消息还在，请重新指定一位成员。",
        ),
      ),
    ).toBe(true);
    expect(JSON.stringify(unhandled)).not.toMatch(FORBIDDEN_VISIBLE);
    expect(await prisma.cancelOutcomeOutbox.count({ where: { runId: run.id } })).toBe(1);
    const archived = await delegatedRun();
    await steer(archived.id, "archived bot");
    await prisma.bot.update({ where: { id: botId }, data: { archivedAt: new Date() } });
    const archivedResult = await prisma.$transaction((tx) =>
      applyCancelTerminalPolicy(tx, [{ id: archived.id, taskId: archived.taskId }], new Date(), {
        policy: cancelPolicyFor("bot_archived"),
        effects: calls,
      }),
    );
    expect(archivedResult.continuationRunIds).toEqual([]);
    const archivedNotices = await prisma.message.findMany({
      where: { threadId, role: "system" },
      select: { blocks: true },
    });
    expect(
      archivedNotices.some((row) =>
        JSON.stringify(row.blocks).includes(
          "未处理：Policy bot已归档。这条消息还在，请重新指定一位成员。",
        ),
      ),
    ).toBe(true);
    await prisma.bot.update({ where: { id: botId }, data: { archivedAt: null } });
    expect(
      JSON.stringify(await prisma.message.findMany({ where: { threadId: groupThread.id } })),
    ).not.toMatch(FORBIDDEN_VISIBLE);
  });

  it("writes one unhandled notice per concurrent cancellation episode", async () => {
    const first = await delegatedRun();
    const second = await delegatedRun();
    const firstSteering = await steer(first.id, "first unhandled");
    const secondSteering = await steer(second.id, "second unhandled");
    await Promise.all([
      prisma.$transaction((tx) =>
        applyCancelTerminalPolicy(tx, [{ id: first.id, taskId: first.taskId }], new Date(), {
          policy: cancelPolicyFor("member_removed"),
        }),
      ),
      prisma.$transaction((tx) =>
        applyCancelTerminalPolicy(tx, [{ id: second.id, taskId: second.taskId }], new Date(), {
          policy: cancelPolicyFor("member_removed"),
        }),
      ),
    ]);
    const notices = await prisma.message.findMany({
      where: {
        threadId,
        role: "system",
        clientNonce: {
          in: [
            `cancel-notice:steering_unhandled:member_removed:${botId}:${firstSteering.steering.id}`,
            `cancel-notice:steering_unhandled:member_removed:${botId}:${secondSteering.steering.id}`,
          ],
        },
      },
      select: { id: true },
    });
    expect(notices).toHaveLength(2);
  });

  it("does not repeat a notice when the same cancellation is retried", async () => {
    const run = await delegatedRun();
    const pending = await steer(run.id, "retry me");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await prisma.$transaction((tx) =>
        applyCancelTerminalPolicy(tx, [{ id: run.id, taskId: run.taskId }], new Date(), {
          policy: cancelPolicyFor("member_removed"),
        }),
      );
    }
    expect(
      await prisma.message.count({
        where: {
          threadId,
          role: "system",
          clientNonce: {
            endsWith: `:${botId}:${pending.steering.id}`,
          },
        },
      }),
    ).toBe(1);
  });

  it("explains later cancellations even when the reason repeats", async () => {
    const first = await delegatedRun();
    const firstSteering = await steer(first.id, "first episode");
    await prisma.$transaction((tx) =>
      applyCancelTerminalPolicy(tx, [{ id: first.id, taskId: first.taskId }], new Date(), {
        policy: cancelPolicyFor("member_removed"),
      }),
    );
    const second = await delegatedRun();
    const secondSteering = await steer(second.id, "second episode");
    await prisma.$transaction((tx) =>
      applyCancelTerminalPolicy(tx, [{ id: second.id, taskId: second.taskId }], new Date(), {
        policy: cancelPolicyFor("member_removed"),
      }),
    );
    const notices = await prisma.message.findMany({
      where: {
        threadId,
        role: "system",
        clientNonce: {
          in: [
            `cancel-notice:steering_unhandled:member_removed:${botId}:${firstSteering.steering.id}`,
            `cancel-notice:steering_unhandled:member_removed:${botId}:${secondSteering.steering.id}`,
          ],
        },
      },
      select: { id: true },
    });
    expect(notices).toHaveLength(2);
  });

  it("migrates superseded steering onto one replacement and retains otherwise", async () => {
    const oldRun = await delegatedRun("running", "user");
    const next = await delegatedRun("running", "user");
    const pending = await steer(oldRun.id, "move me");
    await prisma.$transaction((tx) =>
      applyCancelTerminalPolicy(tx, [{ id: oldRun.id, taskId: oldRun.taskId }], new Date(), {
        policy: supersededCancelPolicy({ disposition: "migrate", replacementRunId: next.id }),
        replacementRunId: next.id,
        effects: effects(),
      }),
    );
    expect(
      (await prisma.steeringMessage.findUniqueOrThrow({ where: { id: pending.steering.id } }))
        .runId,
    ).toBe(next.id);
    const orphan = await delegatedRun("running", "user");
    const kept = await steer(orphan.id, "cannot move");
    await prisma.$transaction((tx) =>
      applyCancelTerminalPolicy(tx, [{ id: orphan.id, taskId: orphan.taskId }], new Date(), {
        policy: supersededCancelPolicy({ disposition: "retain_unhandled" }),
        effects: effects(),
      }),
    );
    expect(
      (await prisma.steeringMessage.findUniqueOrThrow({ where: { id: kept.steering.id } })).runId,
    ).toBe(orphan.id);
    expect(await prisma.run.count({ where: { id: orphan.id, status: "queued" } })).toBe(0);
    const retainedNotices = await prisma.message.findMany({
      where: { threadId, role: "system" },
      select: { blocks: true },
    });
    expect(
      retainedNotices.some((row) =>
        JSON.stringify(row.blocks).includes(
          "未处理：没有可接替的工作。这条消息还在，请重新指定一位成员。",
        ),
      ),
    ).toBe(true);
  });

  it("does not batch direct, group, and channel steering into one continuation", async () => {
    const run = await delegatedRun();
    const direct = await steer(run.id, "in app");
    const dm = await steer(run.id, "in dm", { originTrigger: "messaging" });
    const channel = await steer(run.id, "in channel", {
      originTrigger: "messaging",
      blocks: [
        {
          kind: "channel_message",
          provider: "slack",
          channelId: "channel-a",
          fromAddress: "U1",
          fromLabel: "Pat",
          text: "in channel",
        },
      ],
    });
    const group = await prisma.chatGroup.create({
      data: { spaceId: id, userId: id, name: "Batch group", kind: "standard" },
    });
    const groupThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, groupId: group.id },
    });
    await prisma.chatGroupMember.create({ data: { groupId: group.id, botId } });
    const groupTask = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId: groupThread.id,
        prompt: "Group",
        status: "running",
      },
    });
    const groupRun = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId: groupThread.id,
        taskId: groupTask.id,
        status: "running",
        trigger: "user",
      },
    });
    const groupSteer = await steer(groupRun.id, "in group", { thread: groupThread.id });
    await prisma.$transaction(async (tx) => {
      await applyCancelTerminalPolicy(tx, [{ id: run.id, taskId: run.taskId }], new Date(), {
        policy: cancelPolicyFor("wait_timeout"),
        effects: effects(),
      });
      await applyCancelTerminalPolicy(tx, [{ id: groupRun.id, taskId: groupTask.id }], new Date(), {
        policy: cancelPolicyFor("wait_timeout"),
        effects: effects(),
      });
    });
    const rows = await prisma.steeringMessage.findMany({
      where: {
        id: {
          in: [direct.steering.id, dm.steering.id, channel.steering.id, groupSteer.steering.id],
        },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row.runId]));
    const directRun = byId.get(direct.steering.id);
    expect(directRun).toBeTruthy();
    expect(byId.get(dm.steering.id)).toBeNull();
    expect(byId.get(channel.steering.id)).toBeNull();
    expect(byId.get(groupSteer.steering.id)).not.toBe(directRun);
    expect(byId.get(groupSteer.steering.id)).toBeTruthy();
    const active = await prisma.run.groupBy({
      by: ["threadId", "botId"],
      where: {
        botId,
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      _count: true,
    });
    for (const row of active) expect(row._count).toBeLessThanOrEqual(1);
  });

  it("writes one outcome and one continuation under repeat and concurrent cancel", async () => {
    const run = await delegatedRun();
    await steer(run.id, "race");
    const calls = effects();
    const [first, second] = await Promise.all([
      prisma.$transaction((tx) =>
        applyCancelTerminalPolicy(tx, [{ id: run.id, taskId: run.taskId }], new Date(), {
          policy: cancelPolicyFor("wait_timeout"),
          effects: calls,
        }),
      ),
      prisma.$transaction((tx) =>
        applyCancelTerminalPolicy(tx, [{ id: run.id, taskId: run.taskId }], new Date(), {
          policy: cancelPolicyFor("wait_timeout"),
          effects: calls,
        }),
      ),
    ]);
    const winners = [first, second].filter((result) => result.rows.length === 1);
    expect(winners).toHaveLength(1);
    expect(
      await prisma.cancelOutcomeOutbox.count({
        where: { idempotencyKey: delegationOutcomeKey(run.id) },
      }),
    ).toBe(1);
    const again = await prisma.$transaction((tx) =>
      applyCancelTerminalPolicy(tx, [{ id: run.id, taskId: run.taskId }], new Date(), {
        policy: cancelPolicyFor("wait_timeout"),
        effects: calls,
      }),
    );
    expect(again.rows).toEqual([]);
    expect(
      await prisma.run.count({
        where: { threadId, botId, status: { in: ["queued", "running"] }, id: { notIn: [run.id] } },
      }),
    ).toBeLessThanOrEqual(2);
    const queuedForRun = await prisma.run.count({
      where: { sourceMessageId: { not: null }, threadId, botId, status: "queued" },
    });
    expect(queuedForRun).toBeLessThanOrEqual(1);
  });
});
