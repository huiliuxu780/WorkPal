import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireSessionAdmission,
  agentScopeChatSessionKey,
  applyCancelTerminalPolicy,
  cancelPolicyFor,
  completeSessionAdmission,
  createIsolatedPostgresDatabase,
  createThreadMessage,
  type IsolatedPostgresDatabase,
  listAvailableSessionAdmissionHeads,
  markSessionAdmissionRecovering,
  markSessionRuntimeStarted,
  type PrismaClient,
  prepareSessionExecution,
  recoverExpiredSessionAdmissions,
  type SessionAdmissionLease,
} from "./index.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

/**
 * VERIFY-01 S1–S4: one Bot, one conversation, no child Runs, no takeover, no
 * multi-Bot. This is the most common user path — press Stop, then say something
 * else — and it is the 2026-10-27 QA P0-3 counterexample: the Run becomes
 * `cancelled` and every later message in that conversation stays `queued` past
 * the five-minute lease horizon.
 *
 * Production paths exercised here:
 *   - Stop: `apps/api/src/thread-target.ts` `stopThreadRuns()` →
 *     `applyCancelTerminalPolicy(cancelPolicyFor("user_stopped"))`. Neither
 *     touches session admission.
 *   - Admission: `packages/adapters/src/executor.ts` sets
 *     `sessionMayRelease = false` once the runtime started, and its `finally`
 *     block calls `markSessionAdmissionRecovering(...,
 *     "agentscope_runtime_outcome_unconfirmed")` for a Run that ended
 *     unconfirmed and is not parked on a card. A cancelled Run is exactly that.
 *     A normally completed Run goes through `completeSessionAdmission`.
 *   - Fallback: `apps/worker/src/session-admission-reconciler.ts` →
 *     `recoverExpiredSessionAdmissions()`.
 *
 * These tests record facts; they do not fix anything. The fix belongs to
 * FIX-STOP-01. Two assertions from the task card are deliberately NOT made here
 * because the persistence layer cannot observe them: the conversation header no
 * longer showing Running/Queued, and the absence of "recovering session
 * admission could not be proven" in the worker log. Both need the executor /
 * worker chain or the real-model manual run, and the scenario map records them
 * as not covered by this file rather than claiming them.
 */
describePostgres("Stop must hand the session execution right back (PostgreSQL)", () => {
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  const tenant = randomUUID();
  const TERMINAL = ["completed", "failed", "cancelled"];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("stop_session_release");
    prisma = isolated.db.prisma;
    await prisma.user.create({
      data: {
        id: tenant,
        name: "Stop release test",
        email: `${tenant}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id: tenant, name: "Stop release test", slug: tenant, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: tenant, organizationId: tenant, name: "Stop test" } });
    await prisma.member.create({
      data: {
        id: tenant,
        organizationId: tenant,
        userId: tenant,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: tenant,
        spaceId: tenant,
        organizationId: tenant,
        userId: tenant,
        role: "owner",
        createdAt: new Date(),
      },
    });
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  async function newDirectSession() {
    const bot = await prisma.bot.create({
      data: { spaceId: tenant, userId: tenant, name: `Stop ${randomUUID()}`, color: "test" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: tenant, userId: tenant, botId: bot.id },
    });
    const sessionKey = agentScopeChatSessionKey({
      userId: tenant,
      spaceId: tenant,
      botId: bot.id,
      threadId: thread.id,
      threadGeneration: 0,
    });
    return { bot, thread, sessionKey };
  }

  async function newRun(botId: string, threadId: string, prompt = "write something long") {
    const task = await prisma.task.create({
      data: { spaceId: tenant, userId: tenant, botId, threadId, prompt, status: "queued" },
    });
    return prisma.run.create({
      data: {
        spaceId: tenant,
        userId: tenant,
        botId,
        threadId,
        taskId: task.id,
        trigger: "user",
        status: "queued",
      },
    });
  }

  /** A Worker claimed the Run: lease owner and fence are what admission records. */
  async function claimRun(run: { id: string; taskId: string }, fence = 1) {
    const workerId = `worker-${randomUUID()}`;
    await prisma.run.update({
      where: { id: run.id },
      data: { status: "running", leaseOwner: workerId, leaseFence: fence },
    });
    await prisma.task.update({ where: { id: run.taskId }, data: { status: "running" } });
    return { runLeaseOwner: workerId, runLeaseFence: fence };
  }

  function identity(
    run: { id: string; userId: string; spaceId: string; botId: string; threadId: string },
    executionId: string,
    lease: { runLeaseOwner: string; runLeaseFence: number },
  ) {
    return {
      userId: run.userId,
      spaceId: run.spaceId,
      botId: run.botId,
      threadId: run.threadId,
      threadGeneration: 0,
      runId: run.id,
      executionId,
      runLeaseOwner: lease.runLeaseOwner,
      runLeaseFence: lease.runLeaseFence,
    };
  }

  /** The executor's admission entry: acquire, prepare, then mark runtime started. */
  async function ownAdmission(
    run: { id: string; userId: string; spaceId: string; botId: string; threadId: string },
    lease: { runLeaseOwner: string; runLeaseFence: number },
    options: { runtimeStarted: boolean; ttlMs?: number },
  ): Promise<SessionAdmissionLease> {
    const acquired = await acquireSessionAdmission(
      prisma,
      identity(run, `exec-${randomUUID()}`, lease),
      {
        ttlMs: options.ttlMs,
      },
    );
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") throw new Error("admission was not acquired");
    if (!options.runtimeStarted) return acquired;
    const prepared = {
      ...acquired,
      attemptId: `attempt-${randomUUID()}`,
      suspensionKey: `suspension-${randomUUID()}`,
    };
    expect(await prepareSessionExecution(prisma, prepared)).toBe(true);
    expect(await markSessionRuntimeStarted(prisma, prepared)).toBe(true);
    return acquired;
  }

  /**
   * What the executor's finally block does for a Run that ended unconfirmed and
   * is not parked on a card; the reason string is copied from executor.ts.
   */
  function parkAsExecutorDoes(lease: SessionAdmissionLease) {
    return markSessionAdmissionRecovering(prisma, lease, "agentscope_runtime_outcome_unconfirmed");
  }

  /** The production Stop: the transaction body of stopThreadRuns. */
  function pressStop(
    runs: Array<{ id: string; taskId: string }>,
    target: { threadId: string; botId: string },
  ) {
    return prisma.$transaction((tx) =>
      applyCancelTerminalPolicy(tx, runs, new Date(), {
        policy: cancelPolicyFor("user_stopped"),
        appendEvents: false,
        abandonThreadSteering: { threadId: target.threadId, botIds: [target.botId] },
      }),
    );
  }

  async function steer(runId: string | null, threadId: string, botId: string, text: string) {
    const message = await createThreadMessage(prisma, {
      threadId,
      role: "user",
      originKind: "human_web",
      authorUserId: tenant,
      blocks: [{ kind: "text", text }] as never,
    });
    return prisma.steeringMessage.create({
      data: { messageId: message.id, botId, userId: tenant, runId },
    });
  }

  /** Admission rows that still hold the session, joined to their owner's status. */
  function holders(sessionKey: string) {
    return prisma.$queryRaw<
      Array<{ state: string; ownerRunId: string | null; runStatus: string | null }>
    >`
      SELECT admission."state", admission."ownerRunId", run."status" AS "runStatus"
      FROM "agent_session_admissions" admission
      LEFT JOIN "runs" run ON run."id" = admission."ownerRunId"
      WHERE admission."sessionKey" = ${sessionKey}
        AND admission."state" IN ('owned', 'recovering')
    `;
  }

  /** One reconciler pass on an explicit clock. No sleeping, no TTL wait. */
  async function oneEventCheckTick(now: Date) {
    await recoverExpiredSessionAdmissions(prisma, now);
    return listAvailableSessionAdmissionHeads(prisma);
  }

  /**
   * Both card assertions in one fact, so a stuck admission cannot hide the
   * handover result and vice versa: the next Run owns the session within one
   * event-check tick, and no admission is left held by a terminal Run.
   */
  async function expectSessionHandedOver(
    label: string,
    sessionKey: string,
    next: {
      id: string;
      userId: string;
      spaceId: string;
      botId: string;
      threadId: string;
      taskId: string;
    },
    now: Date,
  ) {
    await oneEventCheckTick(now);
    const acquired = await acquireSessionAdmission(
      prisma,
      identity(next, `exec-${randomUUID()}`, await claimRun(next)),
      { now },
    );
    const stuck = (await holders(sessionKey)).filter(
      (row) => row.ownerRunId !== null && TERMINAL.includes(row.runStatus ?? ""),
    );
    expect(
      {
        scenario: label,
        nextRunAdmission: acquired.kind,
        nextRunId: acquired.kind === "acquired" ? acquired.runId : null,
        expectedNextRunId: next.id,
        admissionHeldByTerminalRun: stuck,
      },
      `${label}: Stop must hand the session to the next Run in the same event-check tick`,
    ).toEqual({
      scenario: label,
      nextRunAdmission: "acquired",
      nextRunId: next.id,
      expectedNextRunId: next.id,
      admissionHeldByTerminalRun: [],
    });
  }

  it("S1: cancelling an in-flight generation lets the next message run", async () => {
    // The QA reproduction: the runtime already started, so the executor parks
    // the admission instead of releasing it, and Stop cancels the Run.
    const { bot, thread, sessionKey } = await newDirectSession();
    const stopped = await newRun(bot.id, thread.id);
    const admission = await ownAdmission(stopped, await claimRun(stopped), {
      runtimeStarted: true,
    });

    const settled = await pressStop([{ id: stopped.id, taskId: stopped.taskId }], {
      threadId: thread.id,
      botId: bot.id,
    });
    expect(settled.rows.map((row) => row.id)).toEqual([stopped.id]);
    await parkAsExecutorDoes(admission);

    const next = await newRun(bot.id, thread.id, "1+1 等于几");
    await expectSessionHandedOver("S1", sessionKey, next, new Date());
  });

  it("S1b: cancelling before the runtime started must not wait out the admission TTL", async () => {
    const { bot, thread, sessionKey } = await newDirectSession();
    const stopped = await newRun(bot.id, thread.id);
    // TTL far in the future: the admission is still valid when Stop lands, so
    // only the owner's terminal state can free the session.
    await ownAdmission(stopped, await claimRun(stopped), {
      runtimeStarted: false,
      ttlMs: 300_000,
    });

    await pressStop([{ id: stopped.id, taskId: stopped.taskId }], {
      threadId: thread.id,
      botId: bot.id,
    });

    const next = await newRun(bot.id, thread.id, "还在吗");
    await expectSessionHandedOver("S1b", sessionKey, next, new Date());
  });

  it("S2: appended steering is explicitly discarded and the conversation keeps working", async () => {
    const { bot, thread, sessionKey } = await newDirectSession();
    const stopped = await newRun(bot.id, thread.id);
    const admission = await ownAdmission(stopped, await claimRun(stopped), {
      runtimeStarted: true,
    });

    const first = await steer(stopped.id, thread.id, bot.id, "顺便加上小标题");
    const second = await steer(stopped.id, thread.id, bot.id, "语气正式一点");

    await pressStop([{ id: stopped.id, taskId: stopped.taskId }], {
      threadId: thread.id,
      botId: bot.id,
    });
    await parkAsExecutorDoes(admission);

    // Recorded before the session assertions so a stuck admission cannot hide
    // the steering fact. `user_stopped` carries steering: "delete", so the
    // appends must be gone rather than left pending for a later continuation.
    const remaining = await prisma.steeringMessage.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { id: true, claimedAt: true },
    });
    expect(remaining, "S2: appended steering must be explicitly discarded by Stop").toEqual([]);

    const next = await newRun(bot.id, thread.id, "重新写一版");
    await expectSessionHandedOver("S2", sessionKey, next, new Date());
  });

  it("S3: Stop that lands on an already terminal Run changes nothing and leaves the session usable", async () => {
    const { bot, thread, sessionKey } = await newDirectSession();
    const finished = await newRun(bot.id, thread.id);
    const admission = await ownAdmission(finished, await claimRun(finished), {
      runtimeStarted: true,
    });

    // The Run finished normally, so the executor completed the turn and handed
    // the admission back through its own completion path.
    await prisma.run.update({ where: { id: finished.id }, data: { status: "completed" } });
    await prisma.task.update({ where: { id: finished.taskId }, data: { status: "completed" } });
    const released = await completeSessionAdmission(prisma, admission);
    expect(released.kind).toBe("released");

    // Stop lands after that: the active-status guard must match nothing.
    const settled = await pressStop([{ id: finished.id, taskId: finished.taskId }], {
      threadId: thread.id,
      botId: bot.id,
    });
    expect(settled.rows, "S3: a completed Run must not be cancelled again").toEqual([]);

    const afterStop = await prisma.run.findUniqueOrThrow({
      where: { id: finished.id },
      select: { status: true },
    });
    expect(afterStop.status, "S3: the Run keeps its real terminal state").toBe("completed");

    const cancelledEvents = await prisma.event.count({
      where: { threadId: thread.id, type: "run.cancelled", runId: finished.id },
    });
    expect(cancelledEvents, "S3: no extra terminal event for an already finished Run").toBe(0);

    const next = await newRun(bot.id, thread.id, "再来一条");
    await expectSessionHandedOver("S3", sessionKey, next, new Date());
  });

  it("S4: a worker restart or expired lease must still free a session whose owner was cancelled", async () => {
    const { bot, thread, sessionKey } = await newDirectSession();
    const stopped = await newRun(bot.id, thread.id);
    // Short TTL so the lease horizon is reachable with a controllable clock.
    const admission = await ownAdmission(stopped, await claimRun(stopped), {
      runtimeStarted: true,
      ttlMs: 1_000,
    });

    await pressStop([{ id: stopped.id, taskId: stopped.taskId }], {
      threadId: thread.id,
      botId: bot.id,
    });
    await parkAsExecutorDoes(admission);

    const parked = await holders(sessionKey);
    expect(
      parked.map((row) => row.state),
      "S4 precondition: parked as recovering",
    ).toEqual(["recovering"]);

    // The worker is gone and the lease horizon has passed. Lease recovery is the
    // documented fallback, so it has to actually free the session.
    const afterHorizon = new Date(admission.expiresAt.getTime() + 5 * 60_000);
    const next = await newRun(bot.id, thread.id, "你还在吗");
    await expectSessionHandedOver("S4", sessionKey, next, afterHorizon);
  });
});
