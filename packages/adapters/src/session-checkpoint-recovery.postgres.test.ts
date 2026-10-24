import { randomUUID } from "node:crypto";
import type { AgentRuntimeEvent, AgentSessionCheckpointProof } from "@rakazo/adapter-kit";
import {
  acquireSessionAdmission,
  agentScopeChatSessionKey,
  computerHomeKey,
  computerScopeKey,
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  markSessionAdmissionRecovering,
  markSessionRuntimeStarted,
  type PrismaClient,
  prepareSessionExecution,
  sessionCheckpointId,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentScopeAgentRuntime } from "./agentscope-runtime.js";
import { createRunExecutor } from "./executor.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

/**
 * RT-26: the executor may release an RT-25 `recovering` owner only through a
 * fresh Runtime proof. An unreachable Runtime leaves the session blocked.
 */
describePostgres("session checkpoint recovery (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let computerId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("checkpoint_recovery");
    prisma = isolated.db.prisma;
    await prisma.user.create({
      data: { id, name: "Checkpoint recovery", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Checkpoint recovery", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Checkpoint recovery" } });
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
    const computer = await prisma.computer.create({
      data: {
        spaceId: id,
        userId: id,
        scope: "team",
        scopeKey: computerScopeKey("team", id),
        homeKey: computerHomeKey("team", id),
        kind: "sandbox",
      },
    });
    computerId = computer.id;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  class FakeAgentScopeRuntime extends AgentScopeAgentRuntime {
    constructor(private readonly detach: () => Promise<AgentSessionCheckpointProof>) {
      super({ baseUrl: "http://127.0.0.1:9" });
    }

    override inspectAndDetach(): Promise<AgentSessionCheckpointProof> {
      return this.detach();
    }

    // This fixture never executes the model.
    override run(): AsyncIterableIterator<AgentRuntimeEvent> {
      return (async function* () {})();
    }
  }

  function executor(runtime: AgentScopeAgentRuntime) {
    return createRunExecutor({
      prisma,
      events: {
        append: async () => undefined,
        notify: async () => undefined,
        finalizeRun: async () => null,
        pauseRunForInput: async () => false,
      },
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
      runtime,
    } as unknown as Parameters<typeof createRunExecutor>[0]);
  }

  async function recoveringOwner() {
    const bot = await prisma.bot.create({
      data: {
        spaceId: id,
        userId: id,
        name: `Recovery ${randomUUID()}`,
        color: "test",
        computerId,
      },
    });
    const botId = bot.id;
    const threadId = (await prisma.thread.create({ data: { spaceId: id, userId: id, botId } })).id;
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Pause", status: "waiting" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "waiting_input",
        trigger: "user",
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "waiting_input" },
    });
    const sessionKey = agentScopeChatSessionKey({
      userId: id,
      spaceId: id,
      botId,
      threadId,
      threadGeneration: 0,
    });
    const acquired = await acquireSessionAdmission(prisma, {
      userId: id,
      spaceId: id,
      botId,
      threadId,
      threadGeneration: 0,
      runId: run.id,
      executionId: `${run.id}:run-lease:1`,
      runLeaseOwner: "worker-1",
      runLeaseFence: 1,
    });
    if (acquired.kind !== "acquired") throw new Error(`admission was ${acquired.kind}`);
    const suspensionKey = `susp-${randomUUID()}`;
    await prepareSessionExecution(prisma, {
      ...acquired,
      attemptId: attempt.id,
      suspensionKey,
    });
    await markSessionRuntimeStarted(prisma, {
      ...acquired,
      attemptId: attempt.id,
      suspensionKey,
    });
    await markSessionAdmissionRecovering(
      prisma,
      acquired,
      "agentscope_runtime_outcome_unconfirmed",
    );
    const intervention = await prisma.intervention.create({
      data: {
        id: `itv-${randomUUID()}`,
        kind: "input",
        status: "pending",
        spaceId: id,
        threadId,
        runId: run.id,
        attemptId: attempt.id,
        botId,
        messageId: `msg-${randomUUID()}`,
        executionFence: acquired.admissionFence,
        suspensionKey,
        pendingRunKey: run.id,
      },
    });
    return { run, attempt, lease: acquired, suspensionKey, intervention, sessionKey };
  }

  it("keeps recovering when the Runtime cannot prove the slot", async () => {
    const owner = await recoveringOwner();
    const runtime = new FakeAgentScopeRuntime(async () => {
      throw new Error("Runtime unreachable");
    });
    await executor(runtime).continueRun(owner.run.id, "worker-2");

    const admission = await prisma.agentSessionAdmission.findUniqueOrThrow({
      where: { sessionKey: owner.lease.sessionKey },
    });
    expect(admission).toMatchObject({
      state: "recovering",
      ownerRunId: owner.run.id,
      ownerExecutionId: owner.lease.executionId,
      fence: owner.lease.admissionFence,
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: owner.run.id } })).toMatchObject({
      status: "waiting_input",
      leaseOwner: null,
    });
  });

  it("releases recovering only after a fresh acknowledged Runtime proof", async () => {
    const owner = await recoveringOwner();
    const checkpointId = sessionCheckpointId({
      runId: owner.run.id,
      attemptId: owner.attempt.id,
      admissionFence: owner.lease.admissionFence,
    });
    const runtime = new FakeAgentScopeRuntime(async () => {
      const proof: AgentSessionCheckpointProof = {
        kind: "clean",
        checkpointId,
        digest: "d".repeat(64),
        pendingCalls: [],
      };
      // The executor records and acknowledges the proof before releasing.
      return proof;
    });
    await executor(runtime)
      .continueRun(owner.run.id, "worker-2")
      .catch(() => undefined);

    const checkpoint = await prisma.agentSessionCheckpoint.findUniqueOrThrow({
      where: { id: checkpointId },
    });
    expect(checkpoint).toMatchObject({
      runId: owner.run.id,
      attemptId: owner.attempt.id,
      proofKind: "clean",
      status: "recorded",
    });
    expect(checkpoint.ackedAt).not.toBeNull();
    const admission = await prisma.agentSessionAdmission.findUniqueOrThrow({
      where: { sessionKey: owner.lease.sessionKey },
    });
    expect(admission.state).not.toBe("recovering");
    if (admission.state === "owned") {
      expect(admission.fence).toBeGreaterThan(owner.lease.admissionFence);
    }
  });

  it("does not release when the Runtime proves a different checkpoint", async () => {
    const owner = await recoveringOwner();
    const runtime = new FakeAgentScopeRuntime(async () => ({
      kind: "detached",
      checkpointId: "ckpt_otherowner01",
      digest: "e".repeat(64),
      pendingCalls: [{ id: "call-1", name: "tool", state: "asking" }],
    }));
    await executor(runtime)
      .continueRun(owner.run.id, "worker-2")
      .catch(() => undefined);
    expect(
      await prisma.agentSessionAdmission.findUniqueOrThrow({
        where: { sessionKey: owner.lease.sessionKey },
      }),
    ).toMatchObject({ state: "recovering", ownerRunId: owner.run.id });
    expect(await prisma.agentSessionCheckpoint.count({ where: { runId: owner.run.id } })).toBe(0);
  });
});
