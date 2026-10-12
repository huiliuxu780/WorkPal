import type { PrismaClient } from "./client.js";

const ACTIVE_ATTEMPT_STATUSES = ["running", "waiting_input", "waiting_takeover"] as const;

/**
 * Promote a still-leased Run to running and open its Attempt in one transaction.
 * A crash or unique conflict rolls both back, so a running Run is never committed
 * without the Attempt for the same fence.
 */
export async function promoteLeasedRunWithAttempt(
  prisma: PrismaClient,
  input: {
    runId: string;
    leaseOwner: string;
    leaseFence: number;
    startedAt: Date;
  },
): Promise<{ id: string; fence: number } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${input.runId} FOR UPDATE`;
    const promoted = await tx.run.updateMany({
      where: {
        id: input.runId,
        status: "leased",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
        leaseExpiresAt: { gt: new Date() },
      },
      data: { status: "running", startedAt: input.startedAt },
    });
    if (promoted.count !== 1) return null;
    return tx.attempt.create({
      data: { runId: input.runId, fence: input.leaseFence, status: "running" },
      select: { id: true, fence: true },
    });
  });
}

export type AttemptFenceReconcile =
  | { outcome: "reused"; attempt: { id: string; fence: number } }
  | { outcome: "failed" }
  | { outcome: "left" };

/**
 * Resolve a unique (runId, fence) conflict without opening another fence.
 * The caller still owns the leased fence. One transaction either reuses the
 * active Attempt for that fence, or fails the Run when that Attempt is already
 * terminal. Other active Attempts on the Run are finished in the same transaction.
 * A lease this worker no longer owns is left untouched.
 */
export async function reconcileAttemptFenceConflict(
  prisma: PrismaClient,
  input: {
    runId: string;
    leaseOwner: string;
    leaseFence: number;
    startedAt: Date;
  },
): Promise<AttemptFenceReconcile> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${input.runId} FOR UPDATE`;
    const run = await tx.run.findUnique({
      where: { id: input.runId },
      select: {
        status: true,
        leaseOwner: true,
        leaseFence: true,
        leaseExpiresAt: true,
        taskId: true,
      },
    });
    const ownsLease =
      run?.status === "leased" &&
      run.leaseOwner === input.leaseOwner &&
      run.leaseFence === input.leaseFence &&
      run.leaseExpiresAt !== null &&
      run.leaseExpiresAt > new Date();
    if (!run || !ownsLease) return { outcome: "left" };

    const attempt = await tx.attempt.findUnique({
      where: { runId_fence: { runId: input.runId, fence: input.leaseFence } },
      select: { id: true, fence: true, status: true },
    });
    if (!attempt) return { outcome: "left" };

    await tx.attempt.updateMany({
      where: {
        runId: input.runId,
        id: { not: attempt.id },
        status: { in: [...ACTIVE_ATTEMPT_STATUSES] },
      },
      data: {
        status: "failed",
        finishedAt: new Date(),
        error: "Superseded during attempt fence reconciliation",
      },
    });

    const active = (ACTIVE_ATTEMPT_STATUSES as readonly string[]).includes(attempt.status);
    if (active) {
      const promoted = await tx.run.updateMany({
        where: {
          id: input.runId,
          status: "leased",
          leaseOwner: input.leaseOwner,
          leaseFence: input.leaseFence,
          leaseExpiresAt: { gt: new Date() },
        },
        data: {
          status: "running",
          startedAt: input.startedAt,
          waitKind: null,
          waitStartedAt: null,
        },
      });
      if (promoted.count !== 1) return { outcome: "left" };
      if (attempt.status !== "running") {
        await tx.attempt.update({
          where: { id: attempt.id },
          data: { status: "running", finishedAt: null, error: null },
        });
      }
      return { outcome: "reused", attempt: { id: attempt.id, fence: attempt.fence } };
    }

    const failed = await tx.run.updateMany({
      where: {
        id: input.runId,
        status: "leased",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: "Attempt fence conflict: the Attempt for this fence already finished",
        leaseOwner: null,
        leaseExpiresAt: null,
        retryAt: null,
      },
    });
    if (failed.count !== 1) return { outcome: "left" };
    await tx.task.updateMany({
      where: { id: run.taskId },
      data: { status: "failed" },
    });
    return { outcome: "failed" };
  });
}
