import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import {
  listAvailableSessionAdmissionHeads,
  listTerminalSessionsToRecover,
  type PrismaClient,
  recoverExpiredSessionAdmissions,
  releaseCancelledSessionsThatNeverStarted,
} from "@rakazo/db";

/**
 * Parks expired owners in the absorbing RT-25 recovering state, then repairs only
 * missed wakeups for sessions that are already available. It never turns expiry
 * into permission for a successor to enter AgentScope.
 *
 * Terminal owners are handled by two earlier passes:
 *
 *   - sessions the runtime never entered are released on the cancelled status;
 *   - sessions the runtime did enter are re-dispatched as `runContinueJob` for the
 *     terminal owner Run, so the existing RT-26 hook can attempt the
 *     clean/detached proof. Cancelled owners wait for abort delivery; failed
 *     owners are retried after any unproven one-shot settlement. This layer only
 *     classifies and never treats status, abort acceptance, expiry, or time as a
 *     detach proof. No checkpoint id, watermark, intervention, or
 *     acknowledgement logic is duplicated here.
 */
export async function reconcileSessionAdmissions(
  prisma: PrismaClient,
  jobs: JobPublisher,
): Promise<{ recovered: number; released: number; recoveryDispatched: number; scheduled: number }> {
  const released = await releaseCancelledSessionsThatNeverStarted(prisma);
  const toRecover = await listTerminalSessionsToRecover(prisma);
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
