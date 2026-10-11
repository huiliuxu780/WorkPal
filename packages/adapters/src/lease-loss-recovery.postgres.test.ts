import { randomUUID } from "node:crypto";
import { createDb, createThreadEvents, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("expired Run lease recovery (PostgreSQL)", () => {
  const id = randomUUID();
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let botId: string;
  let threadId: string;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    await prisma.user.create({ data: { id, name: "Lease test", email: `${id}@example.test`, emailVerified: true } });
    await prisma.organization.create({ data: { id, name: "Lease test", slug: id, createdAt: new Date() } });
    await prisma.space.create({ data: { id, organizationId: id, name: "Lease test" } });
    await prisma.member.create({ data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() } });
    await prisma.spaceMember.create({
      data: { id, spaceId: id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const bot = await prisma.bot.create({ data: { spaceId: id, userId: id, name: "Lease bot", color: "test" } });
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

  async function expiredRun(withAttempt = true) {
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Recover safely", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id, userId: id, botId, threadId, taskId: task.id,
        status: "running", trigger: "user", leaseOwner: "lost-worker", leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });
    if (withAttempt) {
      await prisma.attempt.create({ data: { runId: run.id, fence: 1, status: "running" } });
    }
    return run;
  }

  function recoveryExecutor() {
    const enqueue = vi.fn(async () => undefined);
    const abort = vi.fn(async () => undefined);
    const executor = createRunExecutor({
      prisma,
      events: createThreadEvents(prisma),
      jobs: { enqueue },
      runtime: { abort },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    return { executor, enqueue, abort };
  }

  it("schedules one delayed retry when the expired attempt has no tool or effect", async () => {
    const run = await expiredRun();
    const { executor, enqueue, abort } = recoveryExecutor();

    await executor.continueRun(run.id, "new-worker");

    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "queued", leaseOwner: null, retryAt: expect.any(Date),
    });
    expect(await prisma.event.count({ where: { runId: run.id, type: "run.retried" } })).toBe(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ availableAt: expect.any(Date) }));
    expect(abort).toHaveBeenCalledWith(run.id);
  });

  it("fails the expired attempt instead of replaying an intended external effect", async () => {
    const run = await expiredRun();
    await prisma.externalEffect.create({
      data: {
        spaceId: id, runId: run.id, kind: "send_email",
        idempotencyKey: `lease-effect-${run.id}`, status: "intended", request: {},
      },
    });
    const { executor, enqueue } = recoveryExecutor();

    await executor.continueRun(run.id, "new-worker");

    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "failed", error: expect.stringContaining("outcome unconfirmed"),
    });
    expect(await prisma.event.count({ where: { runId: run.id, type: "run.retried" } })).toBe(0);
    expect(await prisma.event.count({ where: { runId: run.id, type: "run.failed" } })).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("fails a lost running lease with no Attempt and preserves the empty ledger", async () => {
    const run = await expiredRun(false);
    const { executor, enqueue, abort } = recoveryExecutor();

    await executor.continueRun(run.id, "new-worker");

    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "failed", error: expect.stringContaining("before its Attempt record"),
    });
    expect(await prisma.attempt.count({ where: { runId: run.id } })).toBe(0);
    expect(await prisma.event.count({ where: { runId: run.id, type: "run.failed" } })).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith(run.id);
  });
});
