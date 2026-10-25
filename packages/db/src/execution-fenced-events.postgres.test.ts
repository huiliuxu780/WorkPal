import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createThreadEvents } from "./events.js";
import { StaleExecutionError } from "./execution-fence.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describePostgres("execution-fenced event writes (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let botId: string;
  let threadId: string;
  let sequence = 0;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("effect_fence");
    prisma = isolated.db.prisma;
    await prisma.user.create({
      data: { id, name: "Effect fence", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Effect fence", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Effect fence" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: { id, spaceId: id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Fence bot", color: "test" },
    });
    botId = bot.id;
    const thread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId },
    });
    threadId = thread.id;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  async function seedRun(
    overrides: {
      status?: string;
      leaseOwner?: string | null;
      leaseFence?: number;
      leaseExpiresAt?: Date | null;
    } = {},
  ) {
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        prompt: `effect fence ${++sequence}`,
        status: "running",
      },
    });
    return prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: overrides.status ?? "running",
        trigger: "user",
        leaseOwner: overrides.leaseOwner ?? "worker-1",
        leaseFence: overrides.leaseFence ?? 1,
        leaseExpiresAt: overrides.leaseExpiresAt ?? new Date(Date.now() + 60_000),
      },
    });
  }

  describe("execution-fenced event writes", () => {
    const events = () => createThreadEvents(prisma);

    async function appendCalled(runId: string, execution: { leaseOwner: string; leaseFence: number }) {
      return events().append({
        spaceId: id,
        threadId,
        botId,
        runId,
        type: "agent.tool.called",
        execution,
        payload: { name: "send_email", executionId: `call-${randomUUID()}` },
      });
    }

    it("writes agent.tool.called for the live owner and rejects stale or expired writers", async () => {
      const run = await seedRun();
      await expect(
        appendCalled(run.id, { leaseOwner: "worker-1", leaseFence: 1 }),
      ).resolves.toMatchObject({ type: "agent.tool.called" });

      await expect(
        appendCalled(run.id, { leaseOwner: "worker-2", leaseFence: 1 }),
      ).rejects.toMatchObject({ name: "StaleExecutionError", reason: "lease_owner_mismatch" });
      await expect(
        appendCalled(run.id, { leaseOwner: "worker-1", leaseFence: 2 }),
      ).rejects.toMatchObject({ name: "StaleExecutionError", reason: "lease_fence_mismatch" });

      await prisma.run.update({
        where: { id: run.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      await expect(
        appendCalled(run.id, { leaseOwner: "worker-1", leaseFence: 1 }),
      ).rejects.toMatchObject({ name: "StaleExecutionError", reason: "lease_expired" });

      expect(
        await prisma.event.count({ where: { runId: run.id, type: "agent.tool.called" } }),
      ).toBe(1);
    });

    it("rejects a stale writer after a new worker takes over", async () => {
      const run = await seedRun({ leaseExpiresAt: new Date(Date.now() - 1_000) });
      await prisma.run.update({
        where: { id: run.id },
        data: {
          leaseOwner: "worker-2",
          leaseFence: 2,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });

      await expect(
        appendCalled(run.id, { leaseOwner: "worker-1", leaseFence: 1 }),
      ).rejects.toBeInstanceOf(StaleExecutionError);
      await expect(
        appendCalled(run.id, { leaseOwner: "worker-2", leaseFence: 2 }),
      ).resolves.toMatchObject({ type: "agent.tool.called" });
      expect(
        await prisma.event.count({ where: { runId: run.id, type: "agent.tool.called" } }),
      ).toBe(1);
    });

    it("rejects a cancelled Run without appending the event", async () => {
      const run = await seedRun({
        status: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
      });

      await expect(
        appendCalled(run.id, { leaseOwner: "worker-1", leaseFence: 1 }),
      ).rejects.toMatchObject({ name: "StaleExecutionError", reason: "run_cancelled" });
      expect(await prisma.event.count({ where: { runId: run.id } })).toBe(0);
    });

    it("lets a committed reclaim win against a waiting stale event write", async () => {
      const run = await seedRun({ leaseExpiresAt: new Date(Date.now() - 1_000) });
      const locked = deferred();
      const release = deferred();

      const reclaim = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
        locked.resolve();
        await release.promise;
        await tx.run.update({
          where: { id: run.id },
          data: {
            leaseOwner: "worker-2",
            leaseFence: 2,
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });
      });
      await locked.promise;
      const write = appendCalled(run.id, { leaseOwner: "worker-1", leaseFence: 1 });
      release.resolve();
      await reclaim;

      await expect(write).rejects.toBeInstanceOf(StaleExecutionError);
      expect(await prisma.event.count({ where: { runId: run.id } })).toBe(0);
    });
  });
});
