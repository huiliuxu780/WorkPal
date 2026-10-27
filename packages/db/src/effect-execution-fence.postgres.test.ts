import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  claimExternalEffectForExecution,
  releaseExternalEffectClaim,
} from "./external-effects.js";
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

describePostgres("effect execution fence (PostgreSQL)", () => {
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

  async function seedEffect(
    runId: string,
    status: string,
    options: { result?: unknown; kind?: string } = {},
  ) {
    return prisma.externalEffect.create({
      data: {
        spaceId: id,
        runId,
        kind: options.kind ?? "send_email",
        idempotencyKey: `fence-${randomUUID()}`,
        status,
        request: {},
        ...(options.result === undefined ? {} : { result: options.result as never }),
      },
    });
  }

  function identity(runId: string, leaseOwner = "worker-1", leaseFence = 1) {
    return { runId, leaseOwner, leaseFence };
  }

  async function effectStatus(effectId: string) {
    return (await prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } })).status;
  }

  async function waitForBlockedQuery(pattern: string) {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const rows = await prisma.$queryRaw<{ xactStart: Date }[]>`
        SELECT xact_start AS "xactStart"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE ${pattern}
      `;
      if (rows[0]) return rows[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No backend was waiting on a lock for ${pattern}`);
  }

  async function setLeaseExpiry(runId: string, seconds: number) {
    await prisma.$executeRaw`
      UPDATE "runs"
      SET "leaseExpiresAt" = clock_timestamp() + make_interval(secs => ${seconds})
      WHERE id = ${runId}
    `;
    const rows = await prisma.$queryRaw<{ leaseExpiresAt: Date }[]>`
      SELECT "leaseExpiresAt" FROM "runs" WHERE id = ${runId}
    `;
    return rows[0]!.leaseExpiresAt;
  }

  async function waitForLeaseExpiry(runId: string) {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const rows = await prisma.$queryRaw<{ expired: boolean }[]>`
        SELECT clock_timestamp() >= "leaseExpiresAt" AS expired
        FROM "runs"
        WHERE id = ${runId}
      `;
      if (rows[0]?.expired) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Lease did not expire");
  }

  describe("atomic claim", () => {
    it("claims approved exactly once and reports the existing executing state", async () => {
      const run = await seedRun();
      const effect = await seedEffect(run.id, "approved");
      let providerCalls = 0;

      const first = await claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id),
      });
      if (first.outcome === "claimed") providerCalls += 1;
      const second = await claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id),
      });

      expect(first).toEqual({ outcome: "claimed", effectId: effect.id });
      expect(second).toEqual({ outcome: "effect_executing" });
      expect(providerCalls).toBe(1);
      expect(await effectStatus(effect.id)).toBe("executing");
    });

    it("claims intended exactly once and reports the existing executing state", async () => {
      const run = await seedRun();
      const effect = await seedEffect(run.id, "intended");
      let providerCalls = 0;

      const first = await claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "intended",
        execution: identity(run.id),
      });
      if (first.outcome === "claimed") providerCalls += 1;
      const second = await claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "intended",
        execution: identity(run.id),
      });

      expect(first).toEqual({ outcome: "claimed", effectId: effect.id });
      expect(second).toEqual({ outcome: "effect_executing" });
      expect(providerCalls).toBe(1);
    });

    it("rejects an expired lease without advancing the effect", async () => {
      const run = await seedRun({ leaseExpiresAt: new Date(Date.now() - 1_000) });
      const effect = await seedEffect(run.id, "approved");

      const result = await claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id),
      });

      expect(result).toMatchObject({ outcome: "lease_expired" });
      expect(await effectStatus(effect.id)).toBe("approved");
    });

    it("rejects the old worker after a new worker reclaims the lease", async () => {
      const run = await seedRun({ leaseExpiresAt: new Date(Date.now() - 1_000) });
      const effect = await seedEffect(run.id, "approved");
      let providerCalls = 0;

      const stale = await claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id, "worker-1", 1),
      });
      if (stale.outcome === "claimed") providerCalls += 1;

      await prisma.run.update({
        where: { id: run.id },
        data: {
          leaseOwner: "worker-2",
          leaseFence: 2,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const current = await claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id, "worker-2", 2),
      });
      if (current.outcome === "claimed") providerCalls += 1;

      expect(stale).toMatchObject({ outcome: "lease_expired" });
      expect(current).toEqual({ outcome: "claimed", effectId: effect.id });
      expect(providerCalls).toBe(1);
    });

    it("rejects a cancelled Run", async () => {
      const run = await seedRun({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null });
      const effect = await seedEffect(run.id, "approved");

      const result = await claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id),
      });

      expect(result).toEqual({ outcome: "run_cancelled" });
      expect(await effectStatus(effect.id)).toBe("approved");
    });

    it("rejects a Run that is not running", async () => {
      const run = await seedRun({ status: "waiting_input" });
      const effect = await seedEffect(run.id, "approved");

      const result = await claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id),
      });

      expect(result).toEqual({ outcome: "run_not_running", runStatus: "waiting_input" });
      expect(await effectStatus(effect.id)).toBe("approved");
    });

    it("rejects a different lease owner", async () => {
      const run = await seedRun();
      const effect = await seedEffect(run.id, "approved");

      const result = await claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id, "other-worker", 1),
      });

      expect(result).toEqual({
        outcome: "stale_execution",
        reason: "lease_owner_mismatch",
      });
      expect(await effectStatus(effect.id)).toBe("approved");
    });

    it("rejects a different lease fence", async () => {
      const run = await seedRun();
      const effect = await seedEffect(run.id, "approved");

      const result = await claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id, "worker-1", 9),
      });

      expect(result).toEqual({
        outcome: "stale_execution",
        reason: "lease_fence_mismatch",
      });
      expect(await effectStatus(effect.id)).toBe("approved");
    });

    it("rejects an effect owned by another Run", async () => {
      const run = await seedRun();
      const other = await seedRun({ leaseFence: 4 });
      const effect = await seedEffect(other.id, "approved");

      const result = await claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id),
      });

      expect(result).toEqual({ outcome: "effect_run_mismatch", effectRunId: other.id });
      expect(await effectStatus(effect.id)).toBe("approved");
    });

    it("rejects a mismatched effect status path", async () => {
      const run = await seedRun();
      const effect = await seedEffect(run.id, "intended");

      const result = await claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id),
      });

      expect(result).toEqual({ outcome: "unexpected_effect_status", effectStatus: "intended" });
      expect(await effectStatus(effect.id)).toBe("intended");
    });

    it("returns terminal effects without executing them again", async () => {
      const run = await seedRun();
      const completed = await seedEffect(run.id, "completed", {
        result: { ok: true, receipt: "r1" },
      });
      const denied = await seedEffect(run.id, "denied", { result: { reason: "denied" } });
      const uncertain = await seedEffect(run.id, "uncertain", {
        result: { uncertain: true },
      });

      await expect(
        claimExternalEffectForExecution(prisma, {
          effectId: completed.id,
          expectedStatus: "approved",
          execution: identity(run.id),
        }),
      ).resolves.toEqual({
        outcome: "effect_completed",
        result: { ok: true, receipt: "r1" },
      });
      await expect(
        claimExternalEffectForExecution(prisma, {
          effectId: denied.id,
          expectedStatus: "approved",
          execution: identity(run.id),
        }),
      ).resolves.toEqual({ outcome: "effect_denied", result: { reason: "denied" } });
      await expect(
        claimExternalEffectForExecution(prisma, {
          effectId: uncertain.id,
          expectedStatus: "approved",
          execution: identity(run.id),
        }),
      ).resolves.toEqual({ outcome: "effect_uncertain", result: { uncertain: true } });
    });

    it("allows exactly one of two concurrent claims", async () => {
      const run = await seedRun();
      const effect = await seedEffect(run.id, "approved");
      let providerCalls = 0;

      const results = await Promise.all([
        claimExternalEffectForExecution(prisma, {
          effectId: effect.id,
          expectedStatus: "approved",
          execution: identity(run.id),
        }),
        claimExternalEffectForExecution(prisma, {
          effectId: effect.id,
          expectedStatus: "approved",
          execution: identity(run.id),
        }),
      ]);
      for (const result of results) if (result.outcome === "claimed") providerCalls += 1;

      expect(results.filter((result) => result.outcome === "claimed")).toHaveLength(1);
      expect(results.filter((result) => result.outcome === "effect_executing")).toHaveLength(1);
      expect(providerCalls).toBe(1);
    });

    it("lets a committed cancel win against a waiting claim", async () => {
      const run = await seedRun();
      const effect = await seedEffect(run.id, "approved");
      const locked = deferred();
      const release = deferred();

      const cancel = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
        locked.resolve();
        await release.promise;
        await tx.run.update({
          where: { id: run.id },
          data: {
            status: "cancelled",
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: new Date(),
          },
        });
      });
      await locked.promise;
      const claim = claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id),
      });
      release.resolve();
      await cancel;

      await expect(claim).resolves.toEqual({ outcome: "run_cancelled" });
      expect(await effectStatus(effect.id)).toBe("approved");
    });

    it("lets a committed reclaim win against a waiting old-fence claim", async () => {
      const run = await seedRun({ leaseExpiresAt: new Date(Date.now() - 1_000) });
      const effect = await seedEffect(run.id, "approved");
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
      const claim = claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id, "worker-1", 1),
      });
      release.resolve();
      await reclaim;

      await expect(claim).resolves.toEqual({
        outcome: "stale_execution",
        reason: "lease_owner_mismatch",
      });
      expect(await effectStatus(effect.id)).toBe("approved");
    });

    it("accepts a claim that follows a committed lease renewal", async () => {
      const run = await seedRun({ leaseExpiresAt: new Date(Date.now() + 1_000) });
      const effect = await seedEffect(run.id, "approved");
      const locked = deferred();
      const release = deferred();

      const renew = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
        locked.resolve();
        await release.promise;
        await tx.run.update({
          where: { id: run.id },
          data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
        });
      });
      await locked.promise;
      const claim = claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id),
      });
      release.resolve();
      await renew;

      await expect(claim).resolves.toEqual({ outcome: "claimed", effectId: effect.id });
      expect(await effectStatus(effect.id)).toBe("executing");
    });

    it("rejects a claim whose lease expires while it waits for the effect lock", async () => {
      const run = await seedRun();
      const leaseExpiresAt = await setLeaseExpiry(run.id, 2);
      const effect = await seedEffect(run.id, "approved");
      const locked = deferred();
      const release = deferred();

      const blocker = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "external_effects" WHERE id = ${effect.id} FOR UPDATE`;
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const claim = claimExternalEffectForExecution(prisma, {
        effectId: effect.id,
        expectedStatus: "approved",
        execution: identity(run.id),
      });
      const waiting = await waitForBlockedQuery("%external_effects%");
      // The claim's transaction began while the lease was live, which is the
      // snapshot a transaction-start clock would have authorized.
      expect(waiting.xactStart.getTime()).toBeLessThan(leaseExpiresAt.getTime());
      await waitForLeaseExpiry(run.id);
      release.resolve();
      await blocker;

      await expect(claim).resolves.toMatchObject({ outcome: "lease_expired" });
      expect(await effectStatus(effect.id)).toBe("approved");
    });

    it("releases a claimed secret request only under the current fence", async () => {
      const run = await seedRun();
      const effect = await seedEffect(run.id, "executing");

      await expect(
        releaseExternalEffectClaim(prisma, {
          effectId: effect.id,
          execution: identity(run.id, "worker-1", 9),
        }),
      ).resolves.toBe(false);
      expect(await effectStatus(effect.id)).toBe("executing");

      await expect(
        releaseExternalEffectClaim(prisma, {
          effectId: effect.id,
          execution: identity(run.id),
        }),
      ).resolves.toBe(true);
      expect(await effectStatus(effect.id)).toBe("intended");
    });

    it("restores an approved secret request without losing its approval", async () => {
      const run = await seedRun();
      const effect = await seedEffect(run.id, "executing");

      await expect(
        releaseExternalEffectClaim(
          prisma,
          {
            effectId: effect.id,
            execution: identity(run.id),
          },
          { to: "approved" },
        ),
      ).resolves.toBe(true);
      expect(await effectStatus(effect.id)).toBe("approved");
    });
  });
});
