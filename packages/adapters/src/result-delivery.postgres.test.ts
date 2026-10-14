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

  // ---------------------------------------------------------------------------
  // Window-merge contract: one threadId + threadGeneration + 30s window is one
  // delivery Run and one user-visible message for every record count up to the
  // bounded claim (DELIVERY_WINDOW_CLAIM_MAX); overflow beyond that bound is
  // delivered by later batches and is covered in delivery-design.md.
  // ---------------------------------------------------------------------------

  async function newThread() {
    // Thread.botId is unique, so each window-merge fixture needs its own Bot.
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: `Window bot ${randomUUID()}`, color: "test" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    return { threadId: thread.id, botId: bot.id };
  }

  /** One completed/failed source Run plus its run_result outbox record. */
  async function addWindowRecord(
    targetThreadId: string,
    targetBotId: string,
    index: number,
    input: { status: "completed" | "failed"; createdAt: Date; threadGeneration?: number },
  ) {
    const threadGeneration =
      input.threadGeneration ?? (await currentThreadGeneration(prisma, targetThreadId));
    const runKey = `${id}-win-${targetThreadId.slice(-6)}-${index}`;
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: targetBotId,
        threadId: targetThreadId,
        prompt: `Window fixture ${index}`,
        status: input.status,
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: targetBotId,
        threadId: targetThreadId,
        taskId: task.id,
        status: input.status,
        trigger: "routine",
        ...(input.status === "failed" ? { error: `bulk-error-${index}` } : {}),
      },
    });
    const record = await prisma.$transaction((tx) =>
      enqueueDeliveryInTransaction(tx, {
        runId: run.id,
        threadId: targetThreadId,
        threadGeneration,
        kind: "run_result",
        idempotencyKey: `${runKey}:run_result`,
        createdAt: input.createdAt,
      }),
    );
    return { runId: run.id, recordId: record!.id };
  }

  async function completeDeliveryRun(deliveryRunId: string, text: string) {
    const run = await prisma.run.findUniqueOrThrow({ where: { id: deliveryRunId } });
    await createThreadMessage(prisma, {
      threadId: run.threadId,
      botId: run.botId,
      runId: deliveryRunId,
      role: "bot",
      blocks: [{ kind: "text", text }],
    });
    await prisma.run.update({
      where: { id: deliveryRunId },
      data: { status: "completed", completedAt: new Date() },
    });
    await settleDeliveryRun(deps(), deliveryRunId);
  }

  it(
    "merges 101 same-window records into exactly one delivery Run and one message",
    async () => {
      const { threadId: targetThread, botId: targetBot } = await newThread();
      const base = Date.now() - 90_000;
      for (let index = 0; index < 101; index++) {
        await addWindowRecord(targetThread, targetBot, index, {
          status: "completed",
          createdAt: new Date(base + index * 100),
        });
      }
      expect(await dispatchOneDeliveryBatch(deps())).toBe(true);
      const rows = await prisma.deliveryRecord.findMany({ where: { threadId: targetThread } });
      expect(rows).toHaveLength(101);
      // The whole window belongs to one Run; nothing is left for a second batch.
      expect(new Set(rows.map((row) => row.deliveryRunId)).size).toBe(1);
      expect(rows.every((row) => row.status === "claimed" && row.deliveryRunId)).toBe(true);
      expect(
        await prisma.run.count({ where: { threadId: targetThread, trigger: "delivery" } }),
      ).toBe(1);
      // A repeat dispatch after the claim lease expires re-wakes the same Run
      // instead of merging the window twice. Only the lease clock is adjusted.
      await prisma.deliveryRecord.updateMany({
        where: { threadId: targetThread },
        data: { nextAttemptAt: new Date(Date.now() - 1_000) },
      });
      enqueue.mockClear();
      expect(await dispatchOneDeliveryBatch(deps())).toBe(true);
      expect(
        await prisma.run.count({ where: { threadId: targetThread, trigger: "delivery" } }),
      ).toBe(1);
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "run.continue" }),
      );
      expect(
        await prisma.deliveryRecord.count({ where: { threadId: targetThread, status: "sent" } }),
      ).toBe(0);

      const deliveryRunId = rows[0]!.deliveryRunId!;
      await completeDeliveryRun(deliveryRunId, "One summary for 101 results");
      expect(
        await prisma.deliveryRecord.count({ where: { threadId: targetThread, status: "sent" } }),
      ).toBe(101);
      expect(
        await prisma.event.count({ where: { threadId: targetThread, type: "delivery.sent" } }),
      ).toBe(101);
      expect(
        await prisma.message.count({ where: { threadId: targetThread, role: "bot" } }),
      ).toBe(1);
      // Idempotency: a second settle adds no message and no events.
      await settleDeliveryRun(deps(), deliveryRunId);
      expect(
        await prisma.event.count({ where: { threadId: targetThread, type: "delivery.sent" } }),
      ).toBe(101);
      expect(
        await prisma.message.count({ where: { threadId: targetThread, role: "bot" } }),
      ).toBe(1);
      // Nothing is left to claim, so no second window message can appear.
      expect(await dispatchOneDeliveryBatch(deps())).toBe(false);
      expect(
        await prisma.run.count({ where: { threadId: targetThread, trigger: "delivery" } }),
      ).toBe(1);
    },
    60_000,
  );

  it(
    "merges 205 mixed records into one Run with a bounded prompt and exact hidden counts",
    async () => {
      const { threadId: targetThread, botId: targetBot } = await newThread();
      const base = Date.now() - 90_000;
      for (let index = 0; index < 205; index++) {
        // The five newest records are all failures, so the overflow the prompt
        // cannot list individually is a deterministic "5 more failed" count.
        const status = index >= 200 ? "failed" : index % 2 === 0 ? "completed" : "failed";
        await addWindowRecord(targetThread, targetBot, index, {
          status,
          createdAt: new Date(base + index * 100),
        });
      }
      expect(await dispatchOneDeliveryBatch(deps())).toBe(true);
      const rows = await prisma.deliveryRecord.findMany({ where: { threadId: targetThread } });
      expect(rows).toHaveLength(205);
      expect(new Set(rows.map((row) => row.deliveryRunId)).size).toBe(1);
      expect(rows.every((row) => row.status === "claimed" && row.deliveryRunId)).toBe(true);
      const deliveryRuns = await prisma.run.findMany({
        where: { threadId: targetThread, trigger: "delivery" },
      });
      expect(deliveryRuns).toHaveLength(1);
      const task = await prisma.task.findUniqueOrThrow({ where: { id: deliveryRuns[0]!.taskId } });
      // The prompt stays bounded and honest about what it does not list.
      expect(task.prompt.length).toBeLessThan(60_000);
      expect(task.prompt).toContain("5 more failed or cancelled items");
      expect(task.prompt).not.toContain("more completed items");
      expect(task.prompt.match(/^- Item /gm)).toHaveLength(200);
      expect(task.prompt).toContain("bulk-error-1");
      expect(task.prompt).toContain("bulk-error-199");
      // Hidden items are counted, never shown as detail and never denied.
      expect(task.prompt).not.toContain("bulk-error-200");

      await completeDeliveryRun(deliveryRuns[0]!.id, "One summary for 205 results");
      expect(
        await prisma.deliveryRecord.count({ where: { threadId: targetThread, status: "sent" } }),
      ).toBe(205);
      expect(
        await prisma.event.count({ where: { threadId: targetThread, type: "delivery.sent" } }),
      ).toBe(205);
      expect(
        await prisma.message.count({ where: { threadId: targetThread, role: "bot" } }),
      ).toBe(1);
      await settleDeliveryRun(deps(), deliveryRuns[0]!.id);
      expect(
        await prisma.event.count({ where: { threadId: targetThread, type: "delivery.sent" } }),
      ).toBe(205);
      expect(await dispatchOneDeliveryBatch(deps())).toBe(false);
    },
    120_000,
  );

  it("never merges two Threads that finish inside the same window", async () => {
    const { threadId: threadA, botId: botA } = await newThread();
    const { threadId: threadB, botId: botB } = await newThread();
    const base = Date.now() - 90_000;
    for (let index = 0; index < 2; index++) {
      await addWindowRecord(threadA, botA, index, {
        status: "completed",
        createdAt: new Date(base + index * 100),
      });
      await addWindowRecord(threadB, botB, index, {
        status: "completed",
        createdAt: new Date(base + index * 100),
      });
    }
    expect(await dispatchOneDeliveryBatch(deps())).toBe(true);
    expect(await dispatchOneDeliveryBatch(deps())).toBe(true);
    for (const target of [threadA, threadB]) {
      const rows = await prisma.deliveryRecord.findMany({ where: { threadId: target } });
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.deliveryRunId)).size).toBe(1);
      const deliveryRun = await prisma.run.findUniqueOrThrow({
        where: { id: rows[0]!.deliveryRunId! },
      });
      expect(deliveryRun.trigger).toBe("delivery");
      expect(deliveryRun.threadId).toBe(target);
    }
    expect(await prisma.run.count({ where: { threadId: threadA, trigger: "delivery" } })).toBe(1);
    expect(await prisma.run.count({ where: { threadId: threadB, trigger: "delivery" } })).toBe(1);
  });

  it("never merges two Thread generations inside the same window", async () => {
    const { threadId: targetThread, botId: targetBot } = await newThread();
    const base = Date.now() - 90_000;
    await addWindowRecord(targetThread, targetBot, 0, {
      status: "completed",
      createdAt: new Date(base),
      threadGeneration: 0,
    });
    await addWindowRecord(targetThread, targetBot, 1, {
      status: "completed",
      createdAt: new Date(base + 100),
      threadGeneration: 0,
    });
    // A real thread has history before a clear; seed one event so the
    // thread.cleared marker lands on seq > 0 and bumps the generation.
    await prisma.thread.update({
      where: { id: targetThread },
      data: { nextEventSeq: { increment: 1 } },
    });
    await prisma.event.create({
      data: {
        spaceId: id,
        threadId: targetThread,
        botId: targetBot,
        seq: 0,
        type: "thread.message.created",
        payload: {},
      },
    });
    await clearThread(prisma, { spaceId: id, botId: targetBot, threadId: targetThread });
    const generation = await currentThreadGeneration(prisma, targetThread);
    expect(generation).toBeGreaterThan(0);
    await addWindowRecord(targetThread, targetBot, 2, {
      status: "completed",
      createdAt: new Date(base + 200),
      threadGeneration: generation,
    });
    await addWindowRecord(targetThread, targetBot, 3, {
      status: "completed",
      createdAt: new Date(base + 300),
      threadGeneration: generation,
    });

    // First batch: the stale generation is suppressed, never merged forward.
    expect(await dispatchOneDeliveryBatch(deps())).toBe(true);
    const stale = await prisma.deliveryRecord.findMany({
      where: { threadId: targetThread, threadGeneration: 0 },
    });
    expect(stale).toHaveLength(2);
    expect(stale.every((row) => row.status === "sent" && row.lastError === "stale_generation")).toBe(
      true,
    );
    expect(stale.every((row) => row.deliveryRunId === null)).toBe(true);
    // Second batch: only the current generation forms the one delivery Run.
    expect(await dispatchOneDeliveryBatch(deps())).toBe(true);
    const fresh = await prisma.deliveryRecord.findMany({
      where: { threadId: targetThread, threadGeneration: generation },
    });
    expect(fresh).toHaveLength(2);
    expect(new Set(fresh.map((row) => row.deliveryRunId)).size).toBe(1);
    expect(fresh.every((row) => row.deliveryRunId)).toBe(true);
    expect(await prisma.run.count({ where: { threadId: targetThread, trigger: "delivery" } })).toBe(
      1,
    );
    await completeDeliveryRun(fresh[0]!.deliveryRunId!, "One summary for the fresh generation");
    expect(
      await prisma.message.count({ where: { threadId: targetThread, role: "bot" } }),
    ).toBe(1);
    expect(
      await prisma.event.count({ where: { threadId: targetThread, type: "delivery.sent" } }),
    ).toBe(2);
  });
});
