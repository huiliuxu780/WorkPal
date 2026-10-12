import { randomUUID } from "node:crypto";
import type { AdapterContext, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { buildRunOrchestration } from "@rakazo/core";
import {
  createDb,
  createThreadEvents,
  computerHomeKey,
  computerScopeKey,
  promoteLeasedRunWithAttempt,
  type PrismaClient,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { archiveBot, destroyBot } from "./child-bots.js";
import { createRunExecutor } from "./executor.js";
import { createJobReconciler } from "./job-reconciler.js";
import { revokeCancellingBackgroundTasks } from "./revoke-cancelled-work.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("execution contract recovery (PostgreSQL)", () => {
  const id = randomUUID();
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let botId: string;
  let threadId: string;
  let computerId: string;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
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
  });

  afterAll(async () => {
    if (!db) return;
    await prisma.organization.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id } });
    await prisma.$disconnect();
    await db.pool.end();
  });

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
});
