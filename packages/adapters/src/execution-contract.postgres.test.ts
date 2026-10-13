import { randomUUID } from "node:crypto";
import type { AdapterContext, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { buildRunOrchestration } from "@rakazo/core";
import {
  appendEvent,
  BackgroundRegistrationRejected,
  backgroundTaskLockTransactionOptions,
  cancelRunsInTransaction,
  computerHomeKey,
  computerScopeKey,
  createDb,
  createGroupRepos,
  createIsolatedPostgresDatabase,
  createThreadEvents,
  type IsolatedPostgresDatabase,
  loadExecutionSnapshot,
  markLiveBackgroundTasksCancelling,
  type Prisma,
  type PrismaClient,
  promoteLeasedRunWithAttempt,
  registerBackgroundTaskProjection,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { archiveBot, destroyBot } from "./child-bots.js";
import { createRunExecutor } from "./executor.js";
import { createJobReconciler } from "./job-reconciler.js";
import {
  retryPendingBackgroundRevocations,
  retryPendingRunAborts,
  revokeCancellingBackgroundTasks,
} from "./revoke-cancelled-work.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("execution contract recovery (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let botId: string;
  let threadId: string;
  let computerId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("exec_ad");
    db = isolated.db;
    prisma = db.prisma;
    await prisma.user.create({
      data: { id, name: "Recovery test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Recovery test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Recovery test" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: { id, spaceId: id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
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
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Recovery bot", color: "test", computerId },
    });
    botId = bot.id;
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId } });
    threadId = thread.id;
  }, 180_000);

  let side: ReturnType<typeof createDb> | undefined;

  function sidePrisma() {
    if (!side) {
      const connectionString = db.pool.options.connectionString;
      if (!connectionString) throw new Error("isolated database url is unavailable");
      side = createDb(connectionString, { applicationName: "wp_exec_ad_side", poolMax: 4 });
    }
    return side.prisma;
  }

  afterAll(async () => {
    await side?.prisma.$disconnect().catch(() => undefined);
    await side?.pool.end().catch(() => undefined);
    await isolated?.drop();
  }, 60_000);

  function executor() {
    const enqueue = vi.fn(async (_job?: unknown) => undefined);
    const abort = vi.fn(async () => undefined);
    const created = createRunExecutor({
      prisma,
      events: createThreadEvents(prisma),
      jobs: { enqueue, cancel: vi.fn(async () => undefined) },
      runtime: { abort },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    return { executor: created, enqueue, abort };
  }

  async function queuedRun() {
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Start", status: "queued" },
    });
    return prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "queued",
        trigger: "user",
      },
    });
  }

  it("requeues a busy computer without leaving a running run or attempt", async () => {
    const holder = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Holder", color: "test" },
    });
    await prisma.computerExecutionLease.create({
      data: {
        computerId,
        botId,
        runId: `held-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const run = await queuedRun();
    await executor().executor.continueRun(run.id, "worker-a");
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "queued",
      leaseOwner: null,
    });
    expect(await prisma.attempt.count({ where: { runId: run.id } })).toBe(0);
    await prisma.computerExecutionLease.deleteMany({ where: { computerId, botId } });
    expect(holder.id).toBeTruthy();
  });

  it("does not create a second attempt for one fence when the job is repeated", async () => {
    const run = await queuedRun();
    const { executor: first } = executor();
    await Promise.allSettled([
      first.continueRun(run.id, "worker-a"),
      first.continueRun(run.id, "worker-b"),
    ]);
    const attempts = await prisma.attempt.findMany({ where: { runId: run.id } });
    expect(new Set(attempts.map((attempt) => attempt.fence)).size).toBe(attempts.length);
    const stored = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    if (stored.status === "running" || stored.status === "leased") {
      expect(
        await promoteLeasedRunWithAttempt(prisma, {
          runId: run.id,
          leaseOwner: stored.leaseOwner ?? "worker-a",
          leaseFence: stored.leaseFence,
          startedAt: new Date(),
        }),
      ).toBeNull();
      expect(await prisma.attempt.count({ where: { runId: run.id, fence: stored.leaseFence } })).toBeLessThanOrEqual(1);
    }
    await first.continueRun(run.id, "worker-c");
    const after = await prisma.attempt.groupBy({
      by: ["fence"],
      where: { runId: run.id },
      _count: { _all: true },
    });
    expect(after.every((row) => row._count._all === 1)).toBe(true);
  });

  it("finishes native background revocation after a transport failure", async () => {
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Background", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id, userId: id, botId, threadId, taskId: task.id, status: "cancelled", trigger: "user",
        completedAt: new Date(),
      },
    });
    const taskId = `bg-${run.id}`;
    await prisma.backgroundAgentTask.create({
      data: {
        taskId,
        parentRunId: run.id,
        userId: id,
        spaceId: id,
        botId,
        threadId,
        agentId: "helper",
        sessionId: "helper-session",
        toolNames: [],
        status: "cancelling",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const failed = await revokeCancellingBackgroundTasks(prisma, async () => {
      throw new Error("connection reset");
    });
    expect(failed.pending).toContain(taskId);
    expect(await prisma.backgroundAgentTask.findUniqueOrThrow({ where: { taskId } })).toMatchObject({
      status: "cancelling",
    });
    const recovered = await revokeCancellingBackgroundTasks(prisma, async () => false);
    expect(recovered.revoked).toContain(taskId);
    expect(recovered.pending).not.toContain(taskId);
    expect(await prisma.backgroundAgentTask.findUniqueOrThrow({ where: { taskId } })).toMatchObject({
      status: "cancelled",
    });
  });

  it("versions background cancellation on a completed parent Run at both visible transitions", async () => {
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        prompt: "Background projection",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "completed",
        trigger: "user",
        completedAt: new Date(),
      },
    });
    await appendEvent(prisma, {
      spaceId: id,
      threadId,
      botId,
      runId: run.id,
      type: "run.completed",
      payload: {},
    });
    const taskId = `bg-version-${run.id}`;
    await prisma.backgroundAgentTask.create({
      data: {
        taskId,
        parentRunId: run.id,
        userId: id,
        spaceId: id,
        botId,
        threadId,
        agentId: "helper",
        sessionId: "helper-session",
        toolNames: [],
        status: "running",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const read = () => loadExecutionSnapshot(prisma, { threadId, spaceId: id, runId: run.id });
    const before = await read();
    expect(before?.activityPage.items.find((item) => item.id === `bg:${taskId}`)?.status).toBe(
      "running",
    );
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "threads" WHERE "id" = ${threadId} FOR UPDATE`;
      await markLiveBackgroundTasksCancelling(tx, { taskId });
    });
    const cancelling = await read();
    expect(cancelling!.summary.rev).toBeGreaterThan(before!.summary.rev);
    expect(cancelling?.activityPage.items.find((item) => item.id === `bg:${taskId}`)?.status).toBe(
      "failed",
    );
    const recovered = await revokeCancellingBackgroundTasks(prisma, async () => false, {
      parentRunIds: [run.id],
    });
    expect(recovered.revoked).toContain(taskId);
    const cancelled = await read();
    expect(cancelled!.summary.rev).toBeGreaterThan(cancelling!.summary.rev);
    expect(cancelled?.activityPage.items.find((item) => item.id === `bg:${taskId}`)?.status).toBe(
      "cancelled",
    );
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "completed",
    );
  });

  it("does not let lease recovery or the reconciler revive a cancelled run", async () => {
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Expired", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "lost-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() - 1_000),
        retryAt: new Date(Date.now() - 1_000),
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    const { executor: recovery, enqueue } = executor();
    await Promise.allSettled([
      recovery.continueRun(run.id, "new-worker"),
      prisma.$transaction(async (tx) => {
        await tx.run.updateMany({
          where: { id: run.id, status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] } },
          data: {
            status: "cancelled",
            waitKind: null,
            waitStartedAt: null,
            retryAt: null,
            completedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        await tx.attempt.updateMany({
          where: { id: attempt.id, status: { in: ["running", "waiting_input", "waiting_takeover"] } },
          data: { status: "cancelled", finishedAt: new Date() },
        });
      }),
    ]);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
      leaseOwner: null,
      retryAt: null,
    });
    enqueue.mockClear();
    await recovery.continueRun(run.id, "later-worker");
    const reconciler = createJobReconciler({
      prisma,
      jobs: { enqueue, cancel: vi.fn(async () => undefined) } as unknown as JobPublisher,
    });
    await reconciler.reconcileOnce();
    const enqueuedThisRun = enqueue.mock.calls.some((call) => JSON.stringify(call[0]).includes(run.id));
    expect(enqueuedThisRun).toBe(false);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await prisma.attempt.count({ where: { runId: run.id, status: "running" } })).toBe(0);
  });

  it("propagates bot archive and deletion to descendant runs", async () => {
    const jobs = { cancel: vi.fn(async () => undefined), enqueue: vi.fn(async () => undefined) };
    const abort = vi.fn(async () => undefined);
    const sandbox = new Proxy(
      {},
      { get: () => vi.fn(async () => undefined) },
    ) as SandboxProvider;
    const deps = {
      prisma,
      sandbox,
      home: {} as never,
      jobs: jobs as unknown as JobPublisher,
      runtime: { abort },
    };
    const context = {
      operationId: "lifecycle",
      traceId: "lifecycle",
      spaceId: id,
      userId: id,
      botId,
      signal: new AbortController().signal,
    } as AdapterContext;

    async function childOf(parentRunId: string, fromBotId: string) {
      const childBot = await prisma.bot.create({
        data: { spaceId: id, userId: id, name: `Desc ${randomUUID().slice(0, 8)}`, color: "test" },
      });
      const childThread = await prisma.thread.create({
        data: { spaceId: id, userId: id, botId: childBot.id },
      });
      const task = await prisma.task.create({
        data: {
          spaceId: id, userId: id, botId: childBot.id, threadId: childThread.id,
          prompt: "desc", status: "running",
        },
      });
      const child = await prisma.run.create({
        data: {
          spaceId: id, userId: id, botId: childBot.id, threadId: childThread.id, taskId: task.id,
          status: "running", trigger: "bot_message",
          orchestration: buildRunOrchestration({
            kind: "bot_message",
            ownerBotId: childBot.id,
            responseMode: "single",
            collaboration: {
              role: "support",
              source: "bot_message",
              fromBotId,
              parentRunId,
              handoffDepth: 0,
              messageHop: 1,
            },
          }),
        },
      });
      await prisma.backgroundAgentTask.create({
        data: {
          taskId: `life-${child.id}`,
          parentRunId: child.id,
          userId: id,
          spaceId: id,
          botId: childBot.id,
          threadId: childThread.id,
          agentId: "helper",
          sessionId: "session",
          toolNames: [],
          status: "running",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      return child;
    }

    const archivedBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Archive me", color: "test" },
    });
    const archivedThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: archivedBot.id },
    });
    const archivedTask = await prisma.task.create({
      data: {
        spaceId: id, userId: id, botId: archivedBot.id, threadId: archivedThread.id,
        prompt: "live", status: "running",
      },
    });
    const archivedRun = await prisma.run.create({
      data: {
        spaceId: id, userId: id, botId: archivedBot.id, threadId: archivedThread.id,
        taskId: archivedTask.id, status: "running", trigger: "user", leaseFence: 6,
      },
    });
    await prisma.attempt.create({ data: { runId: archivedRun.id, fence: 6, status: "running" } });
    const archivedChild = await childOf(archivedRun.id, archivedBot.id);
    await archiveBot(
      deps,
      { ...archivedBot, archivedAt: null, userId: id },
      { ...context, botId: archivedBot.id },
    );
    expect(await prisma.run.findUniqueOrThrow({ where: { id: archivedRun.id } })).toMatchObject({
      status: "cancelled",
      leaseFence: 6,
      leaseOwner: null,
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: archivedChild.id } })).toMatchObject({
      status: "cancelled",
      error: "parent_cancelled",
    });
    expect(
      await prisma.backgroundAgentTask.findUniqueOrThrow({ where: { taskId: `life-${archivedChild.id}` } }),
    ).toMatchObject({ status: "cancelling" });
    expect(abort).toHaveBeenCalledWith(archivedRun.id);
    expect(abort).toHaveBeenCalledWith(archivedChild.id);
    expect(await prisma.event.count({ where: { runId: archivedRun.id, type: "run.cancelled" } })).toBe(1);

    const removedBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Delete me", color: "test" },
    });
    const removedThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: removedBot.id },
    });
    const removedTask = await prisma.task.create({
      data: {
        spaceId: id, userId: id, botId: removedBot.id, threadId: removedThread.id,
        prompt: "live", status: "running",
      },
    });
    const removedRun = await prisma.run.create({
      data: {
        spaceId: id, userId: id, botId: removedBot.id, threadId: removedThread.id,
        taskId: removedTask.id, status: "running", trigger: "user",
      },
    });
    const removedChild = await childOf(removedRun.id, removedBot.id);
    await destroyBot(
      deps,
      { ...removedBot, archivedAt: null, userId: id },
      { ...context, botId: removedBot.id },
      { deleteMemories: true },
    );
    expect(await prisma.run.findUnique({ where: { id: removedRun.id } })).toBeNull();
    expect(await prisma.run.findUniqueOrThrow({ where: { id: removedChild.id } })).toMatchObject({
      status: "cancelled",
      error: "parent_cancelled",
    });
    expect(abort).toHaveBeenCalledWith(removedChild.id);
    expect(await prisma.event.count({ where: { runId: removedChild.id, type: "run.cancelled" } })).toBe(1);
  });

  it("retries a failed run abort on the next worker pass", async () => {
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Abort", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id, userId: id, botId, threadId, taskId: task.id, status: "running", trigger: "user",
      },
    });
    await prisma.$transaction((tx) =>
      cancelRunsInTransaction(tx, [{ id: run.id, taskId: task.id }], new Date()),
    );
    const key = { kind_subjectId: { kind: "run_abort", subjectId: run.id } };
    expect(await prisma.executionRevocation.findUnique({ where: key })).toMatchObject({
      attempts: 0,
      runId: run.id,
    });
    const failed = await retryPendingRunAborts(
      prisma,
      async () => {
        throw new Error("run delete failed");
      },
      { runIds: [run.id] },
    );
    expect(failed.pending).toContain(run.id);
    expect(await prisma.executionRevocation.findUnique({ where: key })).toMatchObject({
      attempts: 1,
      lastError: "run delete failed",
    });
    const recovered = await retryPendingRunAborts(prisma, async () => undefined, { runIds: [run.id] });
    expect(recovered.revoked).toContain(run.id);
    expect(await prisma.executionRevocation.findUnique({ where: key })).toBeNull();
  });

  it("retries a background deletion after the bot cascade removes the projection", async () => {
    const removedBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Tombstone bot", color: "test" },
    });
    const removedThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: removedBot.id },
    });
    const task = await prisma.task.create({
      data: {
        spaceId: id, userId: id, botId: removedBot.id, threadId: removedThread.id,
        prompt: "bg", status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id, userId: id, botId: removedBot.id, threadId: removedThread.id,
        taskId: task.id, status: "running", trigger: "user",
      },
    });
    const taskId = `tomb-${run.id}`;
    await prisma.backgroundAgentTask.create({
      data: {
        taskId,
        parentRunId: run.id,
        userId: id,
        spaceId: id,
        botId: removedBot.id,
        threadId: removedThread.id,
        agentId: "helper",
        sessionId: "session",
        toolNames: [],
        status: "running",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const cancel = vi.fn(async () => {
      throw new Error("background delete failed");
    });
    await destroyBot(
      {
        prisma,
        sandbox: new Proxy({}, { get: () => vi.fn(async () => undefined) }) as SandboxProvider,
        home: {} as never,
        jobs: { cancel: vi.fn(async () => undefined), enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher,
        runtime: { abort: vi.fn(async () => undefined) },
        cancelRuntimeBackgroundTask: cancel,
      },
      { ...removedBot, archivedAt: null, userId: id },
      {
        operationId: "tombstone",
        traceId: "tombstone",
        spaceId: id,
        userId: id,
        botId: removedBot.id,
        signal: new AbortController().signal,
      } as AdapterContext,
      { deleteMemories: true },
    );
    expect(await prisma.bot.findUnique({ where: { id: removedBot.id } })).toBeNull();
    expect(await prisma.backgroundAgentTask.findUnique({ where: { taskId } })).toBeNull();
    const key = { kind_subjectId: { kind: "background_task", subjectId: taskId } };
    expect(await prisma.executionRevocation.findUnique({ where: key })).toMatchObject({
      taskId,
      runId: run.id,
    });
    expect((await prisma.executionRevocation.findUnique({ where: key }))?.attempts).toBeGreaterThanOrEqual(1);
    const recovered = await retryPendingBackgroundRevocations(prisma, async () => false, {
      taskIds: [taskId],
    });
    expect(recovered.revoked).toContain(taskId);
    expect(await prisma.executionRevocation.findUnique({ where: key })).toBeNull();
  });

  it("retries a background deletion after the group cascade removes the projection", async () => {
    const partner = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Group partner", color: "test" },
    });
    const repos = createGroupRepos(prisma);
    const group = await repos.createGroup({ userId: id, spaceId: id } as never, {
      name: "Tombstone group",
      botIds: [botId, partner.id],
    });
    const task = await prisma.task.create({
      data: {
        spaceId: id, userId: id, botId, threadId: group.threadId, prompt: "group bg", status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id, userId: id, botId, threadId: group.threadId, taskId: task.id,
        status: "running", trigger: "user",
      },
    });
    const taskId = `group-tomb-${run.id}`;
    await prisma.backgroundAgentTask.create({
      data: {
        taskId,
        parentRunId: run.id,
        userId: id,
        spaceId: id,
        botId,
        threadId: group.threadId,
        agentId: "helper",
        sessionId: "session",
        toolNames: [],
        status: "running",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await repos.removeGroup({ userId: id, spaceId: id } as never, group.id);
    expect(await prisma.backgroundAgentTask.findUnique({ where: { taskId } })).toBeNull();
    expect(await prisma.run.findUnique({ where: { id: run.id } })).toBeNull();
    const key = { kind_subjectId: { kind: "background_task", subjectId: taskId } };
    expect(await prisma.executionRevocation.findUnique({ where: key })).toMatchObject({ taskId });
    const failed = await retryPendingBackgroundRevocations(
      prisma,
      async () => {
        throw new Error("group delete failed");
      },
      { taskIds: [taskId] },
    );
    expect(failed.pending).toContain(taskId);
    expect(await prisma.executionRevocation.findUnique({ where: key })).toMatchObject({
      attempts: 1,
      lastError: "group delete failed",
    });
    const recovered = await retryPendingBackgroundRevocations(prisma, async () => false, {
      taskIds: [taskId],
    });
    expect(recovered.revoked).toContain(taskId);
    expect(await prisma.executionRevocation.findUnique({ where: key })).toBeNull();
  });

  it("archives a running background task after its parent run has completed", async () => {
    const archivedBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Archive completed parent", color: "test" },
    });
    const archivedThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: archivedBot.id },
    });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: archivedBot.id,
        threadId: archivedThread.id,
        prompt: "bg",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: archivedBot.id,
        threadId: archivedThread.id,
        taskId: task.id,
        status: "completed",
        trigger: "user",
        completedAt: new Date(),
      },
    });
    const taskId = `archive-done-${run.id}`;
    await prisma.backgroundAgentTask.create({
      data: {
        taskId,
        parentRunId: run.id,
        userId: id,
        spaceId: id,
        botId: archivedBot.id,
        threadId: archivedThread.id,
        agentId: "helper",
        sessionId: "session",
        toolNames: [],
        status: "running",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const abort = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => {
      throw new Error("background delete failed");
    });
    await archiveBot(
      {
        prisma,
        sandbox: new Proxy({}, { get: () => vi.fn(async () => undefined) }) as SandboxProvider,
        home: {} as never,
        jobs: { cancel: vi.fn(async () => undefined), enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher,
        runtime: { abort },
        cancelRuntimeBackgroundTask: cancel,
      },
      { ...archivedBot, archivedAt: null, userId: id },
      {
        operationId: "archive-completed-parent",
        traceId: "archive-completed-parent",
        spaceId: id,
        userId: id,
        botId: archivedBot.id,
        signal: new AbortController().signal,
      } as AdapterContext,
    );
    expect(abort).not.toHaveBeenCalled();
    expect(await prisma.bot.findUniqueOrThrow({ where: { id: archivedBot.id } })).toMatchObject({
      archivedAt: expect.any(Date),
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "completed",
    });
    expect(await prisma.backgroundAgentTask.findUniqueOrThrow({ where: { taskId } })).toMatchObject({
      status: "cancelling",
    });
    expect(
      await prisma.executionRevocation.findUnique({
        where: { kind_subjectId: { kind: "run_abort", subjectId: run.id } },
      }),
    ).toBeNull();
    const recovered = await revokeCancellingBackgroundTasks(prisma, async () => false, {
      parentRunIds: [run.id],
    });
    expect(recovered.revoked).toContain(taskId);
    expect(await prisma.backgroundAgentTask.findUniqueOrThrow({ where: { taskId } })).toMatchObject({
      status: "cancelled",
    });
  });

  it("tombstones a dissolved group's background task after its parent run has completed", async () => {
    const partner = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Dissolve partner", color: "test" },
    });
    const removedBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Dissolve bot", color: "test" },
    });
    const repos = createGroupRepos(prisma);
    const group = await repos.createGroup({ userId: id, spaceId: id } as never, {
      name: "Dissolve completed parent",
      botIds: [removedBot.id, partner.id],
    });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: partner.id,
        threadId: group.threadId,
        prompt: "group bg",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: partner.id,
        threadId: group.threadId,
        taskId: task.id,
        status: "completed",
        trigger: "user",
        completedAt: new Date(),
      },
    });
    const taskId = `dissolve-done-${run.id}`;
    await prisma.backgroundAgentTask.create({
      data: {
        taskId,
        parentRunId: run.id,
        userId: id,
        spaceId: id,
        botId: partner.id,
        threadId: group.threadId,
        agentId: "helper",
        sessionId: "session",
        toolNames: [],
        status: "running",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const cancel = vi.fn(async () => {
      throw new Error("background delete failed");
    });
    await destroyBot(
      {
        prisma,
        sandbox: new Proxy({}, { get: () => vi.fn(async () => undefined) }) as SandboxProvider,
        home: {} as never,
        jobs: { cancel: vi.fn(async () => undefined), enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher,
        runtime: { abort: vi.fn(async () => undefined) },
        cancelRuntimeBackgroundTask: cancel,
      },
      { ...removedBot, archivedAt: null, userId: id },
      {
        operationId: "dissolve-completed-parent",
        traceId: "dissolve-completed-parent",
        spaceId: id,
        userId: id,
        botId: removedBot.id,
        signal: new AbortController().signal,
      } as AdapterContext,
      { deleteMemories: true },
    );
    expect(await prisma.bot.findUnique({ where: { id: removedBot.id } })).toBeNull();
    expect(await prisma.chatGroup.findUnique({ where: { id: group.id } })).toBeNull();
    expect(await prisma.backgroundAgentTask.findUnique({ where: { taskId } })).toBeNull();
    expect(await prisma.run.findUnique({ where: { id: run.id } })).toBeNull();
    const key = { kind_subjectId: { kind: "background_task", subjectId: taskId } };
    expect(await prisma.executionRevocation.findUnique({ where: key })).toMatchObject({
      taskId,
      runId: run.id,
      botId: partner.id,
      threadId: group.threadId,
    });
    expect((await prisma.executionRevocation.findUnique({ where: key }))?.attempts).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.executionRevocation.findUnique({
        where: { kind_subjectId: { kind: "run_abort", subjectId: run.id } },
      }),
    ).toBeNull();
    const recovered = await retryPendingBackgroundRevocations(prisma, async () => false, {
      taskIds: [taskId],
    });
    expect(recovered.revoked).toContain(taskId);
    expect(await prisma.executionRevocation.findUnique({ where: key })).toBeNull();
  });

  it("does not leave two active attempts when a fence conflicts", async () => {
    await prisma.computerExecutionLease.deleteMany({ where: { computerId } });
    const run = await queuedRun();
    await prisma.run.update({ where: { id: run.id }, data: { leaseFence: 2 } });
    await prisma.attempt.create({ data: { runId: run.id, fence: 2, status: "running" } });
    await prisma.attempt.create({ data: { runId: run.id, fence: 3, status: "running" } });
    const { executor: running, enqueue } = executor();
    await expect(running.continueRun(run.id, "worker-conflict")).rejects.toThrow();
    const active = await prisma.attempt.findMany({
      where: {
        runId: run.id,
        status: { in: ["running", "waiting_input", "waiting_takeover"] },
      },
    });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ fence: 3, status: "running" });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "running",
      leaseFence: 3,
      leaseOwner: "worker-conflict",
    });
    expect(await prisma.attempt.findFirstOrThrow({ where: { runId: run.id, fence: 2 } })).toMatchObject({
      status: "failed",
    });
    expect(enqueue).not.toHaveBeenCalled();
    await prisma.computerExecutionLease.deleteMany({ where: { computerId } });
  });

  function lifecycleDeps() {
    return {
      prisma,
      sandbox: new Proxy({}, { get: () => vi.fn(async () => undefined) }) as SandboxProvider,
      home: {} as never,
      jobs: {
        cancel: vi.fn(async () => undefined),
        enqueue: vi.fn(async () => undefined),
      } as unknown as JobPublisher,
      runtime: { abort: vi.fn(async () => undefined) },
    };
  }

  function lifecycleContext(bot: string) {
    return {
      operationId: "background-lock",
      traceId: "background-lock",
      spaceId: id,
      userId: id,
      botId: bot,
      signal: new AbortController().signal,
    } as AdapterContext;
  }

  async function runningParent(ownerBotId: string, ownerThreadId: string) {
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: ownerBotId,
        threadId: ownerThreadId,
        prompt: "background",
        status: "running",
      },
    });
    return prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: ownerBotId,
        threadId: ownerThreadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });
  }

  function projectionInput(run: { id: string; botId: string; threadId: string }, taskId: string) {
    return {
      taskId,
      runId: run.id,
      userId: id,
      spaceId: id,
      botId: run.botId,
      threadId: run.threadId,
      agentId: "helper",
      sessionId: "session",
      toolNames: [] as string[],
      expiresAt: new Date(Date.now() + 60_000),
    };
  }

  function openGate() {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release: () => release() };
  }

  /** Open the insert gate if registration throws before it signals, so the test sees the error. */
  function releaseOnRejection<T>(gate: { release: () => void }, work: Promise<T>): Promise<T> {
    void work.catch(() => gate.release());
    return work;
  }

  async function backendPid(tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
    const pid = Number(rows[0]?.pid);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("missing backend pid");
    return pid;
  }

  async function waitUntilBlockedBy(holderPid: number, waiterPid?: number): Promise<number> {
    const probe = sidePrisma();
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (waiterPid) {
        const rows = await probe.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT ${holderPid}::int = ANY (pg_blocking_pids(${waiterPid}::int)) AS blocked
        `;
        if (rows[0]?.blocked === true) return waiterPid;
      } else {
        const rows = await probe.$queryRaw<Array<{ pid: number }>>`
          SELECT pid::int AS pid
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND ${holderPid}::int = ANY (pg_blocking_pids(pid))
        `;
        const pid = Number(rows[0]?.pid);
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for a lock held by ${holderPid}`);
  }

  async function holdRow(lock: (tx: Prisma.TransactionClient) => Promise<void>) {
    const started = openGate();
    const release = openGate();
    let pid = 0;
    const done = sidePrisma().$transaction(async (tx) => {
      await lock(tx);
      pid = await backendPid(tx);
      started.release();
      await release.promise;
    }, backgroundTaskLockTransactionOptions);
    await started.promise;
    return { pid, release: () => release.release(), done };
  }

  it("archives a background task that registers before the archive lock", async () => {
    const archivedBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Register then archive", color: "test" },
    });
    const archivedThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: archivedBot.id },
    });
    const run = await runningParent(archivedBot.id, archivedThread.id);
    const taskId = `race-archive-after-${run.id}`;
    const release = openGate();
    const inserted = openGate();
    let holderPid = 0;
    const registration = releaseOnRejection(
      inserted,
      prisma.$transaction(async (tx) => {
        await registerBackgroundTaskProjection(tx, projectionInput(run, taskId));
        holderPid = await backendPid(tx);
        inserted.release();
        await release.promise;
      }, backgroundTaskLockTransactionOptions),
    );
    await inserted.promise;
    const archived = archiveBot(
      lifecycleDeps(),
      { ...archivedBot, archivedAt: null, userId: id },
      lifecycleContext(archivedBot.id),
    );
    try {
      await waitUntilBlockedBy(holderPid);
    } finally {
      release.release();
    }
    await registration;
    await archived;
    expect(
      await prisma.backgroundAgentTask.findUniqueOrThrow({ where: { taskId } }),
    ).toMatchObject({ status: "cancelling" });
    expect(await prisma.bot.findUniqueOrThrow({ where: { id: archivedBot.id } })).toMatchObject({
      archivedAt: expect.any(Date),
    });
  });

  it("rejects background registration that waits behind bot archive", async () => {
    const archivedBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Archive then register", color: "test" },
    });
    const archivedThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: archivedBot.id },
    });
    const run = await runningParent(archivedBot.id, archivedThread.id);
    const taskId = `race-archive-before-${run.id}`;
    const barrier = await holdRow((tx) =>
      tx.$queryRaw`SELECT id FROM threads WHERE id = ${archivedThread.id} FOR UPDATE`,
    );
    const archived = archiveBot(
      lifecycleDeps(),
      { ...archivedBot, archivedAt: null, userId: id },
      lifecycleContext(archivedBot.id),
    );
    const archivePid = await waitUntilBlockedBy(barrier.pid);
    const started = openGate();
    let waiterPid = 0;
    const registration = prisma.$transaction(async (tx) => {
      waiterPid = await backendPid(tx);
      started.release();
      await registerBackgroundTaskProjection(tx, projectionInput(run, taskId));
    }, backgroundTaskLockTransactionOptions);
    try {
      await started.promise;
      await waitUntilBlockedBy(archivePid, waiterPid);
    } finally {
      barrier.release();
    }
    await expect(registration).rejects.toBeInstanceOf(BackgroundRegistrationRejected);
    await archived;
    await barrier.done;
    expect(await prisma.backgroundAgentTask.findUnique({ where: { taskId } })).toBeNull();
    expect(await prisma.bot.findUniqueOrThrow({ where: { id: archivedBot.id } })).toMatchObject({
      archivedAt: expect.any(Date),
    });
  });

  it("tombstones a group task registered before the group delete lock", async () => {
    const partner = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Delete race partner", color: "test" },
    });
    const repos = createGroupRepos(prisma);
    const group = await repos.createGroup({ userId: id, spaceId: id } as never, {
      name: "Register then delete",
      botIds: [botId, partner.id],
    });
    const run = await runningParent(partner.id, group.threadId);
    const taskId = `race-delete-after-${run.id}`;
    const release = openGate();
    const inserted = openGate();
    let holderPid = 0;
    const registration = releaseOnRejection(
      inserted,
      prisma.$transaction(async (tx) => {
        await registerBackgroundTaskProjection(tx, projectionInput(run, taskId));
        holderPid = await backendPid(tx);
        inserted.release();
        await release.promise;
      }, backgroundTaskLockTransactionOptions),
    );
    await inserted.promise;
    const removed = repos.removeGroup({ userId: id, spaceId: id } as never, group.id);
    try {
      await waitUntilBlockedBy(holderPid);
    } finally {
      release.release();
    }
    await registration;
    await removed;
    expect(await prisma.backgroundAgentTask.findUnique({ where: { taskId } })).toBeNull();
    expect(
      await prisma.executionRevocation.findUnique({
        where: { kind_subjectId: { kind: "background_task", subjectId: taskId } },
      }),
    ).toMatchObject({ taskId, runId: run.id, threadId: group.threadId });
  });

  it("rejects background registration that waits behind group delete", async () => {
    const partner = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Delete holds partner", color: "test" },
    });
    const repos = createGroupRepos(prisma);
    const group = await repos.createGroup({ userId: id, spaceId: id } as never, {
      name: "Delete then register",
      botIds: [botId, partner.id],
    });
    const run = await runningParent(partner.id, group.threadId);
    const taskId = `race-delete-before-${run.id}`;
    const barrier = await holdRow((tx) =>
      tx.$queryRaw`SELECT id FROM chat_groups WHERE id = ${group.id} FOR UPDATE`,
    );
    const removed = repos.removeGroup({ userId: id, spaceId: id } as never, group.id);
    const deletePid = await waitUntilBlockedBy(barrier.pid);
    const started = openGate();
    let waiterPid = 0;
    const registration = prisma.$transaction(async (tx) => {
      waiterPid = await backendPid(tx);
      started.release();
      await registerBackgroundTaskProjection(tx, projectionInput(run, taskId));
    }, backgroundTaskLockTransactionOptions);
    try {
      await started.promise;
      await waitUntilBlockedBy(deletePid, waiterPid);
    } finally {
      barrier.release();
    }
    await expect(registration).rejects.toBeInstanceOf(BackgroundRegistrationRejected);
    await removed;
    await barrier.done;
    expect(await prisma.backgroundAgentTask.findUnique({ where: { taskId } })).toBeNull();
    expect(
      await prisma.executionRevocation.findUnique({
        where: { kind_subjectId: { kind: "background_task", subjectId: taskId } },
      }),
    ).toBeNull();
    expect(await prisma.chatGroup.findUnique({ where: { id: group.id } })).toBeNull();
  });

  async function raceDissolve(parentStatus: "running" | "completed") {
    const partner = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: `Dissolve ${parentStatus} partner`, color: "test" },
    });
    const removedBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: `Dissolve ${parentStatus} bot`, color: "test" },
    });
    const repos = createGroupRepos(prisma);
    const group = await repos.createGroup({ userId: id, spaceId: id } as never, {
      name: `Dissolve ${parentStatus}`,
      botIds: [removedBot.id, partner.id],
    });
    const run = await runningParent(partner.id, group.threadId);
    const taskId = `race-dissolve-${parentStatus}-${run.id}`;
    const release = openGate();
    const inserted = openGate();
    let holderPid = 0;
    const registration = releaseOnRejection(
      inserted,
      prisma.$transaction(async (tx) => {
        await registerBackgroundTaskProjection(tx, projectionInput(run, taskId));
        if (parentStatus === "completed") {
          await tx.run.update({
            where: { id: run.id },
            data: { status: "completed", completedAt: new Date() },
          });
        }
        holderPid = await backendPid(tx);
        inserted.release();
        await release.promise;
      }, backgroundTaskLockTransactionOptions),
    );
    await inserted.promise;
    const deleted = destroyBot(
      lifecycleDeps(),
      { ...removedBot, archivedAt: null, userId: id },
      lifecycleContext(removedBot.id),
      { deleteMemories: true },
    );
    try {
      await waitUntilBlockedBy(holderPid);
    } finally {
      release.release();
    }
    await registration;
    await deleted;
    expect(await prisma.backgroundAgentTask.findUnique({ where: { taskId } })).toBeNull();
    expect(await prisma.chatGroup.findUnique({ where: { id: group.id } })).toBeNull();
    expect(
      await prisma.executionRevocation.findUnique({
        where: { kind_subjectId: { kind: "background_task", subjectId: taskId } },
      }),
    ).toMatchObject({ taskId, runId: run.id, botId: partner.id, threadId: group.threadId });
    if (parentStatus === "completed") {
      expect(
        await prisma.executionRevocation.findUnique({
          where: { kind_subjectId: { kind: "run_abort", subjectId: run.id } },
        }),
      ).toBeNull();
    }
  }

  it("tombstones a dissolved group task whose parent is still running", async () => {
    await raceDissolve("running");
  });

  it("tombstones a dissolved group task whose parent completed before delete", async () => {
    await raceDissolve("completed");
  });

  it("rejects registration that waits behind a group-dissolving bot delete", async () => {
    const partner = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Dissolve holds partner", color: "test" },
    });
    const removedBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Dissolve holds bot", color: "test" },
    });
    const repos = createGroupRepos(prisma);
    const group = await repos.createGroup({ userId: id, spaceId: id } as never, {
      name: "Delete bot then register",
      botIds: [removedBot.id, partner.id],
    });
    const active = await runningParent(partner.id, group.threadId);
    const completed = await runningParent(partner.id, group.threadId);
    await prisma.run.update({
      where: { id: completed.id },
      data: { status: "completed", completedAt: new Date() },
    });
    const activeTaskId = `race-dissolve-active-${active.id}`;
    const completedTaskId = `race-dissolve-done-${completed.id}`;
    const barrier = await holdRow((tx) =>
      tx.$queryRaw`SELECT id FROM chat_groups WHERE id = ${group.id} FOR UPDATE`,
    );
    const deleted = destroyBot(
      lifecycleDeps(),
      { ...removedBot, archivedAt: null, userId: id },
      lifecycleContext(removedBot.id),
      { deleteMemories: true },
    );
    const deletePid = await waitUntilBlockedBy(barrier.pid);
    const started = openGate();
    const completedStarted = openGate();
    let waiterPid = 0;
    let completedWaiterPid = 0;
    const registration = prisma.$transaction(async (tx) => {
      waiterPid = await backendPid(tx);
      started.release();
      await registerBackgroundTaskProjection(tx, projectionInput(active, activeTaskId));
    }, backgroundTaskLockTransactionOptions);
    let completedRegistration: Promise<unknown> = Promise.resolve();
    try {
      await started.promise;
      await waitUntilBlockedBy(deletePid, waiterPid);
      completedRegistration = prisma.$transaction(async (tx) => {
        completedWaiterPid = await backendPid(tx);
        completedStarted.release();
        await registerBackgroundTaskProjection(tx, projectionInput(completed, completedTaskId));
      }, backgroundTaskLockTransactionOptions);
      await completedStarted.promise;
      await waitUntilBlockedBy(waiterPid, completedWaiterPid);
    } finally {
      barrier.release();
    }
    await expect(registration).rejects.toBeInstanceOf(BackgroundRegistrationRejected);
    await expect(completedRegistration).rejects.toBeInstanceOf(BackgroundRegistrationRejected);
    await deleted;
    await barrier.done;
    expect(await prisma.backgroundAgentTask.findUnique({ where: { taskId: activeTaskId } })).toBeNull();
    expect(
      await prisma.backgroundAgentTask.findUnique({ where: { taskId: completedTaskId } }),
    ).toBeNull();
    expect(
      await prisma.executionRevocation.findUnique({
        where: { kind_subjectId: { kind: "background_task", subjectId: activeTaskId } },
      }),
    ).toBeNull();
    expect(await prisma.chatGroup.findUnique({ where: { id: group.id } })).toBeNull();
  });

  it("treats a 404 cancellation as terminal and keeps other failures retryable", async () => {
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "404", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "cancelled",
        trigger: "user",
        completedAt: new Date(),
      },
    });
    const projectionId = `cancel-404-${run.id}`;
    await prisma.backgroundAgentTask.create({
      data: {
        taskId: projectionId,
        parentRunId: run.id,
        userId: id,
        spaceId: id,
        botId,
        threadId,
        agentId: "helper",
        sessionId: "session",
        toolNames: [],
        status: "cancelling",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const tombstoneId = `tomb-404-${run.id}`;
    await prisma.executionRevocation.create({
      data: {
        kind: "background_task",
        subjectId: tombstoneId,
        runId: run.id,
        taskId: tombstoneId,
        userId: id,
        spaceId: id,
        botId,
        threadId,
      },
    });
    const unavailable = await revokeCancellingBackgroundTasks(prisma, async () => {
      throw new Error("AgentScope task cancellation failed (503)");
    });
    expect(unavailable.pending).toContain(projectionId);
    expect(
      await prisma.backgroundAgentTask.findUniqueOrThrow({ where: { taskId: projectionId } }),
    ).toMatchObject({ status: "cancelling" });
    const network = await retryPendingBackgroundRevocations(prisma, async () => {
      throw new Error("network down");
    }, { taskIds: [tombstoneId] });
    expect(network.pending).toContain(tombstoneId);
    expect(
      await prisma.executionRevocation.findUnique({
        where: { kind_subjectId: { kind: "background_task", subjectId: tombstoneId } },
      }),
    ).toMatchObject({ attempts: 1, lastError: "network down" });
    const clearedProjection = await revokeCancellingBackgroundTasks(prisma, async () => false);
    expect(clearedProjection.revoked).toContain(projectionId);
    expect(
      await prisma.backgroundAgentTask.findUniqueOrThrow({ where: { taskId: projectionId } }),
    ).toMatchObject({ status: "cancelled" });
    const clearedTombstone = await retryPendingBackgroundRevocations(prisma, async () => false, {
      taskIds: [tombstoneId],
    });
    expect(clearedTombstone.revoked).toContain(tombstoneId);
    expect(
      await prisma.executionRevocation.findUnique({
        where: { kind_subjectId: { kind: "background_task", subjectId: tombstoneId } },
      }),
    ).toBeNull();
  });
});
