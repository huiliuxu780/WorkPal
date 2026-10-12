import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import {
  clearThread,
  createDb,
  createThreadMessage,
  currentThreadGeneration,
  enqueueDeliveryInTransaction,
  type PrismaClient,
  type ThreadEvents,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchOneDeliveryBatch, settleDeliveryRun } from "./result-delivery.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("background result delivery (PostgreSQL)", () => {
  const id = randomUUID();
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let botId: string;
  let threadId: string;
  let sourceRunId: string;
  const enqueue = vi.fn(async () => undefined);
  const notify = vi.fn(async () => undefined);
  const deps = () => ({
    prisma,
    jobs: { enqueue } as unknown as JobPublisher,
    events: { notify } as unknown as ThreadEvents,
    workerId: `delivery-test-${id}`,
  });

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    await prisma.user.create({
      data: { id, name: "Delivery test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Delivery test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Delivery test" } });
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
      data: { spaceId: id, userId: id, name: "Delivery bot", color: "test" },
    });
    botId = bot.id;
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId } });
    threadId = thread.id;
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        prompt: "Analyze records",
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
      },
    });
    sourceRunId = run.id;
  });

  afterAll(async () => {
    if (!db) return;
    if (threadId) await prisma.deliveryRecord.deleteMany({ where: { threadId } });
    await prisma.organization.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  async function addFinishedTask(taskId: string, status: "completed" | "failed", createdAt: Date) {
    const threadGeneration = await currentThreadGeneration(prisma, threadId);
    await prisma.backgroundAgentTask.create({
      data: {
        taskId,
        parentRunId: sourceRunId,
        userId: id,
        spaceId: id,
        botId,
        threadId,
        threadGeneration,
        agentId: taskId,
        sessionId: `session-${taskId}`,
        toolNames: [],
        status,
        expiresAt: new Date(Date.now() + 3_600_000),
        finishedAt: createdAt,
        result: status === "completed" ? `result-${taskId}` : null,
        error: status === "failed" ? `error-${taskId}` : null,
      },
    });
    return prisma.$transaction((tx) =>
      enqueueDeliveryInTransaction(tx, {
        runId: sourceRunId,
        backgroundTaskId: taskId,
        threadId,
        threadGeneration,
        kind: "background_task",
        idempotencyKey: `${taskId}:background_task`,
        createdAt,
      }),
    );
  }

  it("merges two terminal results into one delivery Run and marks one message sent", async () => {
    const createdAt = new Date(Date.now() - 90_000);
    const first = await addFinishedTask(`${id}-first`, "completed", createdAt);
    const second = await addFinishedTask(
      `${id}-second`,
      "failed",
      new Date(createdAt.getTime() + 10_000),
    );
    expect(first && second).toBeTruthy();

    expect(await dispatchOneDeliveryBatch(deps())).toBe(true);
    const rows = await prisma.deliveryRecord.findMany({
      where: { threadId },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(
      rows.every((row) => row.status === "claimed" && row.deliveryRunId === rows[0]?.deliveryRunId),
    ).toBe(true);
    const deliveryRunId = rows[0]!.deliveryRunId!;
    const deliveryRuns = await prisma.run.findMany({ where: { threadId, trigger: "delivery" } });
    expect(deliveryRuns).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: deliveryRunId } }),
    );
    const task = await prisma.task.findUniqueOrThrow({ where: { id: deliveryRuns[0]!.taskId } });
    expect(task.prompt).toContain(`result-${id}-first`);
    expect(task.prompt).toContain(`error-${id}-second`);
    expect(task.prompt).toContain("Failed or cancelled:");
    expect(await prisma.message.count({ where: { threadId } })).toBe(0);

    const message = await createThreadMessage(prisma, {
      threadId,
      botId,
      runId: deliveryRunId,
      role: "bot",
      blocks: [{ kind: "text", text: "One merged summary" }],
    });
    await prisma.run.update({
      where: { id: deliveryRunId },
      data: { status: "completed", completedAt: new Date() },
    });
    await settleDeliveryRun(deps(), deliveryRunId);
    expect(await prisma.deliveryRecord.count({ where: { threadId, status: "sent" } })).toBe(2);
    expect(await prisma.event.count({ where: { threadId, type: "delivery.sent" } })).toBe(2);
    expect(await prisma.message.count({ where: { threadId, role: "bot" } })).toBe(1);
    expect(message.id).toBeTruthy();
    await settleDeliveryRun(deps(), deliveryRunId);
    expect(await prisma.event.count({ where: { threadId, type: "delivery.sent" } })).toBe(2);
  });

  it("suppresses a late result after Thread clear", async () => {
    const createdAt = new Date(Date.now() - 90_000);
    const stale = await addFinishedTask(`${id}-stale`, "completed", createdAt);
    await clearThread(prisma, { spaceId: id, botId, threadId });
    const beforeRuns = await prisma.run.count({ where: { threadId, trigger: "delivery" } });
    expect(await dispatchOneDeliveryBatch(deps())).toBe(true);
    expect(
      await prisma.deliveryRecord.findUniqueOrThrow({ where: { id: stale!.id } }),
    ).toMatchObject({
      status: "sent",
      lastError: "stale_generation",
    });
    expect(await prisma.run.count({ where: { threadId, trigger: "delivery" } })).toBe(beforeRuns);
    expect(await prisma.message.count({ where: { threadId } })).toBe(0);
  });

  it("emits an activity-visible failure after five retries", async () => {
    const createdAt = new Date(Date.now() - 90_000);
    const failed = await addFinishedTask(`${id}-retry`, "completed", createdAt);
    expect(await dispatchOneDeliveryBatch(deps())).toBe(true);
    const claimed = await prisma.deliveryRecord.findUniqueOrThrow({ where: { id: failed!.id } });
    await prisma.deliveryRecord.update({ where: { id: failed!.id }, data: { attempts: 6 } });
    await prisma.run.update({
      where: { id: claimed.deliveryRunId! },
      data: { status: "failed", error: "Model unavailable", completedAt: new Date() },
    });
    await settleDeliveryRun(deps(), claimed.deliveryRunId!);
    const final = await prisma.deliveryRecord.findUniqueOrThrow({ where: { id: failed!.id } });
    expect(final.status).toBe("failed");
    expect(final.lastError).toBe("Model unavailable");
    expect(await prisma.event.count({ where: { threadId, type: "delivery.failed" } })).toBe(1);
  });
});
