import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireSessionAdmission,
  agentScopeChatSessionKey,
  completeSessionAdmission,
  createDb,
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  listAvailableSessionAdmissionHeads,
  markSessionAdmissionRecovering,
  markSessionRuntimeStarted,
  type PrismaClient,
  prepareSessionExecution,
  recoverExpiredSessionAdmissions,
  releaseSessionAdmission,
  renewSessionAdmission,
  requeueExpiredSessionAdmissionWaiter,
} from "./index.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("AgentScope chat session admission (PostgreSQL)", () => {
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let databaseUrl: string;
  const tenant = randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("session_admission");
    databaseUrl = isolated.databaseUrl;
    prisma = isolated.db.prisma;
    await prisma.user.create({
      data: {
        id: tenant,
        name: "Session admission test",
        email: `${tenant}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id: tenant, name: "Session admission test", slug: tenant, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: tenant, organizationId: tenant, name: "Session admission test" },
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
        prompt: "serialize me",
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

  async function newBot(label: string = randomUUID()) {
    return prisma.bot.create({
      data: { spaceId: tenant, userId: tenant, name: `Admission ${label}`, color: "test" },
    });
  }

  async function newDirectSession() {
    const bot = await newBot();
    const thread = await prisma.thread.create({
      data: { spaceId: tenant, userId: tenant, botId: bot.id },
    });
    return { bot, thread };
  }

  async function newGroupThread(botId: string) {
    const group = await prisma.chatGroup.create({
      data: { spaceId: tenant, userId: tenant, name: `Admission ${randomUUID()}` },
    });
    await prisma.chatGroupMember.create({ data: { groupId: group.id, botId } });
    return prisma.thread.create({ data: { spaceId: tenant, userId: tenant, groupId: group.id } });
  }

  function identity(
    run: { id: string; userId: string; spaceId: string; botId: string; threadId: string },
    executionId: string,
    threadGeneration = 0,
  ) {
    return {
      userId: run.userId,
      spaceId: run.spaceId,
      botId: run.botId,
      threadId: run.threadId,
      threadGeneration,
      runId: run.id,
      executionId,
      runLeaseOwner: `worker-${executionId}`,
      runLeaseFence: 1,
    };
  }

  it("keeps a second independent Run queued for the same Bot and Thread", async () => {
    const { bot, thread } = await newDirectSession();
    const first = await queuedRun(bot.id, thread.id);
    const second = await queuedRun(bot.id, thread.id);
    const firstLease = await acquireSessionAdmission(prisma, identity(first, "same-first"));
    const secondLease = await acquireSessionAdmission(prisma, identity(second, "same-second"));

    expect(firstLease.kind).toBe("acquired");
    expect(secondLease).toMatchObject({ kind: "queued", ownerRunId: first.id });
  });

  it("allows different Threads and different Bots to own sessions in parallel", async () => {
    const sharedBot = await newBot("shared");
    const firstThread = await newGroupThread(sharedBot.id);
    const secondThread = await newGroupThread(sharedBot.id);
    const differentThreadA = await queuedRun(sharedBot.id, firstThread.id);
    const differentThreadB = await queuedRun(sharedBot.id, secondThread.id);
    const { bot: otherBot, thread: otherThread } = await newDirectSession();
    const differentBot = await queuedRun(otherBot.id, otherThread.id);

    const [threadLeaseA, threadLeaseB, botLease] = await Promise.all([
      acquireSessionAdmission(prisma, identity(differentThreadA, "parallel-thread-a")),
      acquireSessionAdmission(prisma, identity(differentThreadB, "parallel-thread-b")),
      acquireSessionAdmission(prisma, identity(differentBot, "parallel-bot")),
    ]);

    expect(threadLeaseA.kind).toBe("acquired");
    expect(threadLeaseB.kind).toBe("acquired");
    expect(botLease.kind).toBe("acquired");
  });

  it("preserves FIFO order across a Worker restart", async () => {
    const { bot, thread } = await newDirectSession();
    const first = await queuedRun(bot.id, thread.id);
    const second = await queuedRun(bot.id, thread.id);
    const third = await queuedRun(bot.id, thread.id);
    const firstLease = await acquireSessionAdmission(prisma, identity(first, "restart-first"));
    await acquireSessionAdmission(prisma, identity(second, "restart-second"));
    await acquireSessionAdmission(prisma, identity(third, "restart-third"));
    expect(firstLease.kind).toBe("acquired");
    if (firstLease.kind !== "acquired") return;

    const restarted = createDb(databaseUrl, { applicationName: "session-admission-restart" });
    try {
      const released = await releaseSessionAdmission(restarted.prisma, firstLease);
      expect(released).toMatchObject({ kind: "released", nextRunId: second.id });
      const thirdEarly = await acquireSessionAdmission(
        restarted.prisma,
        identity(third, "restart-third-reclaimed"),
      );
      expect(thirdEarly).toMatchObject({ kind: "queued" });
      const secondLease = await acquireSessionAdmission(
        restarted.prisma,
        identity(second, "restart-second-reclaimed"),
      );
      expect(secondLease.kind).toBe("acquired");
    } finally {
      await restarted.prisma.$disconnect();
      await restarted.pool.end();
    }
  });

  it("moves every crash point to recovering after expiry and never hands off", async () => {
    for (const point of ["after-acquire", "in-runtime", "before-release"]) {
      const { bot, thread } = await newDirectSession();
      const owner = await queuedRun(bot.id, thread.id);
      const next = await queuedRun(bot.id, thread.id);
      const lease = await acquireSessionAdmission(prisma, identity(owner, `crash-${point}`), {
        ttlMs: 5,
      });
      expect(lease.kind).toBe("acquired");
      if (lease.kind !== "acquired") continue;
      if (point !== "after-acquire") {
        await prepareSessionExecution(prisma, {
          ...lease,
          attemptId: `attempt-${point}-${randomUUID()}`,
          suspensionKey: `suspension-${point}-${randomUUID()}`,
        });
      }
      await acquireSessionAdmission(prisma, identity(next, `next-${point}`));
      await recoverExpiredSessionAdmissions(prisma, new Date(lease.expiresAt.getTime() + 1));
      const blocked = await acquireSessionAdmission(prisma, identity(next, `next-${point}`));
      expect(blocked).toMatchObject({ kind: "recovering", ownerRunId: owner.id });
    }
  });

  it("rejects stale heartbeat, completion, and release after a new fence", async () => {
    const { bot, thread } = await newDirectSession();
    const first = await queuedRun(bot.id, thread.id);
    const second = await queuedRun(bot.id, thread.id);
    const firstLease = await acquireSessionAdmission(prisma, identity(first, "stale-first"));
    expect(firstLease.kind).toBe("acquired");
    if (firstLease.kind !== "acquired") return;
    await releaseSessionAdmission(prisma, firstLease);
    const secondLease = await acquireSessionAdmission(prisma, identity(second, "stale-second"));
    expect(secondLease.kind).toBe("acquired");
    if (secondLease.kind !== "acquired") return;
    expect(secondLease.admissionFence).toBeGreaterThan(firstLease.admissionFence);

    expect(await renewSessionAdmission(prisma, firstLease)).toBe(false);
    expect(await completeSessionAdmission(prisma, firstLease)).toMatchObject({ kind: "stale" });
    expect(await releaseSessionAdmission(prisma, firstLease)).toMatchObject({ kind: "stale" });
  });

  it("parks a Runtime 409 as queued/recovering instead of a business failure", async () => {
    const { bot, thread } = await newDirectSession();
    const run = await queuedRun(bot.id, thread.id);
    const lease = await acquireSessionAdmission(prisma, identity(run, "runtime-409"));
    expect(lease.kind).toBe("acquired");
    if (lease.kind !== "acquired") return;
    const promoted = await prisma.run.update({
      where: { id: run.id },
      data: {
        status: "running",
        leaseOwner: "worker-runtime-409",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: promoted.leaseFence, status: "running" },
    });
    await prisma.agentSessionAdmission.update({
      where: { sessionKey: lease.sessionKey },
      data: { ownerRunLeaseOwner: promoted.leaseOwner, ownerRunLeaseFence: promoted.leaseFence },
    });
    const prepared = { ...lease, attemptId: attempt.id, suspensionKey: randomUUID() };
    expect(await prepareSessionExecution(prisma, prepared)).toBe(true);
    expect(await markSessionRuntimeStarted(prisma, prepared)).toBe(true);
    expect(await markSessionAdmissionRecovering(prisma, lease, "agentscope_runtime_409")).toBe(
      true,
    );

    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "queued",
      error: null,
    });
    expect(
      await prisma.agentSessionAdmission.findUniqueOrThrow({
        where: { sessionKey: lease.sessionKey },
      }),
    ).toMatchObject({ state: "recovering", ownerRunId: run.id, fence: lease.admissionFence });
  });

  it("hands a paused session to the same Run without admitting another Run", async () => {
    const { bot, thread } = await newDirectSession();
    const owner = await queuedRun(bot.id, thread.id);
    const waiter = await queuedRun(bot.id, thread.id);
    const paused = await acquireSessionAdmission(prisma, identity(owner, "paused-owner"));
    expect(paused.kind).toBe("acquired");
    if (paused.kind !== "acquired") return;
    const attempt = await prisma.attempt.create({
      data: { runId: owner.id, fence: 1, status: "waiting_input" },
    });
    expect(
      await prepareSessionExecution(prisma, {
        ...paused,
        attemptId: attempt.id,
        suspensionKey: "paused-suspension",
      }),
    ).toBe(true);
    await acquireSessionAdmission(prisma, identity(waiter, "paused-waiter"));

    const resumedIdentity = {
      ...identity(owner, "paused-resume"),
      runLeaseFence: 2,
    };
    const resumed = await acquireSessionAdmission(prisma, resumedIdentity);
    expect(resumed.kind).toBe("acquired");
    if (resumed.kind !== "acquired") return;
    expect(resumed.admissionFence).toBeGreaterThan(paused.admissionFence);
    expect(await acquireSessionAdmission(prisma, identity(waiter, "paused-waiter"))).toMatchObject({
      kind: "queued",
      ownerRunId: owner.id,
    });
    expect(await acquireSessionAdmission(prisma, identity(owner, "paused-owner"))).toMatchObject({
      kind: "queued",
      ownerRunId: owner.id,
    });
    expect(await renewSessionAdmission(prisma, paused)).toBe(false);
    expect(await completeSessionAdmission(prisma, paused)).toMatchObject({ kind: "stale" });
    expect(await releaseSessionAdmission(prisma, paused)).toMatchObject({ kind: "stale" });
    expect(await renewSessionAdmission(prisma, resumed)).toBe(true);

    expect(
      await prisma.agentSessionAdmission.findUniqueOrThrow({
        where: { sessionKey: resumed.sessionKey },
      }),
    ).toMatchObject({
      state: "owned",
      ownerRunId: owner.id,
      ownerExecutionId: resumedIdentity.executionId,
      ownerRunLeaseFence: 2,
      ownerAttemptId: null,
      suspensionKey: null,
      executionPreparedAt: null,
      runtimeStartedAt: null,
    });
    expect(
      await prisma.agentSessionAdmissionRequest.findUniqueOrThrow({
        where: { executionId: paused.executionId },
      }),
    ).toMatchObject({ state: "released" });
    expect(
      await prisma.agentSessionAdmissionRequest.findUniqueOrThrow({
        where: { executionId: resumed.executionId },
      }),
    ).toMatchObject({ state: "owned" });
  });

  it("makes duplicate scheduling idempotent with one owner and one fence", async () => {
    const { bot, thread } = await newDirectSession();
    const run = await queuedRun(bot.id, thread.id);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        acquireSessionAdmission(prisma, identity(run, "duplicate-schedule")),
      ),
    );
    expect(results.every((result) => result.kind === "acquired")).toBe(true);
    const fences = new Set(
      results.flatMap((result) => (result.kind === "acquired" ? [result.admissionFence] : [])),
    );
    expect(fences.size).toBe(1);
  });

  it("requeues an expired Run claim that crashed after persisting its queued request", async () => {
    const { bot, thread } = await newDirectSession();
    const owner = await queuedRun(bot.id, thread.id);
    const waiter = await queuedRun(bot.id, thread.id);
    const ownerLease = await acquireSessionAdmission(prisma, identity(owner, "claim-gap-owner"));
    expect(ownerLease.kind).toBe("acquired");
    const expiredAt = new Date(Date.now() - 1_000);
    const waiterIdentity = {
      ...identity(waiter, "claim-gap-waiter"),
      runLeaseOwner: "crashed-worker",
      runLeaseFence: 17,
    };
    await prisma.run.update({
      where: { id: waiter.id },
      data: {
        status: "leased",
        leaseOwner: waiterIdentity.runLeaseOwner,
        leaseFence: waiterIdentity.runLeaseFence,
        leaseExpiresAt: expiredAt,
      },
    });
    const waiting = await acquireSessionAdmission(prisma, waiterIdentity);
    expect(waiting.kind).toBe("queued");
    const request = await prisma.agentSessionAdmissionRequest.findUniqueOrThrow({
      where: { executionId: waiterIdentity.executionId },
    });

    await expect(
      requeueExpiredSessionAdmissionWaiter(
        prisma,
        {
          sessionKey: request.sessionKey,
          runId: waiter.id,
          executionId: waiterIdentity.executionId,
          runLeaseOwner: waiterIdentity.runLeaseOwner,
          runLeaseFence: waiterIdentity.runLeaseFence,
        },
        new Date(),
      ),
    ).resolves.toBe(true);
    await expect(prisma.run.findUniqueOrThrow({ where: { id: waiter.id } })).resolves.toMatchObject(
      {
        status: "queued",
        leaseOwner: null,
        error: null,
      },
    );
    await expect(
      prisma.agentSessionAdmissionRequest.findUniqueOrThrow({
        where: { executionId: waiterIdentity.executionId },
      }),
    ).resolves.toMatchObject({ state: "queued" });
  });

  it("does not let a cancelled queued Run block the durable FIFO head", async () => {
    const { bot, thread } = await newDirectSession();
    const owner = await queuedRun(bot.id, thread.id);
    const cancelled = await queuedRun(bot.id, thread.id);
    const next = await queuedRun(bot.id, thread.id);
    const ownerLease = await acquireSessionAdmission(prisma, identity(owner, "cancel-owner"));
    expect(ownerLease.kind).toBe("acquired");
    if (ownerLease.kind !== "acquired") return;
    await acquireSessionAdmission(prisma, identity(cancelled, "cancel-waiter"));
    await acquireSessionAdmission(prisma, identity(next, "cancel-next"));

    await expect(releaseSessionAdmission(prisma, ownerLease)).resolves.toMatchObject({
      kind: "released",
      nextRunId: cancelled.id,
    });
    await prisma.run.update({ where: { id: cancelled.id }, data: { status: "cancelled" } });

    await expect(listAvailableSessionAdmissionHeads(prisma)).resolves.toContainEqual({
      sessionKey: ownerLease.sessionKey,
      runId: next.id,
    });
  });

  it("keeps chat admission independent from a computer execution lease", async () => {
    const { bot, thread } = await newDirectSession();
    const run = await queuedRun(bot.id, thread.id);
    const computer = await prisma.computer.create({
      data: {
        userId: tenant,
        spaceId: tenant,
        homeKey: randomUUID(),
        scope: "team",
        scopeKey: randomUUID(),
        kind: "sandbox",
      },
    });
    await prisma.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: bot.id,
        runId: "computer-owner",
        fence: 9,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    expect(
      (await acquireSessionAdmission(prisma, identity(run, "computer-independent"))).kind,
    ).toBe("acquired");
  });

  it("acquires isolated PostgreSQL resources for tenant, Space, Bot, Thread, and generation", async () => {
    const { bot, thread } = await newDirectSession();
    const base = {
      userId: "user-a",
      spaceId: "space-a",
      botId: "bot-a",
      threadId: "thread-a",
      threadGeneration: 0,
    };
    const keys = [
      agentScopeChatSessionKey(base),
      agentScopeChatSessionKey({ ...base, userId: "user-b" }),
      agentScopeChatSessionKey({ ...base, spaceId: "space-b" }),
      agentScopeChatSessionKey({ ...base, botId: "bot-b" }),
      agentScopeChatSessionKey({ ...base, threadId: "thread-b" }),
      agentScopeChatSessionKey({ ...base, threadGeneration: 1 }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    const runs = await Promise.all(Array.from({ length: 6 }, () => queuedRun(bot.id, thread.id)));
    const acquired = await Promise.all(
      [
        base,
        { ...base, userId: "user-b" },
        { ...base, spaceId: "space-b" },
        { ...base, botId: "bot-b" },
        { ...base, threadId: "thread-b" },
        { ...base, threadGeneration: 1 },
      ].map((entry, index) =>
        acquireSessionAdmission(prisma, {
          ...entry,
          runId: runs[index]!.id,
          executionId: `isolation-execution-${index}`,
          runLeaseOwner: `isolation-worker-${index}`,
          runLeaseFence: 1,
        }),
      ),
    );
    expect(acquired.every((result) => result.kind === "acquired")).toBe(true);
  });
});
