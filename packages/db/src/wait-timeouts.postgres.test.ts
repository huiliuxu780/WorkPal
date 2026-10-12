import { randomUUID } from "node:crypto";
import { buildRunOrchestration } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelChildrenOfCancelledRuns } from "./cancel-child-runs.js";
import { createDb, type PrismaClient } from "./client.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";
import { finalizeRun } from "./events.js";
import { createThreadMessage } from "./messages.js";
import { scheduleAutomaticRunRetry } from "./retry-runs.js";
import { expireWaitingRuns, WAIT_TIMEOUT_MS } from "./wait-timeouts.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("waiting Run timeouts (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let botId: string;
  let threadId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("wait");
    db = isolated.db;
    prisma = db.prisma;
    await prisma.user.create({
      data: { id, name: "Timeout test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Timeout test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Timeout test" } });
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
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Timeout bot", color: "test" },
    });
    botId = bot.id;
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId } });
    threadId = thread.id;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  async function waiting(kind: "input" | "approval" | "takeover", ageMs: number) {
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Wait", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: kind === "takeover" ? "waiting_takeover" : "waiting_input",
        waitKind: kind,
        trigger: "user",
      },
    });
    await prisma.attempt.create({ data: { runId: run.id, fence: 1, status: run.status } });
    let messageId: string | undefined;
    let effectId: string | undefined;
    if (kind !== "takeover") {
      if (kind === "approval") {
        const effect = await prisma.externalEffect.create({
          data: {
            spaceId: id,
            runId: run.id,
            kind: "send_email",
            idempotencyKey: `timeout-${run.id}`,
            status: "intended",
            request: {},
          },
        });
        effectId = effect.id;
      }
      const message = await createThreadMessage(prisma, {
        threadId,
        role: "bot",
        botId,
        runId: run.id,
        blocks: [
          {
            kind: "ask",
            text: "Continue?",
            status: "pending",
            ...(effectId ? { approvalEffectId: effectId } : {}),
          },
        ],
      });
      messageId = message.id;
    }
    const old = new Date(Date.now() - ageMs);
    await prisma.$executeRaw`UPDATE "runs" SET "updatedAt" = ${old}, "waitStartedAt" = ${old} WHERE "id" = ${run.id}`;
    return { run, task, messageId, effectId };
  }

  it("expires approval exactly once and disables the ask card", async () => {
    const { run, task, messageId, effectId } = await waiting(
      "approval",
      WAIT_TIMEOUT_MS.approval + 60_000,
    );
    await prisma.backgroundAgentTask.create({
      data: {
        taskId: `background-${run.id}`,
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
    const first = await expireWaitingRuns(prisma);
    expect(first).toEqual(expect.arrayContaining([expect.objectContaining({ runId: run.id })]));
    expect(await expireWaitingRuns(prisma)).toEqual([]);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
      waitKind: null,
      error: "wait_timeout",
    });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }),
    ).toMatchObject({ status: "expired" });
    expect(
      await prisma.backgroundAgentTask.findUniqueOrThrow({
        where: { taskId: `background-${run.id}` },
      }),
    ).toMatchObject({ status: "cancelling" });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: messageId } })).toMatchObject({
      blocks: [{ kind: "ask", status: "expired" }],
    });
    const events = await prisma.event.findMany({
      where: { runId: run.id },
      orderBy: { seq: "asc" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "intervention.resolved",
      "thread.message.updated",
      "approval.resolved",
      "run.cancelled",
    ]);
    expect(events.find((event) => event.type === "approval.resolved")?.payload).toMatchObject({
      decision: "expired",
      approvalEffectId: effectId,
    });
  });

  it("keeps the original wait deadline after an unrelated Run update", async () => {
    const { run } = await waiting("input", WAIT_TIMEOUT_MS.input + 60_000);
    const waitStartedAt = (await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).waitStartedAt;
    await prisma.run.update({ where: { id: run.id }, data: { checkpoint: "unrelated-update" } });

    const changed = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(changed.waitStartedAt).toEqual(waitStartedAt);
    expect(changed.updatedAt.getTime()).toBeGreaterThan(waitStartedAt!.getTime());
    expect(await expireWaitingRuns(prisma)).toEqual([
      expect.objectContaining({ runId: run.id }),
    ]);
  });

  it("keeps fresh input waiting and expires takeover after 30 minutes", async () => {
    const fresh = await waiting("input", WAIT_TIMEOUT_MS.input - 60_000);
    const takeover = await waiting("takeover", WAIT_TIMEOUT_MS.takeover + 60_000);
    const expired = await expireWaitingRuns(prisma);
    expect(expired.map((row) => row.runId)).toContain(takeover.run.id);
    expect(expired.map((row) => row.runId)).not.toContain(fresh.run.id);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: fresh.run.id } })).toMatchObject({
      status: "waiting_input",
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: takeover.run.id } })).toMatchObject({
      status: "cancelled",
    });
  });

  it("blocks child output and cancels its Run and background work after parent cancellation", async () => {
    const parent = await waiting("input", 0);
    const childBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Child bot", color: "test" },
    });
    const childThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: childBot.id },
    });
    const childTask = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: childBot.id,
        threadId: childThread.id,
        prompt: "Delegated work",
        status: "running",
      },
    });
    const child = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: childBot.id,
        threadId: childThread.id,
        taskId: childTask.id,
        status: "running",
        trigger: "bot_message",
        orchestration: buildRunOrchestration({
          kind: "bot_message",
          ownerBotId: childBot.id,
          responseMode: "single",
          collaboration: {
            role: "support",
            source: "bot_message",
            fromBotId: botId,
            parentRunId: parent.run.id,
            handoffDepth: 0,
            messageHop: 1,
          },
        }),
      },
    });
    const grandchildTask = await prisma.task.create({
      data: {
        spaceId: id, userId: id, botId: childBot.id, threadId: childThread.id,
        prompt: "Nested delegated work", status: "running",
      },
    });
    const grandchild = await prisma.run.create({
      data: {
        spaceId: id, userId: id, botId: childBot.id, threadId: childThread.id,
        taskId: grandchildTask.id, status: "running", trigger: "bot_message",
        orchestration: buildRunOrchestration({
          kind: "bot_message", ownerBotId: childBot.id, responseMode: "single",
          collaboration: {
            role: "support", source: "bot_message", fromBotId: childBot.id,
            parentRunId: child.id, handoffDepth: 1, messageHop: 2,
          },
        }),
      },
    });
    await prisma.backgroundAgentTask.create({
      data: {
        taskId: `child-background-${child.id}`,
        parentRunId: child.id,
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
    await prisma.run.update({
      where: { id: parent.run.id },
      data: { status: "cancelled", waitKind: null, completedAt: new Date() },
    });
    await expect(
      createThreadMessage(prisma, {
        threadId: childThread.id,
        role: "bot",
        botId: childBot.id,
        runId: child.id,
        blocks: [{ kind: "text", text: "Late child output" }],
      }),
    ).rejects.toThrow("Run cannot write thread history");
    expect(await cancelChildrenOfCancelledRuns(prisma, [parent.run.id])).toEqual([
      expect.objectContaining({ id: child.id, threadId: childThread.id }),
      expect.objectContaining({ id: grandchild.id, threadId: childThread.id }),
    ]);
    expect(await cancelChildrenOfCancelledRuns(prisma)).toEqual([]);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({
      status: "cancelled",
      error: "parent_cancelled",
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: grandchild.id } })).toMatchObject({
      status: "cancelled",
      error: "parent_cancelled",
    });
    expect(
      await prisma.backgroundAgentTask.findUniqueOrThrow({
        where: { taskId: `child-background-${child.id}` },
      }),
    ).toMatchObject({ status: "cancelling" });
    expect(await prisma.event.count({ where: { runId: child.id, type: "run.cancelled" } })).toBe(1);
  });

  it("persists retry delays and refuses replay after a committed external effect", async () => {
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Call model", status: "running" },
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
        leaseOwner: "worker",
        leaseFence: 1,
      },
    });
    const firstAttempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    const now = new Date();
    const first = await scheduleAutomaticRunRetry(
      prisma,
      {
        runId: run.id,
        attemptId: firstAttempt.id,
        leaseOwner: "worker",
        leaseFence: 1,
        reason: "provider_5xx",
        error: "Provider 503",
      },
      now,
    );
    expect(first).toMatchObject({ retryAt: new Date(now.getTime() + 5_000), attempt: 2 });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "queued",
      retryAt: first?.retryAt,
    });
    expect(await prisma.event.count({ where: { runId: run.id, type: "run.retried" } })).toBe(1);

    await prisma.run.update({
      where: { id: run.id },
      data: { status: "running", leaseOwner: "worker", leaseFence: 2, retryAt: null },
    });
    const secondAttempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 2, status: "running" },
    });
    const second = await scheduleAutomaticRunRetry(
      prisma,
      {
        runId: run.id,
        attemptId: secondAttempt.id,
        leaseOwner: "worker",
        leaseFence: 2,
        reason: "network_error",
        error: "Network reset",
      },
      now,
    );
    expect(second).toMatchObject({ retryAt: new Date(now.getTime() + 30_000), attempt: 3 });

    await prisma.run.update({
      where: { id: run.id },
      data: { status: "running", leaseOwner: "worker", leaseFence: 3, retryAt: null },
    });
    const thirdAttempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 3, status: "running" },
    });
    await prisma.externalEffect.create({
      data: {
        spaceId: id,
        runId: run.id,
        kind: "send_email",
        idempotencyKey: `retry-email-${run.id}`,
        status: "completed",
        request: {},
      },
    });
    expect(
      await scheduleAutomaticRunRetry(
        prisma,
        {
          runId: run.id,
          attemptId: thirdAttempt.id,
          leaseOwner: "worker",
          leaseFence: 3,
          reason: "provider_5xx",
          error: "Provider 503",
        },
        now,
      ),
    ).toBeNull();
    expect(await prisma.event.count({ where: { runId: run.id, type: "run.retried" } })).toBe(2);
  });

  it("retries a lost lease only after expiry and refuses to finalize a renewed lease", async () => {
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Lease recovery", status: "running" },
    });
    const now = new Date();
    const run = await prisma.run.create({
      data: {
        spaceId: id, userId: id, botId, threadId, taskId: task.id,
        status: "running", trigger: "user", leaseOwner: "lost-worker", leaseFence: 1,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    const recovery = {
      runId: run.id, attemptId: attempt.id, leaseOwner: "lost-worker", leaseFence: 1,
      reason: "lease_lost" as const, error: "Execution lease expired",
    };
    expect(await scheduleAutomaticRunRetry(prisma, recovery, now)).toBeNull();
    expect(await finalizeRun(prisma, {
      ...recovery,
      spaceId: id, threadId, botId, taskId: task.id,
      requireLeaseExpiredAt: now, outcome: "failed", error: recovery.error,
    })).toBe(false);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "running", leaseOwner: "lost-worker",
    });

    await prisma.run.update({
      where: { id: run.id }, data: { leaseExpiresAt: new Date(now.getTime() - 1_000) },
    });
    const retry = await scheduleAutomaticRunRetry(prisma, recovery, now);
    expect(retry).toMatchObject({ retryAt: new Date(now.getTime() + 5_000), attempt: 2 });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "queued", retryAt: retry?.retryAt,
    });
    expect(await prisma.event.count({ where: { runId: run.id, type: "run.retried" } })).toBe(1);
  });
});
