import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { BUDGET_ACTIONS, budgetAskCheckpoint, buildRunOrchestration } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import { createDb, type PrismaClient } from "./client.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";
import { computerHomeKey, computerScopeKey } from "./computers.js";
import {
  appendEventInTransaction,
  finalizeRun,
  pauseRunForInput,
  pauseRunForTakeover,
} from "./events.js";
import { answerRunInput } from "./events.js";
import { createGroupRepos } from "./groups.js";
import { createThreadMessage } from "./messages.js";
import { promoteLeasedRunWithAttempt, reconcileAttemptFenceConflict } from "./promote-run.js";
import { renewOwnedRunLease } from "./run-lease.js";
import { scheduleAutomaticRunRetry } from "./retry-runs.js";
import { expireWaitingRuns, WAIT_TIMEOUT_MS } from "./wait-timeouts.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("execution contract (PostgreSQL)", () => {
  const id = randomUUID();
  const actor = { userId: id, spaceId: id } as Actor;
  let isolated: IsolatedPostgresDatabase | undefined;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let botId: string;
  let threadId: string;
  let computerId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("exec_db");
    db = isolated.db;
    prisma = db.prisma;
    await prisma.user.create({
      data: { id, name: "Contract test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Contract test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Contract test" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: { id, spaceId: id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Contract bot", color: "test" },
    });
    botId = bot.id;
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId } });
    threadId = thread.id;
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

  async function taskAndRun(data: {
    status: string;
    threadId?: string;
    botId?: string;
    leaseOwner?: string | null;
    leaseFence?: number;
    leaseExpiresAt?: Date | null;
    retryAt?: Date | null;
    waitKind?: string | null;
    waitStartedAt?: Date | null;
    checkpoint?: string | null;
    trigger?: string;
    orchestration?: object;
  }) {
    const ownerBotId = data.botId ?? botId;
    const ownerThreadId = data.threadId ?? threadId;
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: ownerBotId,
        threadId: ownerThreadId,
        prompt: "Contract",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: ownerBotId,
        threadId: ownerThreadId,
        taskId: task.id,
        status: data.status,
        trigger: data.trigger ?? "user",
        leaseOwner: data.leaseOwner,
        leaseFence: data.leaseFence ?? 0,
        leaseExpiresAt: data.leaseExpiresAt,
        retryAt: data.retryAt,
        waitKind: data.waitKind,
        checkpoint: data.checkpoint,
        orchestration: data.orchestration,
      },
    });
    if (data.waitStartedAt) {
      await prisma.$executeRaw`UPDATE "runs" SET "waitStartedAt" = ${data.waitStartedAt} WHERE "id" = ${run.id}`;
    }
    return { task, run: await prisma.run.findUniqueOrThrow({ where: { id: run.id } }) };
  }

  async function descendantsOf(parentRunId: string, fromBotId: string) {
    const childBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: `Child ${randomUUID().slice(0, 8)}`, color: "test" },
    });
    const childThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: childBot.id },
    });
    const child = await taskAndRun({
      status: "running",
      botId: childBot.id,
      threadId: childThread.id,
      trigger: "bot_message",
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
    });
    await prisma.attempt.create({ data: { runId: child.run.id, fence: 1, status: "running" } });
    const grandchild = await taskAndRun({
      status: "running",
      botId: childBot.id,
      threadId: childThread.id,
      trigger: "bot_message",
      orchestration: buildRunOrchestration({
        kind: "bot_message",
        ownerBotId: childBot.id,
        responseMode: "single",
        collaboration: {
          role: "support",
          source: "bot_message",
          fromBotId: childBot.id,
          parentRunId: child.run.id,
          handoffDepth: 1,
          messageHop: 2,
        },
      }),
    });
    await prisma.attempt.create({ data: { runId: grandchild.run.id, fence: 1, status: "running" } });
    await prisma.backgroundAgentTask.create({
      data: {
        taskId: `bg-${child.run.id}`,
        parentRunId: child.run.id,
        userId: id,
        spaceId: id,
        botId: childBot.id,
        threadId: childThread.id,
        agentId: "helper",
        sessionId: "helper-session",
        toolNames: [],
        status: "running",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.computerExecutionLease.create({
      data: {
        computerId,
        botId: childBot.id,
        runId: child.run.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return { child: child.run, grandchild: grandchild.run, childThread, childBot };
  }

  async function budgetAsk(choice: "cancel_run" | "narrow_scope") {
    const parent = await taskAndRun({
      status: "waiting_input",
      waitKind: "input",
      checkpoint: budgetAskCheckpoint({ reason: "duration_sec", observed: 901 }),
      leaseFence: 4,
      leaseOwner: "budget-worker",
    });
    await prisma.attempt.create({
      data: { runId: parent.run.id, fence: 0, status: "completed", finishedAt: new Date(0) },
    });
    await prisma.attempt.create({ data: { runId: parent.run.id, fence: 4, status: "waiting_input" } });
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId: id,
        runId: parent.run.id,
        kind: "send_email",
        idempotencyKey: `budget-effect-${parent.run.id}`,
        status: "completed",
        request: { to: "kept@example.test" },
      },
    });
    const message = await createThreadMessage(prisma, {
      threadId,
      role: "bot",
      botId,
      runId: parent.run.id,
      blocks: [{ kind: "ask", text: "Budget exceeded", status: "pending", actions: [...BUDGET_ACTIONS] }],
    });
    const tree = await descendantsOf(parent.run.id, botId);
    expect(
      await answerRunInput(prisma, {
        spaceId: id,
        threadId,
        runId: parent.run.id,
        messageId: message.id,
        answeredByUserId: id,
        answer: choice,
      }),
    ).toBe(true);
    return { parent: parent.run, effect, tree, fence: 4 };
  }

  function expectTerminalCancel(run: {
    status: string;
    waitKind: string | null;
    waitStartedAt: Date | null;
    retryAt: Date | null;
    leaseOwner: string | null;
    leaseExpiresAt: Date | null;
    leaseFence: number;
    completedAt: Date | null;
  }, fence: number) {
    expect(run).toMatchObject({
      status: "cancelled",
      waitKind: null,
      waitStartedAt: null,
      retryAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseFence: fence,
    });
    expect(run.completedAt).toBeInstanceOf(Date);
  }

  it("promotes a leased run and its attempt in one transaction", async () => {
    const { run } = await taskAndRun({
      status: "leased",
      leaseOwner: "worker-a",
      leaseFence: 7,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const [first, second] = await Promise.allSettled([
      promoteLeasedRunWithAttempt(prisma, {
        runId: run.id,
        leaseOwner: "worker-a",
        leaseFence: 7,
        startedAt: new Date(),
      }),
      promoteLeasedRunWithAttempt(prisma, {
        runId: run.id,
        leaseOwner: "worker-a",
        leaseFence: 7,
        startedAt: new Date(),
      }),
    ]);
    const created = [first, second].filter(
      (result) => result.status === "fulfilled" && result.value,
    );
    expect(created).toHaveLength(1);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "running",
      leaseFence: 7,
    });
    expect(await prisma.attempt.count({ where: { runId: run.id, fence: 7 } })).toBe(1);
  });

  it("rejects a second attempt for the same run fence and rolls the promote back", async () => {
    const { run } = await taskAndRun({
      status: "leased",
      leaseOwner: "worker-a",
      leaseFence: 3,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await prisma.attempt.create({ data: { runId: run.id, fence: 3, status: "running" } });
    await expect(
      promoteLeasedRunWithAttempt(prisma, {
        runId: run.id,
        leaseOwner: "worker-a",
        leaseFence: 3,
        startedAt: new Date(),
      }),
    ).rejects.toThrow();
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "leased",
    });
    expect(await prisma.attempt.count({ where: { runId: run.id, fence: 3 } })).toBe(1);
    await expect(
      prisma.attempt.create({ data: { runId: run.id, fence: 3, status: "running" } }),
    ).rejects.toThrow();
  });

  it("does not open an attempt when the run is cancelled before promotion", async () => {
    const { task, run } = await taskAndRun({
      status: "leased",
      leaseOwner: "worker-a",
      leaseFence: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await prisma.$transaction(async (tx) => {
      await cancelRunsInTransaction(tx, [{ id: run.id, taskId: task.id }], new Date());
    });
    expect(
      await promoteLeasedRunWithAttempt(prisma, {
        runId: run.id,
        leaseOwner: "worker-a",
        leaseFence: 2,
        startedAt: new Date(),
      }),
    ).toBeNull();
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await prisma.attempt.count({ where: { runId: run.id } })).toBe(0);
  });

  it("cancels a waited parent, its descendants, and their background work", async () => {
    const parent = await taskAndRun({
      status: "waiting_input",
      waitKind: "input",
      waitStartedAt: new Date(Date.now() - WAIT_TIMEOUT_MS.input - 60_000),
      leaseFence: 5,
      leaseOwner: "waiter",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      retryAt: new Date(Date.now() - 1_000),
    });
    await prisma.attempt.create({
      data: { runId: parent.run.id, fence: 1, status: "completed", finishedAt: new Date(Date.now() - 5_000) },
    });
    const active = await prisma.attempt.create({
      data: { runId: parent.run.id, fence: 5, status: "waiting_input" },
    });
    const message = await createThreadMessage(prisma, {
      threadId,
      role: "bot",
      botId,
      runId: parent.run.id,
      blocks: [{ kind: "ask", text: "Still there?", status: "pending" }],
    });
    const tree = await descendantsOf(parent.run.id, botId);
    const expired = await expireWaitingRuns(prisma);
    expect(expired.map((row) => row.runId)).toContain(parent.run.id);
    const again = await expireWaitingRuns(prisma);
    expect(again.map((row) => row.runId)).not.toContain(parent.run.id);

    const stored = await prisma.run.findUniqueOrThrow({ where: { id: parent.run.id } });
    expectTerminalCancel(stored, 5);
    expect(stored.error).toBe("wait_timeout");
    expect(await prisma.attempt.findUniqueOrThrow({ where: { id: active.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await prisma.attempt.findFirstOrThrow({ where: { runId: parent.run.id, fence: 1 } }),
    ).toMatchObject({ status: "completed" });
    for (const descendant of [tree.child, tree.grandchild]) {
      const row = await prisma.run.findUniqueOrThrow({ where: { id: descendant.id } });
      expect(row).toMatchObject({ status: "cancelled", error: "parent_cancelled" });
      expect(await prisma.event.count({ where: { runId: descendant.id, type: "run.cancelled" } })).toBe(1);
    }
    expect(
      await prisma.backgroundAgentTask.findUniqueOrThrow({ where: { taskId: `bg-${tree.child.id}` } }),
    ).toMatchObject({ status: "cancelling" });
    expect(
      await prisma.computerExecutionLease.findFirstOrThrow({ where: { runId: tree.child.id } }),
    ).toMatchObject({ expiresAt: new Date(0) });
    expect(await prisma.event.count({ where: { runId: parent.run.id, type: "run.cancelled" } })).toBe(1);
    expect(await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({
      blocks: [{ kind: "ask", status: "expired" }],
    });
  });

  it("propagates budget cancel and narrow to the descendant chain", async () => {
    for (const choice of ["cancel_run", "narrow_scope"] as const) {
      const { parent, effect, tree, fence } = await budgetAsk(choice);
      const stored = await prisma.run.findUniqueOrThrow({ where: { id: parent.id } });
      expectTerminalCancel(stored, fence);
      expect(stored.error).toBe(choice === "cancel_run" ? "budget_cancelled" : "budget_narrowed");
      expect(await prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).toMatchObject({
        status: "completed",
        request: { to: "kept@example.test" },
      });
      expect(
        await prisma.attempt.findFirstOrThrow({ where: { runId: parent.id, fence: 0 } }),
      ).toMatchObject({ status: "completed" });
      expect(
        await prisma.attempt.findFirstOrThrow({ where: { runId: parent.id, fence: fence } }),
      ).toMatchObject({ status: "cancelled" });
      for (const descendant of [tree.child, tree.grandchild]) {
        expect(await prisma.run.findUniqueOrThrow({ where: { id: descendant.id } })).toMatchObject({
          status: "cancelled",
          error: "parent_cancelled",
        });
      }
      expect(
        await prisma.backgroundAgentTask.findUniqueOrThrow({ where: { taskId: `bg-${tree.child.id}` } }),
      ).toMatchObject({ status: "cancelling" });
      expect(await prisma.event.count({ where: { runId: parent.id, type: "run.cancelled" } })).toBe(1);
      expect(
        await answerRunInput(prisma, {
          spaceId: id,
          threadId,
          runId: parent.id,
          messageId: "missing",
          answeredByUserId: id,
          answer: choice,
        }),
      ).toBe(false);
      expect(await prisma.event.count({ where: { runId: parent.id, type: "run.cancelled" } })).toBe(1);
    }
  });

  it("propagates group member removal and archive through descendants", async () => {
    const repos = createGroupRepos(prisma);
    const kept = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Kept", color: "test" },
    });
    const removed = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Removed", color: "test" },
    });
    const third = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Third", color: "test" },
    });
    const group = await repos.createGroup(actor, {
      name: "Removal",
      botIds: [kept.id, removed.id, third.id],
    });
    const parent = await taskAndRun({
      status: "running",
      botId: removed.id,
      threadId: group.threadId,
      leaseFence: 8,
      leaseOwner: "group-worker",
    });
    await prisma.attempt.create({ data: { runId: parent.run.id, fence: 8, status: "running" } });
    const tree = await descendantsOf(parent.run.id, removed.id);
    const updated = await repos.updateGroup(actor, {
      groupId: group.id,
      botIds: [kept.id, third.id],
    });
    expect(updated.cancelledRunIds).toEqual(expect.arrayContaining([parent.run.id, tree.child.id, tree.grandchild.id]));
    const stored = await prisma.run.findUniqueOrThrow({ where: { id: parent.run.id } });
    expectTerminalCancel(stored, 8);
    expect(await prisma.event.count({ where: { runId: parent.run.id, type: "run.cancelled" } })).toBe(1);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: tree.grandchild.id } })).toMatchObject({
      status: "cancelled",
      error: "parent_cancelled",
    });
    const again = await repos.updateGroup(actor, { groupId: group.id, name: "Renamed" });
    expect(again.cancelledRunIds).not.toContain(parent.run.id);
    expect(await prisma.event.count({ where: { runId: parent.run.id, type: "run.cancelled" } })).toBe(1);

    const archiveGroup = await repos.createGroup(actor, {
      name: "Archive",
      botIds: [kept.id, third.id],
    });
    const archivedParent = await taskAndRun({
      status: "queued",
      botId: kept.id,
      threadId: archiveGroup.threadId,
      leaseFence: 1,
      retryAt: new Date(),
    });
    const archivedTree = await descendantsOf(archivedParent.run.id, kept.id);
    const archived = await repos.archiveGroup(actor, archiveGroup.id);
    expect(archived.cancelledRunIds).toEqual(
      expect.arrayContaining([archivedParent.run.id, archivedTree.child.id, archivedTree.grandchild.id]),
    );
    expect(await prisma.run.findUniqueOrThrow({ where: { id: archivedParent.run.id } })).toMatchObject({
      status: "cancelled",
      retryAt: null,
      leaseFence: 1,
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: archivedTree.grandchild.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await prisma.event.count({ where: { runId: archivedParent.run.id, type: "run.cancelled" } }),
    ).toBe(1);
  });

  it("rejects a late tool callback and message after the parent is cancelled", async () => {
    const parent = await taskAndRun({ status: "running", leaseFence: 1, leaseOwner: "worker" });
    await prisma.attempt.create({ data: { runId: parent.run.id, fence: 1, status: "running" } });
    const tree = await descendantsOf(parent.run.id, botId);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      const rows = await cancelRunsInTransaction(
        tx,
        [{ id: parent.run.id, taskId: parent.task.id }],
        new Date(),
      );
      for (const row of rows) {
        await appendEventInTransaction(tx, {
          spaceId: row.spaceId,
          threadId: row.threadId,
          botId: row.botId,
          runId: row.id,
          type: "run.cancelled",
          payload: { reason: "stopped" },
        });
      }
    });
    await expect(
      prisma.$transaction((tx) =>
        appendEventInTransaction(tx, {
          spaceId: id,
          threadId: tree.childThread.id,
          botId: tree.childBot.id,
          runId: tree.child.id,
          type: "agent.tool.called",
          payload: { name: "read_file", executionId: "late-tool" },
        }),
      ),
    ).rejects.toThrow("Run cannot write thread history");
    await expect(
      createThreadMessage(prisma, {
        threadId: tree.childThread.id,
        role: "bot",
        botId: tree.childBot.id,
        runId: tree.child.id,
        blocks: [{ kind: "text", text: "late" }],
      }),
    ).rejects.toThrow("Run cannot write thread history");
    expect(await prisma.event.count({ where: { runId: tree.child.id, type: "agent.tool.called" } })).toBe(0);
  });

  it("keeps one cancel result when retry is scheduled at the same time", async () => {
    const { task, run } = await taskAndRun({
      status: "running",
      leaseOwner: "worker",
      leaseFence: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 2, status: "running" },
    });
    await Promise.all([
      scheduleAutomaticRunRetry(prisma, {
        runId: run.id,
        attemptId: attempt.id,
        leaseOwner: "worker",
        leaseFence: 2,
        reason: "network_error",
        error: "socket hang up",
      }),
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        const rows = await cancelRunsInTransaction(tx, [{ id: run.id, taskId: task.id }], new Date());
        for (const row of rows) {
          await appendEventInTransaction(tx, {
            spaceId: row.spaceId,
            threadId: row.threadId,
            botId: row.botId,
            runId: row.id,
            type: "run.cancelled",
            payload: { reason: "stopped" },
          });
        }
      }),
    ]);
    const stored = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe("cancelled");
    expect(stored.leaseOwner).toBeNull();
    expect(stored.retryAt).toBeNull();
    expect(await prisma.event.count({ where: { runId: run.id, type: "run.cancelled" } })).toBe(1);
    expect(await prisma.event.count({ where: { runId: run.id, type: "run.retried" } })).toBeLessThanOrEqual(1);
    const claimed = await prisma.run.findMany({
      where: {
        id: run.id,
        OR: [
          { status: "queued", OR: [{ retryAt: null }, { retryAt: { lte: new Date() } }] },
          { status: { in: ["leased", "running"] }, leaseExpiresAt: { lte: new Date() } },
        ],
      },
    });
    expect(claimed).toEqual([]);
  });

  it("does not retry after a committed, executing, or uncertain external effect", async () => {
    for (const status of ["completed", "executing", "uncertain"] as const) {
      const { run } = await taskAndRun({
        status: "running",
        leaseOwner: "worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() - 1_000),
      });
      const attempt = await prisma.attempt.create({
        data: { runId: run.id, fence: 1, status: "running" },
      });
      await prisma.externalEffect.create({
        data: {
          spaceId: id,
          runId: run.id,
          kind: "send_email",
          idempotencyKey: `effect-${status}-${run.id}`,
          status,
          request: {},
        },
      });
      expect(
        await scheduleAutomaticRunRetry(prisma, {
          runId: run.id,
          attemptId: attempt.id,
          leaseOwner: "worker",
          leaseFence: 1,
          reason: "provider_5xx",
          error: "503",
        }),
      ).toBeNull();
      expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "running",
      });
      expect(await prisma.event.count({ where: { runId: run.id, type: "run.retried" } })).toBe(0);
      expect(await prisma.externalEffect.count({ where: { runId: run.id } })).toBe(1);
    }
  });

  it("ignores an old fence and repeats cancellation without a second event", async () => {
    const { task, run } = await taskAndRun({
      status: "running",
      leaseOwner: "worker-new",
      leaseFence: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      retryAt: new Date(Date.now() - 1_000),
    });
    const previous = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "completed", finishedAt: new Date(Date.now() - 10_000) },
    });
    const current = await prisma.attempt.create({
      data: { runId: run.id, fence: 2, status: "running" },
    });
    expect(
      await finalizeRun(prisma, {
        spaceId: id,
        threadId,
        botId,
        runId: run.id,
        taskId: task.id,
        attemptId: previous.id,
        leaseOwner: "worker-old",
        leaseFence: 1,
        outcome: "failed",
        error: "stale",
      }),
    ).toBe(false);
    expect(
      await pauseRunForInput(prisma, {
        spaceId: id,
        threadId,
        botId,
        runId: run.id,
        attemptId: previous.id,
        leaseOwner: "worker-old",
        leaseFence: 1,
        blocks: [{ kind: "ask", text: "stale", status: "pending" }],
      }),
    ).toBe(false);
    expect(
      await pauseRunForTakeover(prisma, {
        spaceId: id,
        threadId,
        botId,
        runId: run.id,
        attemptId: previous.id,
        leaseOwner: "worker-old",
        leaseFence: 1,
        reason: "stale",
        computerId: "missing-computer",
      }),
    ).toBe(false);
    expect(
      await renewOwnedRunLease(prisma, {
        runId: run.id,
        leaseOwner: "worker-old",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 120_000),
      }),
    ).toBe(false);
    expect(
      await renewOwnedRunLease(prisma, {
        runId: run.id,
        leaseOwner: "worker-new",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + 120_000),
      }),
    ).toBe(true);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "running",
      leaseFence: 2,
      leaseOwner: "worker-new",
    });

    const cancelOnce = async () =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        const rows = await cancelRunsInTransaction(tx, [{ id: run.id, taskId: task.id }], new Date());
        for (const row of rows) {
          await appendEventInTransaction(tx, {
            spaceId: row.spaceId,
            threadId: row.threadId,
            botId: row.botId,
            runId: row.id,
            type: "run.cancelled",
            payload: {},
          });
        }
        return rows.length;
      });
    expect(await cancelOnce()).toBe(1);
    const cancelled = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    const finished = await prisma.attempt.findUniqueOrThrow({ where: { id: current.id } });
    expect(await cancelOnce()).toBe(0);
    const repeated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(repeated.completedAt).toEqual(cancelled.completedAt);
    expect(repeated.leaseFence).toBe(2);
    expect(await prisma.attempt.findUniqueOrThrow({ where: { id: current.id } })).toMatchObject({
      status: "cancelled",
      finishedAt: finished.finishedAt,
    });
    expect(await prisma.attempt.findUniqueOrThrow({ where: { id: previous.id } })).toMatchObject({
      status: "completed",
      finishedAt: previous.finishedAt,
    });
    expect(await prisma.event.count({ where: { runId: run.id, type: "run.cancelled" } })).toBe(1);
  });

  it("reuses the conflicting attempt and finishes every other active attempt", async () => {
    const seeded = await taskAndRun({
      status: "leased",
      leaseOwner: "worker-a",
      leaseFence: 3,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const current = await prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 3, status: "running" },
    });
    const stray = await prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 1, status: "waiting_takeover" },
    });
    const reconciled = await reconcileAttemptFenceConflict(prisma, {
      runId: seeded.run.id,
      leaseOwner: "worker-a",
      leaseFence: 3,
      startedAt: new Date(),
    });
    expect(reconciled).toEqual({ outcome: "reused", attempt: { id: current.id, fence: 3 } });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).toMatchObject({
      status: "running",
      leaseFence: 3,
      leaseOwner: "worker-a",
    });
    expect(
      await prisma.attempt.count({
        where: {
          runId: seeded.run.id,
          status: { in: ["running", "waiting_input", "waiting_takeover"] },
        },
      }),
    ).toBe(1);
    expect(await prisma.attempt.findUniqueOrThrow({ where: { id: stray.id } })).toMatchObject({
      status: "failed",
    });
  });

  it("fails the run when the conflicting attempt is already finished", async () => {
    const seeded = await taskAndRun({
      status: "leased",
      leaseOwner: "worker-a",
      leaseFence: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 2, status: "completed", finishedAt: new Date() },
    });
    await prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 1, status: "running" },
    });
    const reconciled = await reconcileAttemptFenceConflict(prisma, {
      runId: seeded.run.id,
      leaseOwner: "worker-a",
      leaseFence: 2,
      startedAt: new Date(),
    });
    expect(reconciled).toEqual({ outcome: "failed" });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).toMatchObject({
      status: "failed",
      leaseOwner: null,
      leaseExpiresAt: null,
      error: "Attempt fence conflict: the Attempt for this fence already finished",
    });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: seeded.task.id } })).toMatchObject({
      status: "failed",
    });
    expect(
      await prisma.attempt.count({
        where: {
          runId: seeded.run.id,
          status: { in: ["running", "waiting_input", "waiting_takeover"] },
        },
      }),
    ).toBe(0);
  });
});
