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
 * VERIFY-01 S1–S4 + FIX-STOP-01: one Bot, one conversation, no child Runs, no
 * takeover, no multi-Bot. This is the most common user path — press Stop, then
 * say something else — and it is the 2026-10-27 QA P0-3 counterexample: the Run
 * becomes `cancelled` and every later message in that conversation stays
 * `queued` past the five-minute lease horizon.
 *
 * Production paths exercised here:
 *   - Stop: `apps/api/src/thread-target.ts` `stopThreadRuns()` →
 *     `applyCancelTerminalPolicy(cancelPolicyFor("user_stopped"))`, which writes
 *     the Run's `run_abort` execution revocation in the same transaction.
 *   - Native abort: `apps/worker/src/index.ts` sweeps that revocation through
 *     `deliverRunAborts(() => runtime.abort(id))`, which deletes the row only
 *     after the abort returns. This file models that deletion with
 *     `confirmNativeAbort()` instead of importing the adapter layer.
 *   - Admission: `packages/adapters/src/executor.ts` sets `sessionMayRelease =
 *     false` once the runtime started, and its `finally` block calls
 *     `markSessionAdmissionRecovering(...,
 *     "agentscope_runtime_outcome_unconfirmed")` for a Run that ended
 *     unconfirmed and is not parked on a card. A cancelled Run is exactly that.
 *     A normally completed Run goes through `completeSessionAdmission`.
 *   - Fallback: `apps/worker/src/session-admission-reconciler.ts` →
 *     `recoverExpiredSessionAdmissions()` and
 *     `releaseSettledCancelledSessionAdmissions()`.
 *
 * FIX-STOP-01 releases the session only when the owner is `cancelled` AND its
 * `run_abort` revocation is gone. Every cancellation scenario therefore asserts
 * BOTH branches: still parked while the abort is undelivered, handed over once it
 * is confirmed. A `failed` owner is asserted to stay parked — that is the
 * boundary worker-chain.spec.ts:546/:785 guard.
 *
 * Two assertions from the task card are deliberately NOT made here because the
 * persistence layer cannot observe them: the conversation header no longer
 * showing Running/Queued, and the absence of "recovering session admission could
 * not be proven" in the worker log. The scenario map records them as uncovered
 * by this file rather than claiming them.
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

  /**
   * What `deliverRunAborts` does once `runtime.abort(id)` returns: the
   * `run_abort` revocation is deleted. A thrown abort leaves the row in place,
   * which the "still parked" assertions below model.
   */
  function confirmNativeAbort(runId: string) {
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

  async function terminalHolders(sessionKey: string) {
    return (await holders(sessionKey)).filter(
      (row) => row.ownerRunId !== null && TERMINAL.includes(row.runStatus ?? ""),
    );
  }

  /** One reconciler pass on an explicit clock. No sleeping, no TTL wait. */
  async function oneEventCheckTick(now: Date) {
    await recoverExpiredSessionAdmissions(prisma, now);
    return listAvailableSessionAdmissionHeads(prisma);
  }

  /** Prepare the successor Run and one stable attempt identity for it. */
  async function prepareSuccessor(botId: string, threadId: string, prompt: string) {
    const next = await newRun(botId, threadId, prompt);
    const lease = await claimRun(next);
    return { next, lease, executionId: `exec-${randomUUID()}` };
  }

  /** Same identity both times, so the queued request is reused, not duplicated. */
  function attempt(prepared: Awaited<ReturnType<typeof prepareSuccessor>>, now: Date) {
    return acquireSessionAdmission(
      prisma,
      identity(prepared.next, prepared.executionId, prepared.lease),
      { now },
    );
  }

  it("S1: cancelling an in-flight generation hands the session over only after the abort is confirmed", async () => {
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
    // Stop writes the abort revocation in the same transaction as the status flip.
    expect(await abortPending(stopped.id), "Stop must leave a run_abort revocation").toBe(true);
    await parkAsExecutorDoes(admission);

    const successor = await prepareSuccessor(bot.id, thread.id, "1+1 等于几");
    const now = new Date();

    // Branch 1 — abort still undelivered: the session stays parked and queued.
    const blocked = await attempt(successor, now);
    expect(
      {
        phase: "abort-pending",
        admission: blocked.kind,
        holders: await holders(sessionKey),
      },
      "a cancelled owner whose native abort has not returned must keep the session",
    ).toEqual({
      phase: "abort-pending",
      admission: "recovering",
      holders: [{ state: "recovering", ownerRunId: stopped.id, runStatus: "cancelled" }],
    });

    // Branch 2 — the Worker's deliverRunAborts deleted the revocation.
    expect((await confirmNativeAbort(stopped.id)).count).toBe(1);
    const released = await attempt(successor, now);
    expect(
      {
        phase: "abort-confirmed",
        admission: released.kind,
        runId: released.kind === "acquired" ? released.runId : null,
        expected: successor.next.id,
        terminalHolders: await terminalHolders(sessionKey),
      },
      "once the abort is confirmed the next Run must own the session in the same tick",
    ).toEqual({
      phase: "abort-confirmed",
      admission: "acquired",
      runId: successor.next.id,
      expected: successor.next.id,
      terminalHolders: [],
    });
  });

  it("S1b: cancelling before the runtime started follows the same two facts, not the TTL", async () => {
    const { bot, thread, sessionKey } = await newDirectSession();
    const stopped = await newRun(bot.id, thread.id);
    // TTL far in the future: only the abort confirmation can free the session.
    await ownAdmission(stopped, await claimRun(stopped), {
      runtimeStarted: false,
      ttlMs: 300_000,
    });

    await pressStop([{ id: stopped.id, taskId: stopped.taskId }], {
      threadId: thread.id,
      botId: bot.id,
    });
    expect(await abortPending(stopped.id)).toBe(true);

    const successor = await prepareSuccessor(bot.id, thread.id, "还在吗");
    const now = new Date();
    const blocked = await attempt(successor, now);
    // The runtime never started, so the admission is still `owned` rather than
    // `recovering`; the successor therefore queues instead of being told to wait
    // for recovery. Both states block, and this pins the exact one.
    expect(
      { admission: blocked.kind, holders: await holders(sessionKey) },
      "abort pending must still block even with a valid TTL",
    ).toEqual({
      admission: "queued",
      holders: [{ state: "owned", ownerRunId: stopped.id, runStatus: "cancelled" }],
    });

    expect((await confirmNativeAbort(stopped.id)).count).toBe(1);
    const released = await attempt(successor, now);
    expect(released.kind).toBe("acquired");
    expect(await terminalHolders(sessionKey)).toEqual([]);
  });

  it("S2: appended steering is explicitly discarded and the session follows the same abort fact", async () => {
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

    // Recorded before the session assertions so a parked admission cannot hide
    // the steering fact. `user_stopped` carries steering: "delete".
    const remaining = await prisma.steeringMessage.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { id: true },
    });
    expect(remaining, "S2: appended steering must be explicitly discarded by Stop").toEqual([]);

    const successor = await prepareSuccessor(bot.id, thread.id, "重新写一版");
    const now = new Date();
    expect((await attempt(successor, now)).kind).toBe("recovering");

    expect((await confirmNativeAbort(stopped.id)).count).toBe(1);
    const released = await attempt(successor, now);
    expect(released.kind).toBe("acquired");
    expect(await terminalHolders(sessionKey)).toEqual([]);
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
    expect(await abortPending(finished.id), "S3: no abort revocation for a no-op Stop").toBe(false);

    const afterStop = await prisma.run.findUniqueOrThrow({
      where: { id: finished.id },
      select: { status: true },
    });
    expect(afterStop.status, "S3: the Run keeps its real terminal state").toBe("completed");

    const cancelledEvents = await prisma.event.count({
      where: { threadId: thread.id, type: "run.cancelled", runId: finished.id },
    });
    expect(cancelledEvents, "S3: no extra terminal event for an already finished Run").toBe(0);

    const successor = await prepareSuccessor(bot.id, thread.id, "再来一条");
    const now = new Date();
    await oneEventCheckTick(now);
    const acquired = await attempt(successor, now);
    expect(acquired.kind, "S3: the session must stay usable after a raced Stop").toBe("acquired");
    expect(await terminalHolders(sessionKey)).toEqual([]);
  });

  it("S4: a worker restart or expired lease frees a cancelled session only after the abort is confirmed", async () => {
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

    const parked = await holders(sessionKey);
    expect(
      parked.map((row) => row.state),
      "S4 precondition: parked as recovering",
    ).toEqual(["recovering"]);

    // The worker is gone and the lease horizon has passed, but the native abort
    // was never confirmed: time alone must not hand the session over.
    const afterHorizon = new Date(admission.expiresAt.getTime() + 5 * 60_000);
    const successor = await prepareSuccessor(bot.id, thread.id, "你还在吗");
    await oneEventCheckTick(afterHorizon);
    const blocked = await attempt(successor, afterHorizon);
    expect(blocked.kind, "S4: an undelivered abort must not be replaced by the lease horizon").toBe(
      "recovering",
    );

    // Now the abort is confirmed; the same successor must take the session.
    expect((await confirmNativeAbort(stopped.id)).count).toBe(1);
    const released = await attempt(successor, afterHorizon);
    expect(released.kind).toBe("acquired");
    expect(await terminalHolders(sessionKey)).toEqual([]);
  });

  it("a failed owner stays parked: the boundary worker-chain.spec.ts:546 and :785 guard", async () => {
    const { bot, thread, sessionKey } = await newDirectSession();
    const failed = await newRun(bot.id, thread.id);
    const admission = await ownAdmission(failed, await claimRun(failed), {
      runtimeStarted: true,
    });
    // A Run that fails on its own never writes a run_abort revocation, so the
    // "no revocation" half of the predicate is vacuously true for it. Releasing
    // on that would hand the session over while the failed Run's session state is
    // still unsettled, which is exactly what those two worker-chain specs forbid.
    await prisma.run.update({ where: { id: failed.id }, data: { status: "failed" } });
    await parkAsExecutorDoes(admission);
    expect(await abortPending(failed.id), "a failed Run has no run_abort revocation").toBe(false);

    const successor = await prepareSuccessor(bot.id, thread.id, "失败后再问一次");
    const blocked = await attempt(successor, new Date());
    expect(blocked.kind, "a failed owner must keep the RT-26 park").toBe("recovering");
    expect((await holders(sessionKey)).map((row) => row.state)).toEqual(["recovering"]);
  });
});
