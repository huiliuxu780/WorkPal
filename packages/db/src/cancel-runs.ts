import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma } from "./client.js";
import { recordRunAbortRevocations } from "./execution-revocations.js";

/** Attempts that still represent the current fence. Finished rows stay untouched. */
const ACTIVE_ATTEMPT_STATUSES = ["running", "waiting_input", "waiting_takeover"] as const;

export type CancelledRunRow = {
  id: string;
  taskId: string;
  threadId: string;
  spaceId: string;
  botId: string;
};

export type CancelRunsOptions = {
  error?: string;
  attemptError?: string;
  clearCheckpoint?: boolean;
  /** Extra predicates, ANDed with the active-status guard, so a raced transition is left alone. */
  match?: Prisma.RunWhereInput;
};

/**
 * Cancel only still-active runs. Lease fence is kept so a late callback from the
 * old worker is rejected. Wait, retry, and lease ownership are cleared together.
 * The caller owns the transaction, events, and any post-commit network revocation.
 */
export async function cancelRunsInTransaction(
  tx: Pick<Prisma.TransactionClient, "run" | "attempt" | "task"> &
    Partial<Pick<Prisma.TransactionClient, "backgroundAgentTask" | "executionRevocation">>,
  runs: ReadonlyArray<{ id: string; taskId: string }>,
  cancelledAt: Date,
  options?: CancelRunsOptions,
): Promise<CancelledRunRow[]> {
  if (runs.length === 0) return [];
  const runIds = runs.map((run) => run.id);
  // Settle pending Interventions before the run row becomes cancelled. History
  // events are rejected once the run is cancelled, and a second cancel matches
  // zero pending rows so it does not append another terminal event.
  const { cancelPendingInterventions } = await import("./interventions.js");
  await cancelPendingInterventions(
    tx as Prisma.TransactionClient,
    runIds,
    cancelledAt,
    options?.match,
  );
  const cancelled = await tx.run.updateManyAndReturn({
    where: {
      AND: [
        { id: { in: runIds }, status: { in: [...ACTIVE_RUN_STATUSES] } },
        ...(options?.match ? [options.match] : []),
      ],
    },
    data: {
      status: "cancelled",
      waitKind: null,
      waitStartedAt: null,
      retryAt: null,
      completedAt: cancelledAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      ...(options?.error ? { error: options.error } : {}),
      ...(options?.clearCheckpoint ? { checkpoint: null } : {}),
    },
    select: { id: true, taskId: true, threadId: true, spaceId: true, botId: true },
  });
  if (cancelled.length === 0) return [];
  const cancelledIds = cancelled.map((run) => run.id);
  await tx.attempt.updateMany({
    where: {
      runId: { in: cancelledIds },
      status: { in: [...ACTIVE_ATTEMPT_STATUSES] },
    },
    data: {
      status: "cancelled",
      finishedAt: cancelledAt,
      ...(options?.attemptError ? { error: options.attemptError } : {}),
    },
  });
  await tx.task.updateMany({
    where: { id: { in: cancelled.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
  // The Worker revokes native AgentScope work for these durable cancellation requests.
  // A late completion/tool callback sees a non-running projection and is rejected.
  await tx.backgroundAgentTask?.updateMany({
    where: { parentRunId: { in: cancelledIds }, status: "running" },
    data: { status: "cancelling" },
  });
  // The row outlives the Run. The caller still aborts immediately; a failed
  // remote DELETE stays here for the worker sweep. 404 deletes the row later.
  await recordRunAbortRevocations(tx, cancelledIds);
  return cancelled;
}
