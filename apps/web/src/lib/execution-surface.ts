import type {
  ExecutionSummary,
  InterventionView,
  Run,
  RunPlanRevision,
  RunStepSnapshot,
} from "@rakazo/contracts";
import {
  type ExecutionDetailCache,
  executionDataForRun,
  selectCachedDetailEntry,
} from "./execution-history";

/**
 * UX-01B core rule 1: whether a Run gets an Execution surface at all.
 *
 * Exactly four signals create one — a structured Plan, a semantic Step, a
 * pending Intervention (or any waiting state), or failure. Todos, tool
 * Activity, `MessageBlock.kind="steps"`, native `plan_write` output and plain
 * running states never create a surface on their own; a plain Run lives in
 * the lightweight one-line progress state until its final reply.
 *
 * Pure derivation only: no DOM, no RPC, no global state.
 */

export type ExecutionSurfaceSignals = {
  hasPlan: boolean;
  hasSemanticSteps: boolean;
  hasPendingIntervention: boolean;
  failed: boolean;
};

export function shouldRenderExecutionSurface(signals: ExecutionSurfaceSignals): boolean {
  return (
    signals.hasPlan || signals.hasSemanticSteps || signals.hasPendingIntervention || signals.failed
  );
}

export type EligibleExecutionRunIdsInput = {
  runs: readonly Pick<Run, "id" | "status" | "waitKind">[];
  plans?: readonly RunPlanRevision[] | null;
  steps?: readonly RunStepSnapshot[] | null;
  /** Server per-Run summaries (HISTORY-001); null on legacy servers. */
  serverSummaries: ReadonlyMap<string, ExecutionSummary> | null;
  /** The rev-guarded detail cache shared with the render path. */
  executionDetails?: ExecutionDetailCache;
  interventions?: readonly InterventionView[] | null;
};

/**
 * The set of Run ids that currently earn an Execution surface. Mirrors the
 * render path's data precedence exactly (`executionDataForRun` + the
 * `executionRunState` status precedence + the rev-guarded detail cache), so
 * eligibility can never disagree with what the opened card would show.
 *
 * The trusted server step count keeps a summary-window Run eligible before
 * its detail loads; it is a real semantic-Step fact, never an estimate.
 */
export function eligibleExecutionRunIds(input: EligibleExecutionRunIdsInput): ReadonlySet<string> {
  const candidates = new Set<string>();
  for (const run of input.runs) candidates.add(run.id);
  for (const runId of input.serverSummaries?.keys() ?? []) candidates.add(runId);
  for (const view of input.interventions ?? []) candidates.add(view.runId);
  for (const plan of input.plans ?? []) candidates.add(plan.runId);
  for (const step of input.steps ?? []) candidates.add(step.runId);

  const eligible = new Set<string>();
  for (const runId of candidates) {
    const summary = input.serverSummaries?.get(runId) ?? null;
    const entry = selectCachedDetailEntry(
      input.executionDetails ?? {},
      runId,
      summary ? summary.rev : null,
    );
    const detail = entry?.snapshot;
    const run = input.runs.find((candidate) => candidate.id === runId) ?? null;
    // Same precedence as executionRunState: a genuinely fresher detail wins;
    // otherwise the live Run row; otherwise the durable projection.
    const freshDetail =
      detail && (summary ? detail.summary.rev > summary.rev : run === null) ? detail.summary : null;
    const statusSource = freshDetail ?? (run ? null : (detail?.summary ?? summary));
    const status = statusSource ? statusSource.status : (run?.status ?? null);
    const data = executionDataForRun({
      runId,
      detail,
      legacy: { plans: input.plans ?? [], steps: input.steps ?? [] },
    });
    const hasPendingIntervention =
      (input.interventions ?? []).some(
        (view) => view.runId === runId && view.status === "pending",
      ) ||
      // A waiting Run always owns a live interaction (approval/input card or
      // takeover), even before its Intervention projection arrives.
      status === "waiting_input" ||
      status === "waiting_takeover";
    if (
      shouldRenderExecutionSurface({
        hasPlan: Boolean(data.plan),
        hasSemanticSteps: data.steps.length > 0 || (summary?.counts?.steps ?? 0) > 0,
        hasPendingIntervention,
        failed: status === "failed",
      })
    ) {
      eligible.add(runId);
    }
  }
  return eligible;
}
