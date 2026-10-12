import type { PrismaClient } from "./client.js";

/** Extend a running lease only when the caller still owns that fence. */
export async function renewOwnedRunLease(
  prisma: PrismaClient,
  input: {
    runId: string;
    leaseOwner: string;
    leaseFence: number;
    leaseExpiresAt: Date;
  },
): Promise<boolean> {
  const renewed = await prisma.run.updateMany({
    where: {
      id: input.runId,
      status: "running",
      leaseOwner: input.leaseOwner,
      leaseFence: input.leaseFence,
    },
    data: { leaseExpiresAt: input.leaseExpiresAt },
  });
  return renewed.count === 1;
}
