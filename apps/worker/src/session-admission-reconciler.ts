import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import {
  listAvailableSessionAdmissionHeads,
  type PrismaClient,
  recoverExpiredSessionAdmissions,
  releaseSettledCancelledSessionAdmissions,
} from "@rakazo/db";

/**
 * Parks expired owners in the absorbing RT-25 recovering state, then repairs
 * only missed wakeups for sessions that are already available. It never turns
 * expiry into permission for a successor to enter AgentScope.
 *
 * FIX-STOP-01 adds one earlier pass, scoped to Stop: a cancelled Run whose
 * native abort has been confirmed (its `run_abort` revocation is gone) hands the
 * session back on that fact — not on elapsed time. A cancelled Run whose abort
 * is still undelivered, and every failed or completed owner, keep the RT-26
 * recovering park unchanged.
 */
export async function reconcileSessionAdmissions(
  prisma: PrismaClient,
  jobs: JobPublisher,
): Promise<{ recovered: number; released: number; scheduled: number }> {
  const released = await releaseSettledCancelledSessionAdmissions(prisma);
  const recovered = await recoverExpiredSessionAdmissions(prisma);
  const heads = await listAvailableSessionAdmissionHeads(prisma);
  const wake: string[] = [];
  const seen = new Set<string>();
  for (const runId of [
    ...released.map((item) => item.nextRunId),
    ...heads.map((head) => head.runId),
  ]) {
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    wake.push(runId);
  }
  let scheduled = 0;
  for (const runId of wake) {
    await jobs.enqueue(runContinueJob(runId));
    scheduled += 1;
  }
  return { recovered: recovered.length, released: released.length, scheduled };
}
