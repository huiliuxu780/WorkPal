import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import {
  claimDueDeliveryBatch,
  deliveryRetryAt,
  enqueueDeliveryInTransaction,
} from "./delivery-records.js";

describe("delivery retry schedule", () => {
  it("allows five retries after the first attempt, then stops", () => {
    const now = new Date("2026-10-12T00:00:00Z");
    expect(
      [1, 2, 3, 4, 5].map((attempt) => deliveryRetryAt(attempt, now)!.getTime() - now.getTime()),
    ).toEqual([10_000, 30_000, 120_000, 600_000, 1_800_000]);
    expect(deliveryRetryAt(6, now)).toBeNull();
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("delivery outbox (PostgreSQL)", () => {
  const prefix = `delivery-test-${randomUUID()}`;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let runId: string;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    const id = randomUUID();
    await prisma.user.create({
      data: { id, name: "Delivery outbox test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Delivery outbox test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Delivery outbox test" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Delivery test", color: "test" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Test",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "completed",
        trigger: "user",
      },
    });
    runId = run.id;
  });

  afterAll(async () => {
    if (!db) return;
    await prisma.deliveryRecord.deleteMany({ where: { idempotencyKey: { startsWith: prefix } } });
    const source = runId
      ? await prisma.run.findUnique({ where: { id: runId }, select: { userId: true } })
      : null;
    if (source) {
      await prisma.organization.deleteMany({ where: { id: source.userId } });
      await prisma.user.deleteMany({ where: { id: source.userId } });
    }
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("ignores a duplicate enqueue and waits for the 30-second merge window", async () => {
    const createdAt = new Date();
    const input = {
      runId,
      backgroundTaskId: "background-1",
      threadId: `${prefix}-thread-a`,
      threadGeneration: 0,
      kind: "background_task" as const,
      idempotencyKey: `${prefix}-duplicate`,
      createdAt,
    };
    const first = await prisma.$transaction((tx) => enqueueDeliveryInTransaction(tx, input));
    const duplicate = await prisma.$transaction((tx) => enqueueDeliveryInTransaction(tx, input));
    expect(first).toBeTruthy();
    expect(duplicate).toBeNull();
    expect(
      await prisma.deliveryRecord.count({ where: { idempotencyKey: input.idempotencyKey } }),
    ).toBe(1);
    expect(
      await claimDueDeliveryBatch(prisma, "worker-1", new Date(createdAt.getTime() + 29_999)),
    ).toEqual([]);
  });

  it("skips a locked row so a second worker can claim another Thread", async () => {
    const createdAt = new Date(Date.now() - 120_000);
    const ids = await prisma.deliveryRecord.createManyAndReturn({
      data: [
        {
          runId,
          threadId: `${prefix}-thread-locked`,
          threadGeneration: 0,
          kind: "background_task",
          idempotencyKey: `${prefix}-locked`,
          createdAt,
          nextAttemptAt: createdAt,
        },
        {
          runId,
          threadId: `${prefix}-thread-free`,
          threadGeneration: 0,
          kind: "background_task",
          idempotencyKey: `${prefix}-free`,
          createdAt: new Date(createdAt.getTime() + 1_000),
          nextAttemptAt: createdAt,
        },
      ],
      select: { id: true, idempotencyKey: true },
    });
    const locked = ids.find((row) => row.idempotencyKey.endsWith("-locked"))!;
    let acquired!: () => void;
    let release!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "delivery_records" WHERE "id" = ${locked.id} FOR UPDATE`;
      acquired();
      await releasePromise;
    });
    await acquiredPromise;
    try {
      const batch = await claimDueDeliveryBatch(prisma, "worker-2");
      expect(batch).toHaveLength(1);
      expect(batch[0]?.idempotencyKey).toBe(`${prefix}-free`);
    } finally {
      release();
      await holding;
      await prisma.deliveryRecord.updateMany({
        where: { id: { in: ids.map((row) => row.id) } },
        data: { status: "sent" },
      });
    }
  });

  it("does not split one Thread window across workers when its first row is locked", async () => {
    const createdAt = new Date(Date.now() - 120_000);
    const rows = await prisma.deliveryRecord.createManyAndReturn({
      data: [
        {
          runId,
          threadId: `${prefix}-shared-thread`,
          threadGeneration: 0,
          kind: "background_task",
          idempotencyKey: `${prefix}-shared-first`,
          createdAt,
          nextAttemptAt: createdAt,
        },
        {
          runId,
          threadId: `${prefix}-shared-thread`,
          threadGeneration: 0,
          kind: "background_task",
          idempotencyKey: `${prefix}-shared-second`,
          createdAt: new Date(createdAt.getTime() + 10_000),
          nextAttemptAt: createdAt,
        },
      ],
      select: { id: true, idempotencyKey: true },
    });
    const first = rows.find((row) => row.idempotencyKey.endsWith("-shared-first"))!;
    let acquired!: () => void;
    let release!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "delivery_records" WHERE "id" = ${first.id} FOR UPDATE`;
      acquired();
      await releasePromise;
    });
    await acquiredPromise;
    try {
      expect(await claimDueDeliveryBatch(prisma, "worker-2")).toEqual([]);
    } finally {
      release();
      await holding;
    }
    const claimed = await claimDueDeliveryBatch(prisma, "worker-1");
    expect(claimed.map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
  });
});
