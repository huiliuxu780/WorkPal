import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import {
  listAvailableSessionAdmissionHeads,
  listCancelledSessionsToRecover,
  type PrismaClient,
  recoverExpiredSessionAdmissions,
  releaseCancelledSessionsThatNeverStarted,
} from "@rakazo/db";

/**
 * Parks expired owners in the absorbing RT-25 recovering state, then repairs only
 * missed wakeups for sessions that are already available. It never turns expiry
 * into permission for a successor to enter AgentScope.
 *
 * FIX-STOP-01 adds two earlier passes, both scoped to Stop:
 *
 *   - sessions the runtime never entered are released on the cancelled status;
 *   - sessions the runtime did enter are re-dispatched as `runContinueJob` for the
 *     owner Run, so the existing RT-26 terminal-owner hook can attempt the
 *     clean/detached proof. This layer only classifies: an absent `run_abort`
 *     revocation means the runtime accepted the abort, not that the execution
 *     exited or the session detached, so releasing here would be wrong. No
 *     checkpoint id, watermark, intervention, or acknowledgement logic is
 *     duplicated in this file.
 */
export async function reconcileSessionAdmissions(
  prisma: PrismaClient,
  jobs: JobPublisher,
): Promise<{ recovered: number; released: number; recoveryDispatched: number; scheduled: number }> {
  const released = await releaseCancelledSessionsThatNeverStarted(prisma);
  const toRecover = await listCancelledSessionsToRecover(prisma);
  const recovered = await recoverExpiredSessionAdmissions(prisma);
  const heads = await listAvailableSessionAdmissionHeads(prisma);

  let recoveryDispatched = 0;
  for (const owner of toRecover) {
    await jobs.enqueue(runContinueJob(owner.runId));
    recoveryDispatched += 1;
  }

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
  return {
    recovered: recovered.length,
    released: released.length,
    recoveryDispatched,
    scheduled,
  };
}
