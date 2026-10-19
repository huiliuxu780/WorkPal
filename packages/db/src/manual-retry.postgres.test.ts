import { randomUUID } from "node:crypto";
import { buildRunOrchestration, supportCollaboration, userTurnCollaboration } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { answerRunInput, appendEvent, clearThread, pauseRunForInput } from "./events.js";
import { loadExecutionSummaries } from "./execution-history.js";
import {
  createManualRetryRun,
  loadManualRetryPredecessorIds,
  type ManualRetryDenied,
} from "./manual-retry.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("manual retry (PostgreSQL)", () => {
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let actorSeq = 0;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("manual_retry");
    prisma = isolated.db.prisma;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  type Ctx = {
    userId: string;
    spaceId: string;
    botId: string;
    threadId: string;
    organizationId: string;
  };

  async function newActor(): Promise<Ctx> {
    const label = `mr${++actorSeq}-${randomUUID().slice(0, 8)}`;
    const userId = `${label}-user`;
    const spaceId = `${label}-space`;
    await prisma.user.create({
      data: { id: userId, name: "MR owner", email: `${label}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id: label, name: "MR org", slug: label, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId: label, name: "MR space" } });
    await prisma.member.create({
      data: {
        id: `${label}-member`,
        organizationId: label,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: `${label}-sm`,
        spaceId,
        organizationId: label,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const botId = (
      await prisma.bot.create({ data: { spaceId, userId, name: `${label}-bot`, color: "test" } })
    ).id;
    const threadId = (await prisma.thread.create({ data: { spaceId, userId, botId } })).id;
    return { userId, spaceId, botId, threadId, organizationId: label };
  }

  async function peerInSpace(owner: Ctx): Promise<Ctx> {
    const label = `mr${++actorSeq}-${randomUUID().slice(0, 8)}`;
    const userId = `${label}-user`;
    await prisma.user.create({
      data: { id: userId, name: "MR peer", email: `${label}@example.test`, emailVerified: true },
    });
    await prisma.member.create({
      data: {
        id: `${label}-member`,
        organizationId: owner.organizationId,
        userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: `${label}-sm`,
        spaceId: owner.spaceId,
        organizationId: owner.organizationId,
        userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const botId = (
      await prisma.bot.create({
        data: { spaceId: owner.spaceId, userId, name: `${label}-bot`, color: "test" },
      })
    ).id;
    const threadId = (
      await prisma.thread.create({ data: { spaceId: owner.spaceId, userId, botId } })
    ).id;
    return {
      userId,
      spaceId: owner.spaceId,
      botId,
      threadId,
      organizationId: owner.organizationId,
    };
  }

  async function makeRun(
    ctx: Ctx,
    opts: {
      status?: string;
      trigger?: string;
      prompt?: string;
      orchestration?: unknown;
      routineId?: string;
      event?: "failed" | "cancelled" | "started" | "completed";
    } = {},
  ) {
    const status = opts.status ?? "failed";
    const task = await prisma.task.create({
      data: {
        spaceId: ctx.spaceId,
        userId: ctx.userId,
        botId: ctx.botId,
        threadId: ctx.threadId,
        prompt: opts.prompt ?? "Send the weekly report",
        status,
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: ctx.spaceId,
        userId: ctx.userId,
        botId: ctx.botId,
        threadId: ctx.threadId,
        taskId: task.id,
        status,
        trigger: opts.trigger ?? "user",
        ...(opts.orchestration !== undefined
          ? { orchestration: opts.orchestration as object }
          : {}),
        ...(opts.routineId ? { routineId: opts.routineId } : {}),
      },
    });
    const eventType =
      opts.event ??
      (status === "cancelled"
        ? "cancelled"
        : status === "completed"
          ? "completed"
          : status === "failed"
            ? "failed"
            : "started");
    await appendEvent(prisma, {
      spaceId: ctx.spaceId,
      threadId: ctx.threadId,
      botId: ctx.botId,
      runId: run.id,
      type: `run.${eventType}`,
      payload: {},
    });
    return { task, run };
  }

  it("creates a successor on the same Task and Thread and keeps the failed original", async () => {
    const ctx = await newActor();
    const { task, run } = await makeRun(ctx);
    const result = await createManualRetryRun(prisma, {
      spaceId: ctx.spaceId,
      userId: ctx.userId,
      runId: run.id,
      clientNonce: `nonce-${run.id}`,
    });
    expect(result.replayed).toBe(false);
    expect(result.taskId).toBe(task.id);
    expect(result.threadId).toBe(ctx.threadId);
    expect(result.sourceRunId).toBe(run.id);
    const created = await prisma.run.findUniqueOrThrow({ where: { id: result.runId } });
    expect(created.taskId).toBe(task.id);
    expect(created.threadId).toBe(ctx.threadId);
    expect(created.retryOfRunId).toBe(run.id);
    expect(created.status).toBe("queued");
    expect(created.trigger).toBe("user");
    const original = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(original.status).toBe("failed");
    expect(
      await prisma.event.count({
        where: { runId: created.id, type: "run.manual_retry_requested" },
      }),
    ).toBe(1);
    const summaries = await loadExecutionSummaries(prisma, {
      threadId: ctx.threadId,
      spaceId: ctx.spaceId,
      runIds: [run.id, created.id],
    });
    const ancestor = summaries.find((row) => row.runId === run.id);
    const successor = summaries.find((row) => row.runId === created.id);
    expect(ancestor?.retrySuccessorRunId).toBe(created.id);
    expect(ancestor?.manualRetry).toEqual({ allowed: false, reason: "already_active" });
    expect(successor?.retryOfRunId).toBe(run.id);
  });

  it("replays the same nonce and collapses concurrent successor inserts", async () => {
    const ctx = await newActor();
    const { run } = await makeRun(ctx, { status: "cancelled", event: "cancelled" });
    const nonce = `same-${run.id}`;
    const first = await createManualRetryRun(prisma, {
      spaceId: ctx.spaceId,
      userId: ctx.userId,
      runId: run.id,
      clientNonce: nonce,
    });
    const replay = await createManualRetryRun(prisma, {
      spaceId: ctx.spaceId,
      userId: ctx.userId,
      runId: run.id,
      clientNonce: nonce,
    });
    expect(replay.runId).toBe(first.runId);
    expect(replay.replayed).toBe(true);

    const ctx2 = await newActor();
    const second = await makeRun(ctx2);
    const [left, right] = await Promise.all([
      createManualRetryRun(prisma, {
        spaceId: ctx2.spaceId,
        userId: ctx2.userId,
        runId: second.run.id,
        clientNonce: `a-${second.run.id}`,
      }),
      createManualRetryRun(prisma, {
        spaceId: ctx2.spaceId,
        userId: ctx2.userId,
        runId: second.run.id,
        clientNonce: `b-${second.run.id}`,
      }),
    ]);
    expect(left.runId).toBe(right.runId);
    expect(
      await prisma.run.count({
        where: { retryOfRunId: second.run.id },
      }),
    ).toBe(1);
  });

  it("walks to the latest hop so a second retry continues the chain", async () => {
    const ctx = await newActor();
    const { run: first } = await makeRun(ctx);
    const hop = await createManualRetryRun(prisma, {
      spaceId: ctx.spaceId,
      userId: ctx.userId,
      runId: first.id,
      clientNonce: `h1-${first.id}`,
    });
    await prisma.run.update({
      where: { id: hop.runId },
      data: { status: "failed" },
    });
    await appendEvent(prisma, {
      spaceId: ctx.spaceId,
      threadId: ctx.threadId,
      botId: ctx.botId,
      runId: hop.runId,
      type: "run.failed",
      payload: {},
    });
    const next = await createManualRetryRun(prisma, {
      spaceId: ctx.spaceId,
      userId: ctx.userId,
      runId: first.id,
      clientNonce: `h2-${first.id}`,
    });
    expect(next.runId).not.toBe(hop.runId);
    const created = await prisma.run.findUniqueOrThrow({ where: { id: next.runId } });
    expect(created.retryOfRunId).toBe(hop.runId);
    expect(await loadManualRetryPredecessorIds(prisma, next.runId)).toEqual([hop.runId, first.id]);
  });

  it("refuses helpers, delivery, completed, busy, cleared, and foreign actors", async () => {
    const helperCtx = await newActor();
    const parent = await makeRun(helperCtx, { status: "failed", event: "failed" });
    const helperOrch = buildRunOrchestration({
      kind: "bot_message",
      ownerBotId: helperCtx.botId,
      responseMode: "single",
      ownershipMode: "support",
      collaboration: supportCollaboration({
        fromBotId: helperCtx.botId,
        parentRunId: parent.run.id,
        handoffDepth: 0,
        messageHop: 1,
      }),
    });
    const helper = await makeRun(helperCtx, {
      status: "failed",
      trigger: "bot_message",
      orchestration: helperOrch,
    });
    await expect(
      createManualRetryRun(prisma, {
        spaceId: helperCtx.spaceId,
        userId: helperCtx.userId,
        runId: helper.run.id,
        clientNonce: `helper-${helper.run.id}`,
      }),
    ).rejects.toMatchObject({ reason: "not_root" } satisfies Partial<ManualRetryDenied>);

    const deliveryCtx = await newActor();
    const delivery = await makeRun(deliveryCtx, { trigger: "delivery" });
    await expect(
      createManualRetryRun(prisma, {
        spaceId: deliveryCtx.spaceId,
        userId: deliveryCtx.userId,
        runId: delivery.run.id,
        clientNonce: `del-${delivery.run.id}`,
      }),
    ).rejects.toMatchObject({ reason: "ineligible_trigger" });

    const doneCtx = await newActor();
    const done = await makeRun(doneCtx, { status: "completed", event: "completed" });
    await expect(
      createManualRetryRun(prisma, {
        spaceId: doneCtx.spaceId,
        userId: doneCtx.userId,
        runId: done.run.id,
        clientNonce: `done-${done.run.id}`,
      }),
    ).rejects.toMatchObject({ reason: "completed" });

    const busyCtx = await newActor();
    const busySource = await makeRun(busyCtx);
    await makeRun(busyCtx, { status: "running", event: "started" });
    await expect(
      createManualRetryRun(prisma, {
        spaceId: busyCtx.spaceId,
        userId: busyCtx.userId,
        runId: busySource.run.id,
        clientNonce: `busy-${busySource.run.id}`,
      }),
    ).rejects.toMatchObject({ reason: "thread_busy" });

    const clearCtx = await newActor();
    const cleared = await makeRun(clearCtx);
    await clearThread(prisma, {
      spaceId: clearCtx.spaceId,
      threadId: clearCtx.threadId,
      botId: clearCtx.botId,
    });
    await expect(
      createManualRetryRun(prisma, {
        spaceId: clearCtx.spaceId,
        userId: clearCtx.userId,
        runId: cleared.run.id,
        clientNonce: `clear-${cleared.run.id}`,
      }),
    ).rejects.toMatchObject({ reason: "thread_cleared" });

    const owner = await newActor();
    const other = await newActor();
    const owned = await makeRun(owner);
    await expect(
      createManualRetryRun(prisma, {
        spaceId: other.spaceId,
        userId: other.userId,
        runId: owned.run.id,
        clientNonce: `x-${owned.run.id}`,
      }),
    ).rejects.toMatchObject({ reason: "not_found" });
  });

  it("retries a routine occurrence without writing a schedule row", async () => {
    const ctx = await newActor();
    const nextRunAt = new Date("2026-11-01T00:00:00.000Z");
    const routine = await prisma.routine.create({
      data: {
        spaceId: ctx.spaceId,
        botId: ctx.botId,
        userId: ctx.userId,
        threadId: ctx.threadId,
        name: "Nightly",
        prompt: "Report the nightly fixture status",
        crons: ["0 0 1 1 *"],
        timezone: "UTC",
        active: false,
        nextRunAt,
      },
    });
    const { run, task } = await makeRun(ctx, {
      trigger: "routine",
      routineId: routine.id,
      prompt: "Report the nightly fixture status",
    });
    const result = await createManualRetryRun(prisma, {
      spaceId: ctx.spaceId,
      userId: ctx.userId,
      runId: run.id,
      clientNonce: `routine-${run.id}`,
    });
    const created = await prisma.run.findUniqueOrThrow({ where: { id: result.runId } });
    expect(created.taskId).toBe(task.id);
    expect(created.trigger).toBe("routine");
    expect(created.routineId).toBe(routine.id);
    const after = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(after.nextRunAt?.toISOString()).toBe(nextRunAt.toISOString());
    expect(after.crons).toEqual(["0 0 1 1 *"]);
    expect(await prisma.routine.count({ where: { spaceId: ctx.spaceId } })).toBe(1);
  });

  it.each(["authorize_retry", "confirm_completed", "cancel"] as const)(
    "preserves the group task prompt when resolving %s",
    async (choice) => {
      const ctx = await newActor();
      const groupId = (
        await prisma.chatGroup.create({
          data: { spaceId: ctx.spaceId, userId: ctx.userId, name: "Ops" },
        })
      ).id;
      const memberBot = (
        await prisma.bot.create({
          data: { spaceId: ctx.spaceId, userId: ctx.userId, name: "Member", color: "test" },
        })
      ).id;
      await prisma.chatGroupMember.create({ data: { groupId, botId: ctx.botId } });
      await prisma.chatGroupMember.create({ data: { groupId, botId: memberBot } });
      const groupThread = (
        await prisma.thread.create({ data: { spaceId: ctx.spaceId, userId: ctx.userId, groupId } })
      ).id;
      const groupCtx = { ...ctx, threadId: groupThread };
      const { run } = await makeRun(groupCtx, {
        orchestration: buildRunOrchestration({
          kind: "direct",
          ownerBotId: ctx.botId,
          responseMode: "single",
          collaboration: userTurnCollaboration(),
        }),
      });
      const retried = await createManualRetryRun(prisma, {
        spaceId: ctx.spaceId,
        userId: ctx.userId,
        runId: run.id,
        clientNonce: `group-${run.id}`,
      });
      expect(retried.target).toEqual({ kind: "group", groupId });
      expect(retried.threadId).toBe(groupThread);

      const originalTask = await prisma.task.findUniqueOrThrow({ where: { id: retried.taskId } });
      const waiting = await prisma.run.update({
        where: { id: retried.runId },
        data: {
          status: "running",
          leaseOwner: "worker-1",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const attempt = await prisma.attempt.create({
        data: { runId: waiting.id, fence: 1, status: "running" },
      });
      const effect = await prisma.externalEffect.create({
        data: {
          spaceId: ctx.spaceId,
          runId: run.id,
          kind: "send_email",
          idempotencyKey: `uncertain-${run.id}`,
          status: "uncertain",
          request: { to: "ada@example.test" },
        },
      });
      const paused = await pauseRunForInput(prisma, {
        spaceId: ctx.spaceId,
        threadId: groupThread,
        botId: ctx.botId,
        runId: waiting.id,
        attemptId: attempt.id,
        leaseOwner: "worker-1",
        leaseFence: 1,
        blocks: [
          {
            kind: "ask",
            text: "The previous attempt of send_email did not record a confirmed result.",
            status: "pending",
            actions: [
              { id: "confirm_completed", label: "It already completed" },
              { id: "authorize_retry", label: "Try this operation again" },
              { id: "cancel", label: "Skip this operation" },
            ],
          },
        ],
        offeredActions: [
          { id: "confirm_completed", label: "It already completed" },
          { id: "authorize_retry", label: "Try this operation again" },
          { id: "cancel", label: "Skip this operation" },
        ],
        manualRetryEffectId: effect.id,
      });
      expect(paused).toBe(true);
      const message = await prisma.message.findFirstOrThrow({
        where: { runId: waiting.id, role: "bot" },
        orderBy: { seq: "desc" },
      });
      expect(
        await answerRunInput(prisma, {
          spaceId: ctx.spaceId,
          threadId: groupThread,
          runId: waiting.id,
          messageId: message.id,
          answeredByUserId: ctx.userId,
          answer: choice,
        }),
      ).toBe(true);
      const updated = await prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } });
      expect(updated.reviewDecision).toBe(
        {
          authorize_retry: "manual_retry_authorized",
          confirm_completed: "manual_retry_confirmed",
          cancel: "manual_retry_cancelled",
        }[choice],
      );
      expect((await prisma.task.findUniqueOrThrow({ where: { id: retried.taskId } })).prompt).toBe(
        originalTask.prompt,
      );
      expect(updated.runId).toBe(run.id);
    },
  );

  it("refuses a nonce already used by another task of the same user", async () => {
    const ctx = await newActor();
    const first = await makeRun(ctx);
    const other = await makeRun(ctx);
    const nonce = `shared-${first.run.id}`;
    const created = await createManualRetryRun(prisma, {
      spaceId: ctx.spaceId,
      userId: ctx.userId,
      runId: first.run.id,
      clientNonce: nonce,
    });
    await expect(
      createManualRetryRun(prisma, {
        spaceId: ctx.spaceId,
        userId: ctx.userId,
        runId: other.run.id,
        clientNonce: nonce,
      }),
    ).rejects.toMatchObject({ reason: "nonce_conflict" } satisfies Partial<ManualRetryDenied>);
    expect(created.taskId).toBe(first.task.id);
    expect(created.threadId).toBe(ctx.threadId);
    expect(created.botId).toBe(ctx.botId);
    expect(await prisma.run.count({ where: { retryOfRunId: other.run.id } })).toBe(0);
    const replay = await createManualRetryRun(prisma, {
      spaceId: ctx.spaceId,
      userId: ctx.userId,
      runId: first.run.id,
      clientNonce: nonce,
    });
    expect(replay.runId).toBe(created.runId);
    expect(replay.replayed).toBe(true);
    expect(replay.taskId).toBe(first.task.id);
    expect(replay.threadId).toBe(ctx.threadId);
    expect(replay.botId).toBe(ctx.botId);
  });

  it("refuses a nonce already used by another user in the same space", async () => {
    const owner = await newActor();
    const peer = await peerInSpace(owner);
    const ownerRun = await makeRun(owner);
    const peerRun = await makeRun(peer);
    const nonce = `space-${ownerRun.run.id}`;
    const created = await createManualRetryRun(prisma, {
      spaceId: owner.spaceId,
      userId: owner.userId,
      runId: ownerRun.run.id,
      clientNonce: nonce,
    });
    await expect(
      createManualRetryRun(prisma, {
        spaceId: peer.spaceId,
        userId: peer.userId,
        runId: peerRun.run.id,
        clientNonce: nonce,
      }),
    ).rejects.toMatchObject({ reason: "nonce_conflict" } satisfies Partial<ManualRetryDenied>);
    expect(created.taskId).toBe(ownerRun.task.id);
    expect(created.threadId).toBe(owner.threadId);
    expect(created.botId).toBe(owner.botId);
    expect(await prisma.run.count({ where: { retryOfRunId: peerRun.run.id } })).toBe(0);

    const racerA = await peerInSpace(owner);
    const racerB = await peerInSpace(owner);
    const runA = await makeRun(racerA);
    const runB = await makeRun(racerB);
    const raceNonce = `race-${runA.run.id}`;
    const settled = await Promise.allSettled([
      createManualRetryRun(prisma, {
        spaceId: racerA.spaceId,
        userId: racerA.userId,
        runId: runA.run.id,
        clientNonce: raceNonce,
      }),
      createManualRetryRun(prisma, {
        spaceId: racerB.spaceId,
        userId: racerB.userId,
        runId: runB.run.id,
        clientNonce: raceNonce,
      }),
    ]);
    const ok = settled.filter((row) => row.status === "fulfilled");
    const denied = settled.filter((row) => row.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect((denied[0] as PromiseRejectedResult).reason).toMatchObject({
      reason: "nonce_conflict",
    });
    const winner = (
      ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof createManualRetryRun>>>
    ).value;
    expect(winner.replayed).toBe(false);
    expect([runA.task.id, runB.task.id]).toContain(winner.taskId);
    expect(
      winner.taskId === runA.task.id
        ? winner.threadId === racerA.threadId && winner.botId === racerA.botId
        : winner.threadId === racerB.threadId && winner.botId === racerB.botId,
    ).toBe(true);

    const replay = await createManualRetryRun(prisma, {
      spaceId: owner.spaceId,
      userId: owner.userId,
      runId: ownerRun.run.id,
      clientNonce: nonce,
    });
    expect(replay.runId).toBe(created.runId);
    expect(replay.taskId).toBe(ownerRun.task.id);
    expect(replay.threadId).toBe(owner.threadId);
    expect(replay.botId).toBe(owner.botId);
  });
});
