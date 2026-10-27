import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import {
  listAvailableSessionAdmissionHeads,
  type PrismaClient,
  recoverExpiredSessionAdmissions,
  releaseSessionAdmissionsWithTerminalOwner,
} from "@rakazo/db";

/**
 * Parks expired owners in the absorbing RT-25 recovering state, then repairs
 * only missed wakeups for sessions that are already available. It never turns
 * expiry into permission for a successor to enter AgentScope.
 *
 * FIX-STOP-01 adds one earlier pass: a Run that already reached a terminal state
 * cannot be executing, so its hold is released on that durable fact — not on
 * elapsed time. Without it a single Stop left the session parked as `recovering`
 * with no proof path and no expiry exit, so the conversation never ran again.
 */
export async function reconcileSessionAdmissions(
  prisma: PrismaClient,
  jobs: JobPublisher,
): Promise<{ recovered: number; released: number; scheduled: number }> {
  const released = await releaseSessionAdmissionsWithTerminalOwner(prisma);
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
