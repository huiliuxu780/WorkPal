import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acknowledgeSessionCheckpoint,
  acquireSessionAdmission,
  beginCheckpointResume,
  createIsolatedPostgresDatabase,
  findResumableCheckpoint,
  type IsolatedPostgresDatabase,
  loadThreadContextAfterCheckpoint,
  markCheckpointResumeConsumed,
  markCheckpointResumeRestored,
  markSessionAdmissionRecovering,
  markSessionRuntimeStarted,
  type PrismaClient,
  prepareSessionExecution,
  recordCheckpointProof,
  releaseRecoveredSessionAdmission,
  releaseSuspendedSessionAdmission,
  sessionCheckpointId,
} from "./index.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

function digestOf(label: string): string {
  return label.padEnd(64, "0").slice(0, 64);
}

describePostgres("RT-26 AgentScope session checkpoint (PostgreSQL)", () => {
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  const tenant = randomUUID();
  let generation = 0;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("session_checkpoint");
    prisma = isolated.db.prisma;
    await prisma.user.create({
      data: {
        id: tenant,
        name: "Session checkpoint test",
        email: `${tenant}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id: tenant, name: "Session checkpoint test", slug: tenant, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: tenant, organizationId: tenant, name: "Session checkpoint test" },
    });
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

  async function queuedRun(botId: string, threadId: string) {
    const task = await prisma.task.create({
      data: {
        spaceId: tenant,
        userId: tenant,
        botId,
        threadId,
        prompt: "isolate pending state",
        status: "queued",
      },
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

  async function newDirectSession() {
    const bot = await prisma.bot.create({
      data: { spaceId: tenant, userId: tenant, name: `Checkpoint ${randomUUID()}`, color: "test" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: tenant, userId: tenant, botId: bot.id },
    });
    return { bot, thread };
  }

  async function ownedAdmission(
    run: {
      id: string;
      userId: string;
      spaceId: string;
      botId: string;
      threadId: string;
    },
    reuseGeneration?: number,
  ) {
    generation += 1;
    const threadGeneration = reuseGeneration ?? generation;
    const acquired = await acquireSessionAdmission(prisma, {
      userId: run.userId,
      spaceId: run.spaceId,
      botId: run.botId,
      threadId: run.threadId,
      threadGeneration,
      runId: run.id,
      executionId: `${run.id}:run-lease:${threadGeneration}:${generation}`,
      runLeaseOwner: `worker-${generation}`,
      runLeaseFence: generation,
    });
    if (acquired.kind !== "acquired") throw new Error(`admission was ${acquired.kind}`);
    return { lease: acquired, threadGeneration };
  }

  async function prepared(lease: Awaited<ReturnType<typeof ownedAdmission>>["lease"]) {
    const attempt = await prisma.attempt.create({
      data: { runId: lease.runId, fence: lease.admissionFence, status: "running" },
    });
    const suspensionKey = `susp-${randomUUID()}`;
    expect(
      await prepareSessionExecution(prisma, {
        ...lease,
        attemptId: attempt.id,
        suspensionKey,
      }),
    ).toBe(true);
    expect(
      await markSessionRuntimeStarted(prisma, {
        ...lease,
        attemptId: attempt.id,
        suspensionKey,
      }),
    ).toBe(true);
    return { attempt, suspensionKey };
  }

  async function pauseCard(input: {
    runId: string;
    attemptId: string;
    fence: number;
    suspensionKey: string;
    status?: "pending" | "answered";
    threadId: string;
    botId: string;
    spaceId: string;
  }) {
    return prisma.intervention.create({
      data: {
        id: `itv_${randomUUID()}`,
        kind: "input",
        status: input.status ?? "pending",
        spaceId: input.spaceId,
        threadId: input.threadId,
        runId: input.runId,
        attemptId: input.attemptId,
        botId: input.botId,
        messageId: `msg_${randomUUID()}`,
        executionFence: input.fence,
        suspensionKey: input.suspensionKey,
        pendingRunKey: input.status === "answered" ? null : input.runId,
        resolvedAt: input.status === "answered" ? new Date() : null,
      },
    });
  }

  async function checkpointFor(input: {
    lease: { runId: string; sessionKey: string; executionId: string; admissionFence: number };
    attemptId: string;
    suspensionKey: string;
    threadGeneration: number;
    interventionId?: string | null;
    proofKind?: "clean" | "detached";
    digest?: string;
    ack?: boolean;
  }) {
    const binding = {
      sessionKey: input.lease.sessionKey,
      runId: input.lease.runId,
      attemptId: input.attemptId,
      executionId: input.lease.executionId,
      admissionFence: input.lease.admissionFence,
      suspensionKey: input.suspensionKey,
    };
    const proof = {
      kind: input.proofKind ?? "detached",
      checkpointId: sessionCheckpointId(binding),
      digest: input.digest ?? digestOf(randomUUID().replace(/-/g, "")),
      pendingCalls: [{ id: "call-1", name: "ask_user", state: "asking" }],
    };
    await recordCheckpointProof(prisma, {
      binding,
      proof,
      threadGeneration: input.threadGeneration,
    });
    if (input.ack !== false) {
      expect(
        await acknowledgeSessionCheckpoint(prisma, {
          binding,
          proof,
          pendingInterventionId: input.interventionId ?? null,
          coveredMessageSeq: 0,
        }),
      ).toBe(true);
    }
    return { binding, proof };
  }

  it("persists one proof per binding and refuses a mismatched acknowledgement", async () => {
    const { bot, thread } = await newDirectSession();
    const run = await queuedRun(bot.id, thread.id);
    const { lease, threadGeneration } = await ownedAdmission(run);
    const { attempt, suspensionKey } = await prepared(lease);
    const card = await pauseCard({
      runId: run.id,
      attemptId: attempt.id,
      fence: lease.admissionFence,
      suspensionKey,
      threadId: thread.id,
      botId: bot.id,
      spaceId: tenant,
    });
    const { binding, proof } = await checkpointFor({
      lease,
      attemptId: attempt.id,
      suspensionKey,
      threadGeneration,
      interventionId: card.id,
      ack: false,
    });

    // Repeating the identical Runtime proof is idempotent.
    await expect(
      recordCheckpointProof(prisma, { binding, proof, threadGeneration }),
    ).resolves.toMatchObject({ id: proof.checkpointId, proofKind: "detached" });
    // A different digest can never replace the persisted proof.
    await expect(
      recordCheckpointProof(prisma, {
        binding,
        proof: { ...proof, digest: digestOf("f".repeat(64)) },
        threadGeneration,
      }),
    ).rejects.toThrow("does not match its persisted binding");

    expect(
      await acknowledgeSessionCheckpoint(prisma, {
        binding,
        proof,
        pendingInterventionId: card.id,
        coveredMessageSeq: 3,
      }),
    ).toBe(true);
    // The ack is idempotent once the exact card binding matched.
    expect(
      await acknowledgeSessionCheckpoint(prisma, {
        binding,
        proof,
        pendingInterventionId: card.id,
        coveredMessageSeq: 3,
      }),
    ).toBe(true);
  });

  it("never claims a card created under another attempt, fence, or suspension key", async () => {
    const { bot, thread } = await newDirectSession();
    const run = await queuedRun(bot.id, thread.id);
    const { lease, threadGeneration } = await ownedAdmission(run);
    const { attempt, suspensionKey } = await prepared(lease);
    const foreign = await pauseCard({
      runId: run.id,
      attemptId: attempt.id,
      fence: lease.admissionFence + 1,
      suspensionKey,
      threadId: thread.id,
      botId: bot.id,
      spaceId: tenant,
    });
    const { binding, proof } = await checkpointFor({
      lease,
      attemptId: attempt.id,
      suspensionKey,
      threadGeneration,
      ack: false,
    });
    expect(
      await acknowledgeSessionCheckpoint(prisma, {
        binding,
        proof,
        pendingInterventionId: foreign.id,
        coveredMessageSeq: 0,
      }),
    ).toBe(false);
    await expect(
      prisma.agentSessionCheckpoint.findUniqueOrThrow({ where: { id: proof.checkpointId } }),
    ).resolves.toMatchObject({ ackedAt: null, status: "recorded" });
  });

  it("releases a suspended admission only after the proof is acknowledged", async () => {
    const { bot, thread } = await newDirectSession();
    const owner = await queuedRun(bot.id, thread.id);
    const waiter = await queuedRun(bot.id, thread.id);
    const { lease, threadGeneration } = await ownedAdmission(owner);
    const { attempt, suspensionKey } = await prepared(lease);
    const card = await pauseCard({
      runId: owner.id,
      attemptId: attempt.id,
      fence: lease.admissionFence,
      suspensionKey,
      status: "answered",
      threadId: thread.id,
      botId: bot.id,
      spaceId: tenant,
    });
    await acquireSessionAdmission(prisma, {
      userId: waiter.userId,
      spaceId: waiter.spaceId,
      botId: waiter.botId,
      threadId: waiter.threadId,
      threadGeneration,
      runId: waiter.id,
      executionId: `${waiter.id}:run-lease:queued`,
      runLeaseOwner: "waiter",
      runLeaseFence: 1,
    });
    const { binding, proof } = await checkpointFor({
      lease,
      attemptId: attempt.id,
      suspensionKey,
      threadGeneration,
      interventionId: card.id,
      ack: false,
    });
    const ref = { kind: proof.kind, checkpointId: proof.checkpointId, digest: proof.digest };
    // CRASH BOUNDARY 1: the proof was recorded but never acknowledged.
    await expect(releaseSuspendedSessionAdmission(prisma, lease, ref)).resolves.toEqual({
      kind: "unconfirmed",
    });
    await expect(
      prisma.agentSessionAdmission.findUniqueOrThrow({ where: { sessionKey: lease.sessionKey } }),
    ).resolves.toMatchObject({ state: "owned", ownerRunId: owner.id });

    expect(
      await acknowledgeSessionCheckpoint(prisma, {
        binding,
        proof,
        pendingInterventionId: card.id,
        coveredMessageSeq: 5,
      }),
    ).toBe(true);
    // CRASH BOUNDARY 2: acknowledged but the worker died before releasing.
    await expect(releaseSuspendedSessionAdmission(prisma, lease, ref)).resolves.toEqual({
      kind: "released",
      nextRunId: waiter.id,
    });
    await expect(
      prisma.agentSessionAdmission.findUniqueOrThrow({ where: { sessionKey: lease.sessionKey } }),
    ).resolves.toMatchObject({ state: "available", lastReleaseReason: "suspended_checkpoint" });
    // Releasing the same acknowledged owner again is idempotent, never a new hand-off.
    await expect(releaseSuspendedSessionAdmission(prisma, lease, ref)).resolves.toEqual({
      kind: "released",
      nextRunId: waiter.id,
    });
  });

  it("keeps an RT-25 recovering owner until a fresh proof is acknowledged", async () => {
    const { bot, thread } = await newDirectSession();
    const owner = await queuedRun(bot.id, thread.id);
    const { lease, threadGeneration } = await ownedAdmission(owner);
    const { attempt, suspensionKey } = await prepared(lease);
    const card = await pauseCard({
      runId: owner.id,
      attemptId: attempt.id,
      fence: lease.admissionFence,
      suspensionKey,
      threadId: thread.id,
      botId: bot.id,
      spaceId: tenant,
    });
    expect(
      await markSessionAdmissionRecovering(prisma, lease, "checkpoint_detach_unconfirmed"),
    ).toBe(true);

    // Runtime unreachable: no checkpoint row exists for the claimed proof.
    await expect(
      releaseRecoveredSessionAdmission(prisma, {
        lease,
        attemptId: attempt.id,
        suspensionKey,
        proof: {
          kind: "detached",
          checkpointId: sessionCheckpointId({
            runId: owner.id,
            attemptId: attempt.id,
            admissionFence: lease.admissionFence,
          }),
          digest: digestOf("a".repeat(64)),
        },
      }),
    ).resolves.toEqual({ kind: "unconfirmed" });
    await expect(
      prisma.agentSessionAdmission.findUniqueOrThrow({ where: { sessionKey: lease.sessionKey } }),
    ).resolves.toMatchObject({ state: "recovering", ownerRunId: owner.id });

    const { proof } = await checkpointFor({
      lease,
      attemptId: attempt.id,
      suspensionKey,
      threadGeneration,
      interventionId: card.id,
    });
    // A proof of a different suspension key is not this owner's proof.
    await expect(
      releaseRecoveredSessionAdmission(prisma, {
        lease,
        attemptId: attempt.id,
        suspensionKey: "another-suspension",
        proof: { kind: proof.kind, checkpointId: proof.checkpointId, digest: proof.digest },
      }),
    ).resolves.toEqual({ kind: "stale" });
    await expect(
      releaseRecoveredSessionAdmission(prisma, {
        lease,
        attemptId: attempt.id,
        suspensionKey,
        proof: { kind: proof.kind, checkpointId: proof.checkpointId, digest: proof.digest },
      }),
    ).resolves.toMatchObject({ kind: "released" });
  });

  it("isolates Run A from Run B and only resumes the owning Run", async () => {
    const { bot, thread } = await newDirectSession();
    const runA = await queuedRun(bot.id, thread.id);
    const runB = await queuedRun(bot.id, thread.id);
    const { lease, threadGeneration } = await ownedAdmission(runA);
    const { attempt, suspensionKey } = await prepared(lease);
    const card = await pauseCard({
      runId: runA.id,
      attemptId: attempt.id,
      fence: lease.admissionFence,
      suspensionKey,
      status: "answered",
      threadId: thread.id,
      botId: bot.id,
      spaceId: tenant,
    });
    const { proof } = await checkpointFor({
      lease,
      attemptId: attempt.id,
      suspensionKey,
      threadGeneration,
      interventionId: card.id,
    });
    await releaseSuspendedSessionAdmission(prisma, lease, {
      kind: proof.kind,
      checkpointId: proof.checkpointId,
      digest: proof.digest,
    });

    // CRASH BOUNDARY 3: resume prepared, then the worker died.
    const resumeB = await beginCheckpointResume(prisma, {
      checkpointId: proof.checkpointId,
      runId: runB.id,
      sessionKey: lease.sessionKey,
      threadGeneration,
      resume: {
        attemptId: "attempt-b",
        executionId: "execution-b",
        admissionFence: lease.admissionFence + 100,
        suspensionKey: "suspension-b",
      },
      decisionKey: `${card.id}:2`,
      answer: "yes",
    });
    expect(resumeB.kind).toBe("rejected");
    expect(
      await findResumableCheckpoint(prisma, {
        runId: runB.id,
        sessionKey: lease.sessionKey,
        threadGeneration,
      }),
    ).toBeNull();
    const resumableA = await findResumableCheckpoint(prisma, {
      runId: runA.id,
      sessionKey: lease.sessionKey,
      threadGeneration,
    });
    expect(resumableA).toMatchObject({ id: proof.checkpointId, proofKind: "detached" });
    expect(resumableA?.intervention).toMatchObject({ id: card.id, status: "answered" });

    const decisionKey = `${card.id}:2`;
    const started = await beginCheckpointResume(prisma, {
      checkpointId: proof.checkpointId,
      runId: runA.id,
      sessionKey: lease.sessionKey,
      threadGeneration,
      resume: {
        attemptId: "attempt-a2",
        executionId: "execution-a2",
        admissionFence: lease.admissionFence + 1,
        suspensionKey: "suspension-a2",
      },
      decisionKey,
      answer: "yes",
    });
    expect(started.kind).toBe("started");
    // A retry of the SAME decision under the same execution replays the answer.
    await expect(
      beginCheckpointResume(prisma, {
        checkpointId: proof.checkpointId,
        runId: runA.id,
        sessionKey: lease.sessionKey,
        threadGeneration,
        resume: {
          attemptId: "attempt-a2",
          executionId: "execution-a2",
          admissionFence: lease.admissionFence + 1,
          suspensionKey: "suspension-a2",
        },
        decisionKey,
        answer: "yes",
      }),
    ).resolves.toMatchObject({ kind: "replayed" });
    // A different answer for one card revision is a conflict.
    await expect(
      beginCheckpointResume(prisma, {
        checkpointId: proof.checkpointId,
        runId: runA.id,
        sessionKey: lease.sessionKey,
        threadGeneration,
        resume: {
          attemptId: "attempt-a2",
          executionId: "execution-a2",
          admissionFence: lease.admissionFence + 1,
          suspensionKey: "suspension-a2",
        },
        decisionKey,
        answer: "no",
      }),
    ).resolves.toEqual({ kind: "rejected", reason: "decision_conflict" });

    if (started.kind === "rejected") return;
    expect(
      await markCheckpointResumeRestored(prisma, {
        resumeId: started.resumeId,
        executionId: "execution-a2",
      }),
    ).toBe(true);
    // CRASH BOUNDARY 4: restored, then the worker died before consuming.
    expect(
      await markCheckpointResumeConsumed(prisma, {
        resumeId: started.resumeId,
        executionId: "execution-a2",
      }),
    ).toBe(true);
    expect(
      await markCheckpointResumeConsumed(prisma, {
        resumeId: started.resumeId,
        executionId: "execution-a2",
      }),
    ).toBe(false);
    await expect(
      prisma.agentSessionCheckpoint.findUniqueOrThrow({ where: { id: proof.checkpointId } }),
    ).resolves.toMatchObject({ status: "consumed" });
    expect(
      await findResumableCheckpoint(prisma, {
        runId: runA.id,
        sessionKey: lease.sessionKey,
        threadGeneration,
      }),
    ).toBeNull();
  });

  it("binds a crashed retry of the same decision to the new fence and suspension key", async () => {
    const { bot, thread } = await newDirectSession();
    const run = await queuedRun(bot.id, thread.id);
    const { lease, threadGeneration } = await ownedAdmission(run);
    const { attempt, suspensionKey } = await prepared(lease);
    const card = await pauseCard({
      runId: run.id,
      attemptId: attempt.id,
      fence: lease.admissionFence,
      suspensionKey,
      status: "answered",
      threadId: thread.id,
      botId: bot.id,
      spaceId: tenant,
    });
    const { proof } = await checkpointFor({
      lease,
      attemptId: attempt.id,
      suspensionKey,
      threadGeneration,
      interventionId: card.id,
    });
    const decisionKey = `${card.id}:3`;
    const first = await beginCheckpointResume(prisma, {
      checkpointId: proof.checkpointId,
      runId: run.id,
      sessionKey: lease.sessionKey,
      threadGeneration,
      resume: {
        attemptId: "attempt-crashed",
        executionId: "execution-crashed",
        admissionFence: lease.admissionFence + 1,
        suspensionKey: "suspension-crashed",
      },
      decisionKey,
      answer: "approve",
    });
    expect(first.kind).toBe("started");
    const retried = await beginCheckpointResume(prisma, {
      checkpointId: proof.checkpointId,
      runId: run.id,
      sessionKey: lease.sessionKey,
      threadGeneration,
      resume: {
        attemptId: "attempt-retry",
        executionId: "execution-retry",
        admissionFence: lease.admissionFence + 2,
        suspensionKey: "suspension-retry",
      },
      decisionKey,
      answer: "approve",
    });
    expect(retried).toMatchObject({
      kind: "replayed",
      resumeId: first.kind === "started" ? first.resumeId : "",
    });
    await expect(
      prisma.agentSessionCheckpointResume.findUniqueOrThrow({
        where: { decisionKey },
      }),
    ).resolves.toMatchObject({
      attemptId: "attempt-retry",
      executionId: "execution-retry",
      fence: lease.admissionFence + 2,
      suspensionKey: "suspension-retry",
      status: "prepared",
    });
    // The crashed binding can no longer mark or consume the rebound resume.
    expect(
      await markCheckpointResumeRestored(prisma, {
        resumeId: first.kind === "started" ? first.resumeId : "",
        executionId: "execution-crashed",
      }),
    ).toBe(false);
  });

  it("records a second pause under a new fence and suspension key", async () => {
    const { bot, thread } = await newDirectSession();
    const run = await queuedRun(bot.id, thread.id);
    const first = await ownedAdmission(run);
    const firstPause = await prepared(first.lease);
    const firstCard = await pauseCard({
      runId: run.id,
      attemptId: firstPause.attempt.id,
      fence: first.lease.admissionFence,
      suspensionKey: firstPause.suspensionKey,
      status: "answered",
      threadId: thread.id,
      botId: bot.id,
      spaceId: tenant,
    });
    const firstCheckpoint = await checkpointFor({
      lease: first.lease,
      attemptId: firstPause.attempt.id,
      suspensionKey: firstPause.suspensionKey,
      threadGeneration: first.threadGeneration,
      interventionId: firstCard.id,
    });
    const begun = await beginCheckpointResume(prisma, {
      checkpointId: firstCheckpoint.proof.checkpointId,
      runId: run.id,
      sessionKey: first.lease.sessionKey,
      threadGeneration: first.threadGeneration,
      resume: {
        attemptId: "attempt-second",
        executionId: "execution-second",
        admissionFence: first.lease.admissionFence + 1,
        suspensionKey: "suspension-second",
      },
      decisionKey: `${firstCard.id}:2`,
      answer: "yes",
    });
    expect(begun.kind).toBe("started");
    if (begun.kind === "rejected") return;
    await markCheckpointResumeRestored(prisma, {
      resumeId: begun.resumeId,
      executionId: "execution-second",
    });
    await markCheckpointResumeConsumed(prisma, {
      resumeId: begun.resumeId,
      executionId: "execution-second",
    });

    // The same Run pauses again after its restore: new attempt, fence, and key.
    const second = await ownedAdmission(run, first.threadGeneration);
    expect(second.lease.admissionFence).toBeGreaterThan(first.lease.admissionFence);
    const secondPause = await prepared(second.lease);
    expect(secondPause.suspensionKey).not.toBe(firstPause.suspensionKey);
    const secondCard = await pauseCard({
      runId: run.id,
      attemptId: secondPause.attempt.id,
      fence: second.lease.admissionFence,
      suspensionKey: secondPause.suspensionKey,
      status: "answered",
      threadId: thread.id,
      botId: bot.id,
      spaceId: tenant,
    });
    const secondCheckpoint = await checkpointFor({
      lease: second.lease,
      attemptId: secondPause.attempt.id,
      suspensionKey: secondPause.suspensionKey,
      threadGeneration: second.threadGeneration,
      interventionId: secondCard.id,
    });
    expect(secondCheckpoint.proof.checkpointId).not.toBe(firstCheckpoint.proof.checkpointId);
    await expect(
      prisma.agentSessionCheckpoint.findUniqueOrThrow({
        where: { id: firstCheckpoint.proof.checkpointId },
      }),
    ).resolves.toMatchObject({ status: "consumed" });
    await expect(
      prisma.agentSessionCheckpoint.findUniqueOrThrow({
        where: { id: secondCheckpoint.proof.checkpointId },
      }),
    ).resolves.toMatchObject({ status: "recorded", ackedAt: expect.any(Date) });
    expect(
      await findResumableCheckpoint(prisma, {
        runId: run.id,
        sessionKey: second.lease.sessionKey,
        threadGeneration: second.threadGeneration,
      }),
    ).toMatchObject({ id: secondCheckpoint.proof.checkpointId });
  });

  it("loads only trusted Thread messages appended after the checkpoint watermark", async () => {
    const { bot, thread } = await newDirectSession();
    const ownRun = await queuedRun(bot.id, thread.id);
    await prisma.message.createMany({
      data: [
        {
          threadId: thread.id,
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "before the pause" }],
        },
        {
          threadId: thread.id,
          seq: 2,
          role: "user",
          blocks: [{ kind: "text", text: "after the pause" }],
          originKind: "user",
        },
        {
          threadId: thread.id,
          seq: 3,
          role: "assistant",
          blocks: [{ kind: "text", text: "own ask while paused" }],
          runId: ownRun.id,
        },
        {
          threadId: thread.id,
          seq: 4,
          role: "assistant",
          blocks: [{ kind: "text", text: "another Run's answer" }],
        },
      ],
    });
    await expect(
      loadThreadContextAfterCheckpoint(prisma, {
        threadId: thread.id,
        afterSeq: 1,
        excludeRunId: ownRun.id,
      }),
    ).resolves.toEqual([
      { seq: 2, role: "user", content: "after the pause" },
      { seq: 4, role: "assistant", content: "another Run's answer" },
    ]);
  });

  it("includes Run B's persisted bot replies in the resumed context as assistant rows", async () => {
    // RT-26 review (P2): production bot replies persist with role "bot"
    // (events.ts), not "assistant". While Run A is suspended, Run B turns on
    // the same Thread; restoring A must carry B's reply into the merge window
    // — normalized to "assistant" for the runtime contract — while A's own
    // traffic stays excluded and the PostgreSQL seq order is preserved.
    const { bot, thread } = await newDirectSession();
    const runA = await queuedRun(bot.id, thread.id);
    const runB = await queuedRun(bot.id, thread.id);
    await prisma.message.createMany({
      data: [
        {
          threadId: thread.id,
          seq: 1,
          role: "user",
          originKind: "user",
          blocks: [{ kind: "text", text: "question before the pause" }],
        },
        {
          threadId: thread.id,
          seq: 2,
          role: "bot",
          originKind: "bot",
          botId: bot.id,
          runId: runB.id,
          blocks: [{ kind: "text", text: "Run B reply while A was suspended" }],
        },
        {
          threadId: thread.id,
          seq: 3,
          role: "user",
          originKind: "user",
          blocks: [{ kind: "text", text: "follow-up from the user" }],
        },
        {
          threadId: thread.id,
          seq: 4,
          role: "bot",
          originKind: "bot",
          botId: bot.id,
          runId: runA.id,
          blocks: [{ kind: "text", text: "Run A's own pause card" }],
        },
        {
          threadId: thread.id,
          seq: 5,
          role: "system",
          originKind: "system",
          blocks: [{ kind: "text", text: "internal system row" }],
        },
      ],
    });
    await expect(
      loadThreadContextAfterCheckpoint(prisma, {
        threadId: thread.id,
        afterSeq: 1,
        excludeRunId: runA.id,
      }),
    ).resolves.toEqual([
      { seq: 2, role: "assistant", content: "Run B reply while A was suspended" },
      { seq: 3, role: "user", content: "follow-up from the user" },
    ]);
  });
});
