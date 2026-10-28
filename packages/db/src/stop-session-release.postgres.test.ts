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
  listCancelledSessionsToRecover,
  markSessionAdmissionRecovering,
  markSessionRuntimeStarted,
  type PrismaClient,
  prepareSessionExecution,
  recoverExpiredSessionAdmissions,
  releaseCancelledSessionsThatNeverStarted,
  type SessionAdmissionLease,
} from "./index.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

/**
 * VERIFY-01 S1–S4 + FIX-STOP-01, four deterministic branches.
 *
 * The first version of this fix released a cancelled owner as soon as its
 * `run_abort` revocation disappeared. That premise was wrong: `runtime.abort()`
 * returns when the DELETE does, the Java handler cancels and interrupts the
 * thread and replies 200, and `activeRuns`/`activeSessions` are only dropped when
 * the original execution reaches its finally. DELETE neither calls
 * `inspectAndDetach` nor clears persisted pending tool/ask state, so an absent
 * revocation proves the abort REQUEST was accepted — never that the execution
 * exited or that the session detached.
 *
 * The rule pinned here:
 *   1. runtime never started -> the cancelled status alone releases;
 *   2. runtime started + revocation present -> stays parked;
 *   3. runtime started + revocation gone, no clean/detached proof -> stays parked;
 *   4. proof recorded and acknowledged -> released by the existing RT-26 path.
 *
 * Branch 4's release half lives in the RT-26 suite
 * (`session-checkpoint.postgres.test.ts`: "releases a suspended admission only
 * after the proof is acknowledged"); the re-dispatch that triggers it is covered
 * by `session-admission-reconciler.test.ts` ("re-dispatches a cancelled owner
 * whose runtime started instead of releasing it"). This file deliberately does not
 * duplicate checkpoint-id, watermark, intervention or acknowledgement
 * construction — that is the logic the review said not to copy.
 *
 * Failure-scenario owners stay parked and are asserted as such: they write no
 * `run_abort` row, so any status-based release would be vacuously true.
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

  async function ownAdmission(
    run: { id: string; userId: string; spaceId: string; botId: string; threadId: string },
    lease: { runLeaseOwner: string; runLeaseFence: number },
    options: { runtimeStarted: boolean; ttlMs?: number },
  ): Promise<SessionAdmissionLease> {
    const acquired = await acquireSessionAdmission(
      prisma,
      identity(run, `exec-${randomUUID()}`, lease),
      { ttlMs: options.ttlMs },
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

  /** What the executor's finally does for a Run that ended unconfirmed. */
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

  /** What deliverRunAborts does once runtime.abort() returns: the row is deleted. */
  function deliverAbort(runId: string) {
    return prisma.executionRevocation.deleteMany({
      where: { kind: "run_abort", subjectId: runId },
    });
  }

  async function abortPending(runId: string) {
    const row = await prisma.executionRevocation.findFirst({
      where: { kind: "run_abort", subjectId: runId },
      select: { id: true },
    });
    return row !== null;
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

  async function terminalHolders(sessionKey: string) {
    return (await holders(sessionKey)).filter(
      (row) => row.ownerRunId !== null && TERMINAL.includes(row.runStatus ?? ""),
    );
  }

  async function oneEventCheckTick(now: Date) {
    await releaseCancelledSessionsThatNeverStarted(prisma, now);
    await recoverExpiredSessionAdmissions(prisma, now);
    return listAvailableSessionAdmissionHeads(prisma);
  }

  async function prepareSuccessor(botId: string, threadId: string, prompt: string) {
    const next = await newRun(botId, threadId, prompt);
    const lease = await claimRun(next);
    return { next, lease, executionId: `exec-${randomUUID()}` };
  }

  function attempt(prepared: Awaited<ReturnType<typeof prepareSuccessor>>, now: Date) {
    return acquireSessionAdmission(
      prisma,
      identity(prepared.next, prepared.executionId, prepared.lease),
      { now },
    );
  }

  it("branch 1: a session the runtime never entered is released on the cancelled status", async () => {
    const { bot, thread, sessionKey } = await newDirectSession();
    const stopped = await newRun(bot.id, thread.id);
    await ownAdmission(stopped, await claimRun(stopped), {
      runtimeStarted: false,
      ttlMs: 300_000,
    });

    await pressStop([{ id: stopped.id, taskId: stopped.taskId }], {
      threadId: thread.id,
      botId: bot.id,
    });
    // Stop still writes the abort revocation; it is irrelevant here because the
    // runtime never entered the session, so nothing can be inherited.
    expect(await abortPending(stopped.id)).toBe(true);

    const successor = await prepareSuccessor(bot.id, thread.id, "还在吗");
    const now = new Date();
    await oneEventCheckTick(now);
    const released = await attempt(successor, now);
    expect(
      { admission: released.kind, terminalHolders: await terminalHolders(sessionKey) },
      "a never-started cancelled owner must free the session without a proof",
    ).toEqual({ admission: "acquired", terminalHolders: [] });
  });

  it("branch 2: a started session with the abort still outstanding stays parked", async () => {
    const { bot, thread, sessionKey } = await newDirectSession();
    const stopped = await newRun(bot.id, thread.id);
    const admission = await ownAdmission(stopped, await claimRun(stopped), {
      runtimeStarted: true,
    });

    await pressStop([{ id: stopped.id, taskId: stopped.taskId }], {
      threadId: thread.id,
      botId: bot.id,
    });
    expect(await abortPending(stopped.id)).toBe(true);
    await parkAsExecutorDoes(admission);

    const successor = await prepareSuccessor(bot.id, thread.id, "1+1 等于几");
    const now = new Date();
    await oneEventCheckTick(now);
    const blocked = await attempt(successor, now);
    expect(
      { admission: blocked.kind, holders: await holders(sessionKey) },
      "an outstanding abort must keep the session",
    ).toEqual({
      admission: "recovering",
      holders: [{ state: "recovering", ownerRunId: stopped.id, runStatus: "cancelled" }],
    });
  });

  it("branch 3: revocation gone but no detach proof still keeps the session parked", async () => {
    const { bot, thread, sessionKey } = await newDirectSession();
    const stopped = await newRun(bot.id, thread.id);
    const admission = await ownAdmission(stopped, await claimRun(stopped), {
      runtimeStarted: true,
    });

    await pressStop([{ id: stopped.id, taskId: stopped.taskId }], {
      threadId: thread.id,
      botId: bot.id,
    });
    await parkAsExecutorDoes(admission);
    expect((await deliverAbort(stopped.id)).count).toBe(1);
    expect(await abortPending(stopped.id)).toBe(false);

    // The abort was accepted, but nothing proved the execution exited or that the
    // shared session is clean/detached. Releasing here is the bug this branch
    // exists to catch: a successor would inherit a half-persisted session.
    const successor = await prepareSuccessor(bot.id, thread.id, "1+1 等于几");
    const now = new Date();
    await oneEventCheckTick(now);
    const blocked = await attempt(successor, now);
    expect(
      { admission: blocked.kind, holders: await holders(sessionKey) },
      "an absent revocation is not a detach proof",
    ).toEqual({
      admission: "recovering",
      holders: [{ state: "recovering", ownerRunId: stopped.id, runStatus: "cancelled" }],
    });

    // The owner is classified for recovery rather than released.
    const toRecover = await listCancelledSessionsToRecover(prisma);
    expect(toRecover.map((row) => row.runId)).toContain(stopped.id);
  });

  it("branch 3b: the lease horizon is still not a proof", async () => {
    const { bot, thread, sessionKey } = await newDirectSession();
    const stopped = await newRun(bot.id, thread.id);
    const admission = await ownAdmission(stopped, await claimRun(stopped), {
      runtimeStarted: true,
      ttlMs: 1_000,
    });

    await pressStop([{ id: stopped.id, taskId: stopped.taskId }], {
      threadId: thread.id,
      botId: bot.id,
    });
    await parkAsExecutorDoes(admission);
    await deliverAbort(stopped.id);

    const afterHorizon = new Date(admission.expiresAt.getTime() + 5 * 60_000);
    const successor = await prepareSuccessor(bot.id, thread.id, "你还在吗");
    await oneEventCheckTick(afterHorizon);
    const blocked = await attempt(successor, afterHorizon);
    expect(blocked.kind, "an undelivered proof must not be replaced by the lease horizon").toBe(
      "recovering",
    );
    expect(await terminalHolders(sessionKey)).toHaveLength(1);
  });

  it("S2: appended steering is explicitly discarded and the session stays parked without a proof", async () => {
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

    const remaining = await prisma.steeringMessage.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { id: true },
    });
    expect(remaining, "S2: appended steering must be explicitly discarded by Stop").toEqual([]);

    await deliverAbort(stopped.id);
    const successor = await prepareSuccessor(bot.id, thread.id, "重新写一版");
    const blocked = await attempt(successor, new Date());
    expect(blocked.kind).toBe("recovering");
    expect(await terminalHolders(sessionKey)).toHaveLength(1);
  });

  it("S3: Stop that lands on an already terminal Run changes nothing and leaves the session usable", async () => {
    const { bot, thread, sessionKey } = await newDirectSession();
    const finished = await newRun(bot.id, thread.id);
    const admission = await ownAdmission(finished, await claimRun(finished), {
      runtimeStarted: true,
    });

    await prisma.run.update({ where: { id: finished.id }, data: { status: "completed" } });
    await prisma.task.update({ where: { id: finished.taskId }, data: { status: "completed" } });
    const released = await completeSessionAdmission(prisma, admission);
    expect(released.kind).toBe("released");

    const settled = await pressStop([{ id: finished.id, taskId: finished.taskId }], {
      threadId: thread.id,
      botId: bot.id,
    });
    expect(settled.rows, "S3: a completed Run must not be cancelled again").toEqual([]);
    expect(await abortPending(finished.id), "S3: no abort revocation for a no-op Stop").toBe(false);

    const afterStop = await prisma.run.findUniqueOrThrow({
      where: { id: finished.id },
      select: { status: true },
    });
    expect(afterStop.status).toBe("completed");
    const cancelledEvents = await prisma.event.count({
      where: { threadId: thread.id, type: "run.cancelled", runId: finished.id },
    });
    expect(cancelledEvents).toBe(0);

    const successor = await prepareSuccessor(bot.id, thread.id, "再来一条");
    const now = new Date();
    await oneEventCheckTick(now);
    expect((await attempt(successor, now)).kind).toBe("acquired");
    expect(await terminalHolders(sessionKey)).toEqual([]);
  });

  it("a failed owner stays parked: the boundary worker-chain.spec.ts:546 and :785 guard", async () => {
    const { bot, thread, sessionKey } = await newDirectSession();
    const failed = await newRun(bot.id, thread.id);
    const admission = await ownAdmission(failed, await claimRun(failed), {
      runtimeStarted: true,
    });
    await prisma.run.update({ where: { id: failed.id }, data: { status: "failed" } });
    await parkAsExecutorDoes(admission);
    expect(await abortPending(failed.id), "a failed Run has no run_abort revocation").toBe(false);

    const successor = await prepareSuccessor(bot.id, thread.id, "失败后再问一次");
    const blocked = await attempt(successor, new Date());
    expect(blocked.kind, "a failed owner must keep the RT-26 park").toBe("recovering");
    expect((await holders(sessionKey)).map((row) => row.state)).toEqual(["recovering"]);
  });
});
