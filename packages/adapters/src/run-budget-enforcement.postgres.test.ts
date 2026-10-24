import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import {
  answerRunInput,
  type createDb,
  createIsolatedPostgresDatabase,
  createManualRetryRun,
  createThreadEvents,
  type IsolatedPostgresDatabase,
  type PrismaClient,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { enforceRunBudgets } from "./run-budget-enforcement.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("Run budget enforcement (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let botId: string;
  let threadId: string;
  const abort = vi.fn(async () => undefined);

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("budget");
    db = isolated.db;
    prisma = db.prisma;
    await prisma.user.create({
      data: { id, name: "Budget test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Budget test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Budget test" } });
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
      data: { spaceId: id, userId: id, name: "Budget bot", color: "test" },
    });
    botId = bot.id;
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId } });
    threadId = thread.id;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  async function running(trigger: "user" | "routine", secondsOld: number) {
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        prompt: "Long analysis",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "running",
        trigger,
        leaseOwner: "budget-worker",
        leaseFence: 1,
        startedAt: new Date(Date.now() - secondsOld * 1_000),
      },
    });
    await prisma.attempt.create({
      data: {
        runId: run.id,
        fence: 1,
        status: "running",
        startedAt: new Date(Date.now() - secondsOld * 1_000),
      },
    });
    return run;
  }

  const deps = () => ({
    prisma,
    events: createThreadEvents(prisma),
    runtime: { abort } as unknown as AgentRuntime,
  });

  async function pendingAsk(runId: string) {
    return prisma.message.findFirstOrThrow({
      where: { runId, role: "bot" },
      orderBy: { seq: "desc" },
    });
  }

  it("pauses an interactive duration breach and lets the owner raise its persisted limit", async () => {
    const run = await running("user", 901);
    expect(await enforceRunBudgets(deps())).toBeGreaterThanOrEqual(1);
    const paused = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(paused).toMatchObject({ status: "waiting_input", waitKind: "input" });
    const ask = await pendingAsk(run.id);
    expect(ask.blocks).toMatchObject([
      {
        kind: "ask",
        status: "pending",
        actions: expect.arrayContaining([expect.objectContaining({ id: "increase_budget" })]),
      },
    ]);
    expect(await prisma.event.count({ where: { runId: run.id, type: "budget.exceeded" } })).toBe(1);
    expect(abort).toHaveBeenCalledWith(run.id);
    expect(
      await answerRunInput(prisma, {
        spaceId: id,
        threadId,
        runId: run.id,
        messageId: ask.id,
        answeredByUserId: randomUUID(),
        answer: "increase_budget",
      }),
    ).toBe(false);
    expect(
      await answerRunInput(prisma, {
        spaceId: id,
        threadId,
        runId: run.id,
        messageId: ask.id,
        answeredByUserId: id,
        answer: "not_an_option",
      }),
    ).toBe(false);
    expect(
      await answerRunInput(prisma, {
        spaceId: id,
        threadId,
        runId: run.id,
        messageId: ask.id,
        answeredByUserId: id,
        answer: "increase_budget",
      }),
    ).toBe(true);
    const raised = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(raised.status).toBe("queued");
    expect(raised.budgetOverride).toMatchObject({ maxDurationSec: expect.any(Number) });
    const task = await prisma.task.findUniqueOrThrow({ where: { id: run.taskId } });
    expect(task.prompt).toBe("Long analysis");
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: "running",
        leaseOwner: "budget-worker",
        leaseFence: 2,
        startedAt: new Date(Date.now() - 86_400_000),
      },
    });
    await prisma.attempt.create({ data: { runId: run.id, fence: 2, status: "running" } });
    expect(await enforceRunBudgets(deps(), new Date(), run.id)).toBe(0);
  });

  it("cancels an interactive breach when the owner selects cancel", async () => {
    const run = await running("user", 902);
    await enforceRunBudgets(deps());
    const ask = await pendingAsk(run.id);
    expect(
      await answerRunInput(prisma, {
        spaceId: id,
        threadId,
        runId: run.id,
        messageId: ask.id,
        answeredByUserId: id,
        answer: "cancel_run",
      }),
    ).toBe(true);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
      error: "budget_cancelled",
    });
    expect(await prisma.attempt.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      status: "cancelled",
    });
  });

  it("fails an unattended duration breach with an explicit budget reason", async () => {
    const run = await running("routine", 3_601);
    await enforceRunBudgets(deps());
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "failed",
      error: "budget_exceeded:duration_sec",
    });
    const events = await prisma.event.findMany({
      where: { runId: run.id },
      orderBy: { seq: "asc" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "budget.exceeded",
      "run.failed",
      "delivery.created",
    ]);
    expect(events[1]?.payload).toMatchObject({ reason: "budget_exceeded" });
    const delivery = await prisma.deliveryRecord.findUniqueOrThrow({
      where: { idempotencyKey: `${run.id}:budget_failure` },
    });
    expect(delivery).toMatchObject({ kind: "run_result", runId: run.id, status: "pending" });
    expect(events.at(-1)?.type).toBe("delivery.created");
  });

  it("keeps a durable abort retry when the Runtime abort fails", async () => {
    const run = await running("routine", 3_601);
    abort.mockRejectedValueOnce(new Error("abort unavailable"));

    await expect(enforceRunBudgets(deps(), new Date(), run.id)).resolves.toBe(1);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "failed",
      error: "budget_exceeded:duration_sec",
    });
    expect(
      await prisma.executionRevocation.findUniqueOrThrow({
        where: { kind_subjectId: { kind: "run_abort", subjectId: run.id } },
      }),
    ).toMatchObject({ runId: run.id, attempts: 1, lastError: "abort unavailable" });
  });

  async function clearActiveRuns() {
    await prisma.run.updateMany({
      where: {
        threadId,
        botId,
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      data: { status: "cancelled", leaseOwner: null, completedAt: new Date() },
    });
  }

  it("retries an unattended budget failure with a clean ledger that stays under the rebuilt limit", async () => {
    await clearActiveRuns();
    const run = await running("routine", 3_601);
    await prisma.usageRecord.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        runId: run.id,
        provider: "scripted",
        model: "scripted",
        inputTokens: 400_000,
        outputTokens: 200_000,
      },
    });
    await enforceRunBudgets(deps());
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "failed",
      error: "budget_exceeded:duration_sec",
    });
    const retried = await createManualRetryRun(prisma, {
      spaceId: id,
      userId: id,
      runId: run.id,
      clientNonce: `budget-retry-${run.id}`,
    });
    const successor = await prisma.run.findUniqueOrThrow({ where: { id: retried.runId } });
    expect(successor).toMatchObject({
      status: "queued",
      retryOfRunId: run.id,
      budgetOverride: null,
    });
    expect(await prisma.usageRecord.count({ where: { runId: successor.id } })).toBe(0);
    await prisma.run.update({
      where: { id: successor.id },
      data: {
        status: "running",
        leaseOwner: "budget-worker",
        leaseFence: 1,
        startedAt: new Date(),
      },
    });
    await prisma.attempt.create({
      data: { runId: successor.id, fence: 1, status: "running", startedAt: new Date() },
    });
    expect(await enforceRunBudgets(deps(), new Date(), successor.id)).toBe(0);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: successor.id } })).toMatchObject({
      status: "running",
    });
    await prisma.run.update({
      where: { id: successor.id },
      data: { status: "completed", leaseOwner: null, completedAt: new Date() },
    });
  });

  it("hides retry while the budget card is open and allows it after the owner cancels", async () => {
    await clearActiveRuns();
    const run = await running("user", 902);
    await enforceRunBudgets(deps());
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "waiting_input",
    });
    expect(
      await createManualRetryRun(prisma, {
        spaceId: id,
        userId: id,
        runId: run.id,
        clientNonce: `budget-wait-${run.id}`,
      }),
    ).toMatchObject({ replayed: true, runId: run.id });
    const ask = await pendingAsk(run.id);
    expect(
      await answerRunInput(prisma, {
        spaceId: id,
        threadId,
        runId: run.id,
        messageId: ask.id,
        answeredByUserId: id,
        answer: "cancel_run",
      }),
    ).toBe(true);
    const retried = await createManualRetryRun(prisma, {
      spaceId: id,
      userId: id,
      runId: run.id,
      clientNonce: `budget-cancel-${run.id}`,
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: retried.runId } })).toMatchObject({
      status: "queued",
      retryOfRunId: run.id,
      budgetOverride: null,
    });
  });
});
