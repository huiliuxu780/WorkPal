import type { PrismaClient } from "./client.js";

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
