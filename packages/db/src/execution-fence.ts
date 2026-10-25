import type { Prisma } from "./client.js";

export type ExecutionIdentity = {
  runId: string;
  leaseOwner: string;
  leaseFence: number;
};

export type ExecutionFenceFailure =
  | "run_not_found"
  | "run_cancelled"
  | "run_not_running"
  | "lease_owner_mismatch"
  | "lease_fence_mismatch"
  | "lease_expired";

export type LockedRunLease = {
  status: string;
  leaseOwner: string | null;
  leaseFence: number;
  leaseExpiresAt: Date | null;
  leaseValid: boolean;
};

export class StaleExecutionError extends Error {
  constructor(public readonly reason: ExecutionFenceFailure) {
    super(`Execution authority is no longer valid: ${reason}`);
    this.name = "StaleExecutionError";
  }
}

/** Locks the Run row first so cancellation, reclaim, renewal, and effect claims share one order. */
export async function lockRunLease(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<LockedRunLease | null> {
  const rows = await tx.$queryRaw<LockedRunLease[]>`
    SELECT
      "status",
      "leaseOwner",
      "leaseFence",
      "leaseExpiresAt",
      ("leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" > now()) AS "leaseValid"
    FROM "runs"
    WHERE id = ${runId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export function executionFenceFailure(
  run: LockedRunLease | null,
  identity: ExecutionIdentity,
): ExecutionFenceFailure | null {
  if (!run) return "run_not_found";
  if (run.status === "cancelled") return "run_cancelled";
  if (run.status !== "running") return "run_not_running";
  if (run.leaseOwner !== identity.leaseOwner) return "lease_owner_mismatch";
  if (run.leaseFence !== identity.leaseFence) return "lease_fence_mismatch";
  if (!run.leaseValid) return "lease_expired";
  return null;
}

/** Use for persisted execution facts (for example agent.tool.called) inside their write transaction. */
export async function assertActiveExecutionFence(
  tx: Prisma.TransactionClient,
  identity: ExecutionIdentity,
): Promise<void> {
  const run = await lockRunLease(tx, identity.runId);
  const failure = executionFenceFailure(run, identity);
  if (failure) throw new StaleExecutionError(failure);
}
