import type { Prisma } from "./client.js";

type LockClient = Prisma.TransactionClient;

export async function lockRun(tx: LockClient, runId: string) {
  await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`;
}

export async function lockIntervention(tx: LockClient, interventionId: string) {
  await tx.$queryRaw`SELECT id FROM interventions WHERE id = ${interventionId} FOR UPDATE`;
}

/**
 * Lock the Thread rows a settling transaction is about to write, in the ONE
 * order every path uses: execution Threads first (sorted), then presentation
 * Threads (sorted).
 *
 * Terminalizing an Intervention appends an event, which writes the Thread row;
 * without a pre-lock a cancel that starts from the Run takes Run → Thread while
 * an answer takes Thread → Run — the deadlock PostgreSQL resolves by aborting
 * one transaction with 40P01.
 *
 * Two groups rather than one sorted set: every cancel and clear entry point in
 * this repository locks the Run's own Thread before it reaches this helper, so a
 * presentation Thread that happens to sort earlier would be acquired second and
 * invert against a concurrent answer. Grouping keeps those callers correct
 * unchanged, because the Thread a caller pre-locks is always an execution Thread
 * and a presentation Thread is only ever reached from here.
 *
 * Precondition: a presentation Thread is never the execution Thread of another
 * cross-Thread Intervention. RT-03 guarantees that — a Thread humans cannot
 * write to is not addressable as a presentation target.
 */
export async function lockThreadGroups(
  tx: LockClient,
  executionThreadIds: Iterable<string | null | undefined>,
  presentationThreadIds: Iterable<string | null | undefined> = [],
): Promise<void> {
  const locked = new Set<string>();
  for (const group of [executionThreadIds, presentationThreadIds]) {
    const unique = [...new Set(group)].filter((threadId): threadId is string => Boolean(threadId));
    for (const threadId of unique.sort()) {
      if (locked.has(threadId)) continue;
      locked.add(threadId);
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
    }
  }
}

/** Lock one Intervention's execution Thread, then the Thread it is presented in. */
export async function lockInterventionThreads(
  tx: LockClient,
  executionThreadId: string | null | undefined,
  presentationThreadId?: string | null,
): Promise<void> {
  await lockThreadGroups(tx, [executionThreadId], [presentationThreadId]);
}
