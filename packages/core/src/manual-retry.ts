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
  /** Backend-assigned logical id. Falls back to `id` for unsaved fixtures. */
  operationId?: string | null;
};

export type ManualRetryEffectDecision =
  | { kind: "reuse"; effect: ManualRetryChainEffect }
  | { kind: "execute"; operationId?: string }
  | { kind: "skip"; reason: "cancelled" | "confirmed_without_result" }
  | { kind: "pause"; effect: ManualRetryChainEffect }
  | { kind: "reject"; reason: "unknown_operation" | "bind_mismatch" };

/** Reserved tool-argument key. Stripped before persist/send. */
export const RETRY_OPERATION_ID_KEY = "retryOperationId";

/** Declare the reserved retry id on a model-visible JSON Schema object. */
export function withRetryOperationIdSchema(schema: unknown): Record<string, unknown> {
  const base: Record<string, unknown> =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? { ...(schema as Record<string, unknown>) }
      : { type: "object" };
  const rawProperties = base.properties;
  const properties: Record<string, unknown> =
    rawProperties && typeof rawProperties === "object" && !Array.isArray(rawProperties)
      ? { ...(rawProperties as Record<string, unknown>) }
      : {};
  return {
    ...base,
    type: typeof base.type === "string" ? base.type : "object",
    properties: {
      ...properties,
      [RETRY_OPERATION_ID_KEY]: {
        type: "string",
        description:
          "Exact backend operation id from the retry context. The server strips this field before persist or send. Omit to start a new independent operation.",
      },
    },
  };
}

/** Runtime-facing tool list. Wrap schemas on retry Runs; pass through otherwise. */
export function toolsForRetryRun<T extends { inputSchema?: unknown }>(
  tools: T[],
  retryOfRunId: string | null | undefined,
): T[] {
  if (!retryOfRunId) return tools;
  return tools.map((tool) => ({
    ...tool,
    inputSchema: withRetryOperationIdSchema(tool.inputSchema),
  }));
}

export type { ManualRetryDenyReason, ManualRetryProjection };
