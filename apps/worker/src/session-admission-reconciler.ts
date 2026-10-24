import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import {
  listAvailableSessionAdmissionHeads,
  type PrismaClient,
  recoverExpiredSessionAdmissions,
} from "@rakazo/db";

/**
 * Parks expired owners in the absorbing RT-25 recovering state, then repairs
 * only missed wakeups for sessions that are already available. It never turns
 * expiry into permission for a successor to enter AgentScope.
 */
export async function reconcileSessionAdmissions(
  prisma: PrismaClient,
  jobs: JobPublisher,
): Promise<{ recovered: number; scheduled: number }> {
  const recovered = await recoverExpiredSessionAdmissions(prisma);
  const heads = await listAvailableSessionAdmissionHeads(prisma);
  let scheduled = 0;
  for (const head of heads) {
    await jobs.enqueue(runContinueJob(head.runId));
    scheduled += 1;
  }
  return { recovered: recovered.length, scheduled };
}
