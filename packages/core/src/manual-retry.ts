import type { ManualRetryDenyReason, ManualRetryProjection } from "@rakazo/contracts";
import { parseRunOrchestration } from "./product-harness/orchestration.js";

export const MANUAL_RETRY_INELIGIBLE_TRIGGERS = new Set(["delivery", "created", "spawn"]);

export const MANUAL_RETRY_ACTIVE_STATUSES = [
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
] as const;

const TERMINAL_RETRY_STATUSES = new Set(["failed", "cancelled"]);

export function isManualRetryEligibleTrigger(trigger: string): boolean {
  return !MANUAL_RETRY_INELIGIBLE_TRIGGERS.has(trigger);
}

export function isRootRunOrchestration(orchestration: unknown): boolean {
  const parent = parseRunOrchestration(orchestration)?.collaboration?.parentRunId;
  return parent == null || parent === "";
}

export function isManualRetryActiveStatus(status: string): boolean {
  return (MANUAL_RETRY_ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function projectManualRetryEligibility(input: {
  status: string;
  trigger: string;
  orchestration: unknown;
  successorStatus?: string | null;
}): ManualRetryProjection {
  if (!isRootRunOrchestration(input.orchestration)) {
    return { allowed: false, reason: "not_root" };
  }
  if (!isManualRetryEligibleTrigger(input.trigger)) {
    return { allowed: false, reason: "ineligible_trigger" };
  }
  if (input.successorStatus) {
    if (isManualRetryActiveStatus(input.successorStatus)) {
      return { allowed: false, reason: "already_active" };
    }
    if (input.successorStatus === "completed") {
      return { allowed: false, reason: "completed" };
    }
  }
  if (input.status === "completed") return { allowed: false, reason: "completed" };
  if (!TERMINAL_RETRY_STATUSES.has(input.status)) {
    return { allowed: false, reason: "not_terminal" };
  }
  return { allowed: true };
}

export type ManualRetryChainEffect = {
  id: string;
  runId: string;
  kind: string;
  status: string;
  request: unknown;
  result: unknown;
  reviewDecision: string | null;
  createdAt: Date | string;
};

export type ManualRetryEffectDecision =
  | { kind: "reuse"; effect: ManualRetryChainEffect }
  | { kind: "execute" }
  | { kind: "skip"; reason: "cancelled" | "confirmed_without_result" }
  | { kind: "pause"; effect: ManualRetryChainEffect };

export type { ManualRetryDenyReason, ManualRetryProjection };
