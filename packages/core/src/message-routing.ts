import { RunStatus } from "@rakazo/contracts";
import { isConversationalRun } from "./run-state.js";

/**
 * RT-27: one deterministic decision for a message that arrives while a Bot may
 * already be working in the Thread.
 *
 * The decision never depends on row order. A single eligible Run is steered; two
 * or more eligible Runs are never reduced to "the first one" — the message needs
 * its own Task instead. A routine, webhook, delivery, or creation-intro turn is
 * not the conversation, so it is never a steering candidate.
 */

/** Run states whose turn can still absorb a chat message as steering. */
const STEERABLE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "queued",
  "leased",
  "running",
  "waiting_takeover",
]);

export type SteeringCandidate = {
  runId: string;
  taskId: string;
  botId: string;
  status: string;
  trigger: string | null;
};

/**
 * Scoped facts about an explicitly addressed Task. The caller resolves these
 * inside the message's Space, Thread, owner, and Bot scope; `null` means the
 * Task is absent, foreign, or otherwise not enumerable.
 */
export type AmendmentTargetFact = {
  taskId: string;
  botId: string;
  /** False when the Task exists but cannot take a natural-language revision. */
  amendable: boolean;
};

export type MessageRouteRejectCode = "target_task_not_found" | "target_task_not_amendable";

export type MessageRouteDecision =
  | { kind: "amend_target_task"; taskId: string; botId: string }
  | { kind: "steer_existing_run"; runId: string; taskId: string; botId: string }
  | {
      kind: "create_independent_run";
      botId: string;
      reason: "no_steerable_candidate" | "multiple_steerable_candidates";
    }
  | { kind: "reject"; code: MessageRouteRejectCode };

/** A Run that may take this message as steering: conversation turn, still open. */
export function isSteerableChatRun(run: { status: string; trigger?: string | null }): boolean {
  const status = RunStatus.safeParse(run.status);
  return (
    status.success && STEERABLE_RUN_STATUSES.has(status.data) && isConversationalRun(run.trigger)
  );
}

/**
 * Route one message for one Bot in one Thread.
 *
 * `candidates` may arrive in any order and may contain Runs of other Bots; the
 * result is order-independent by construction because it counts distinct
 * eligible Run ids instead of selecting an index.
 */
export function decideMessageRoute(input: {
  botId: string;
  /** Present only when the caller's message explicitly names a Task. */
  explicitTargetTaskId?: string | null;
  /** Scoped fact for `explicitTargetTaskId`; must be null when the id is absent. */
  amendmentTarget?: AmendmentTargetFact | null;
  candidates: readonly SteeringCandidate[];
}): MessageRouteDecision {
  const explicitTargetTaskId = input.explicitTargetTaskId?.trim() || null;
  if (explicitTargetTaskId) {
    const target = input.amendmentTarget;
    // A Task of another Bot, Thread, Space, or user is indistinguishable from a
    // missing one. There is no fallback to any other candidate.
    if (!target || target.taskId !== explicitTargetTaskId || target.botId !== input.botId) {
      return { kind: "reject", code: "target_task_not_found" };
    }
    if (!target.amendable) return { kind: "reject", code: "target_task_not_amendable" };
    return { kind: "amend_target_task", taskId: target.taskId, botId: target.botId };
  }

  const eligible = new Map<string, SteeringCandidate>();
  for (const candidate of input.candidates) {
    if (candidate.botId !== input.botId) continue;
    if (!isSteerableChatRun(candidate)) continue;
    eligible.set(candidate.runId, candidate);
  }
  if (eligible.size === 1) {
    const [only] = [...eligible.values()];
    return {
      kind: "steer_existing_run",
      runId: only!.runId,
      taskId: only!.taskId,
      botId: only!.botId,
    };
  }
  return {
    kind: "create_independent_run",
    botId: input.botId,
    reason: eligible.size === 0 ? "no_steerable_candidate" : "multiple_steerable_candidates",
  };
}

/** Canonical order for reading candidates; the decision itself never indexes it. */
export const STEERING_CANDIDATE_ORDER = [{ createdAt: "asc" }, { id: "asc" }] as const;
