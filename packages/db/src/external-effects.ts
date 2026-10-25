import type { Prisma, PrismaClient } from "./client.js";
import {
  type ExecutionIdentity,
  executionFenceFailure,
  lockRunLease,
} from "./execution-fence.js";

export type ClaimExternalEffectOutcome =
  | { outcome: "claimed"; effectId: string }
  | { outcome: "run_not_found" }
  | { outcome: "effect_not_found" }
  | { outcome: "effect_run_mismatch"; effectRunId: string }
  | { outcome: "run_cancelled" }
  | { outcome: "run_not_running"; runStatus: string }
  | { outcome: "stale_execution"; reason: "lease_owner_mismatch" | "lease_fence_mismatch" }
  | { outcome: "lease_expired"; leaseExpiresAt: Date | null }
  | { outcome: "effect_completed"; result: unknown }
  | { outcome: "effect_denied"; result: unknown }
  | { outcome: "effect_executing" }
  | { outcome: "effect_uncertain"; result: unknown }
  | { outcome: "unexpected_effect_status"; effectStatus: string };

type LockedEffect = {
  id: string;
  runId: string;
  status: string;
  result: unknown;
};

/**
 * The only production path that moves an ExternalEffect into executing.
 *
 * Locks the Run first, then the effect, and validates the caller's execution
 * identity with database time in that same transaction. A stale worker, an
 * expired lease, or a cancelled/reclaimed Run is rejected before any provider
 * call can start.
 */
export async function claimExternalEffectForExecution(
  prisma: PrismaClient,
  input: {
    effectId: string;
    expectedStatus: "approved" | "intended";
    execution: ExecutionIdentity;
  },
): Promise<ClaimExternalEffectOutcome> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const run = await lockRunLease(tx, input.execution.runId);
    if (!run) return { outcome: "run_not_found" } as const;

    const effects = await tx.$queryRaw<LockedEffect[]>`
      SELECT id, "runId", status, result
      FROM "external_effects"
      WHERE id = ${input.effectId}
      FOR UPDATE
    `;
    const effect = effects[0];
    if (!effect) return { outcome: "effect_not_found" } as const;
    if (effect.runId !== input.execution.runId) {
      return { outcome: "effect_run_mismatch", effectRunId: effect.runId } as const;
    }

    const failure = executionFenceFailure(run, input.execution);
    if (failure === "run_cancelled") return { outcome: "run_cancelled" } as const;
    if (failure === "run_not_running") {
      return { outcome: "run_not_running", runStatus: run.status } as const;
    }
    if (failure === "lease_owner_mismatch" || failure === "lease_fence_mismatch") {
      return { outcome: "stale_execution", reason: failure } as const;
    }
    if (failure === "lease_expired") {
      return { outcome: "lease_expired", leaseExpiresAt: run.leaseExpiresAt } as const;
    }
    if (failure === "run_not_found") return { outcome: "run_not_found" } as const;

    if (effect.status !== input.expectedStatus) {
      if (effect.status === "completed") {
        return { outcome: "effect_completed", result: effect.result } as const;
      }
      if (effect.status === "denied") {
        return { outcome: "effect_denied", result: effect.result } as const;
      }
      if (effect.status === "executing") return { outcome: "effect_executing" } as const;
      if (effect.status === "uncertain") {
        return { outcome: "effect_uncertain", result: effect.result } as const;
      }
      return { outcome: "unexpected_effect_status", effectStatus: effect.status } as const;
    }

    const claimed = await tx.externalEffect.updateMany({
      where: { id: effect.id, status: input.expectedStatus },
      data: { status: "executing" },
    });
    if (claimed.count !== 1) {
      throw new Error("ExternalEffect changed while its row was locked");
    }
    return { outcome: "claimed", effectId: effect.id } as const;
  });
}

/** Return a claimed secret-request effect to intended under the same execution fence. */
export async function releaseExternalEffectClaim(
  prisma: PrismaClient,
  input: { effectId: string; execution: ExecutionIdentity },
): Promise<boolean> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const run = await lockRunLease(tx, input.execution.runId);
    if (executionFenceFailure(run, input.execution)) return false;
    const released = await tx.externalEffect.updateMany({
      where: {
        id: input.effectId,
        runId: input.execution.runId,
        status: "executing",
      },
      data: { status: "intended" },
    });
    return released.count === 1;
  });
}
