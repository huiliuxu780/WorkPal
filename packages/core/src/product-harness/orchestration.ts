import type { CollaborationLineageV1 } from "./collaboration.js";
import type { GroupRouterReasonCode } from "./group-routing.js";
import type { ResponseMode, TurnRouteKind } from "./response-owner.js";

/**
 * Product Harness snapshot persisted on a Run the moment it is created
 * (Product Harness §8, extended by Phase 2 Turn Policy §B2). The snapshot is
 * immutable for the Run's lifetime: a retry or continuation must reuse the
 * stored decision and must never re-route a Run or recompute its policy.
 */

export const RUN_ORCHESTRATION_VERSION = "v1" as const;

/** Phase 2 execution block: the TurnPolicy facets stored with the decision. */
export type OrchestrationExecutionV1 = {
  interactive: boolean;
  planning: "disabled" | "auto";
  delegation: {
    mode: "disabled" | "auto";
    background: boolean;
    maxChildren: number;
    maxDepth: number;
  };
};

export type RunOrchestrationV1 = {
  version: typeof RUN_ORCHESTRATION_VERSION;
  routing: {
    kind: TurnRouteKind;
    /** Present only when the Group Router participated in this decision. */
    reasonCode?: GroupRouterReasonCode;
  };
  ownership: {
    /** Phase 1 only produces "owner"; "support" comes with bot-message turns. */
    mode: "owner" | "support";
    ownerBotId: string;
  };
  responseMode: ResponseMode;
  /** Absent on Phase 1 rows; readers must fall back to trigger-derived policy. */
  execution?: OrchestrationExecutionV1;
  /** Phase 3 collaboration lineage; absent on pre-Phase-3 rows. */
  collaboration?: CollaborationLineageV1;
};

const TURN_ROUTE_KINDS: readonly TurnRouteKind[] = [
  "direct",
  "explicit_mention",
  "explicit_multi",
  "reply_target",
  "group_router",
  "fallback_lead",
  "handoff",
  "bot_message",
  "automation",
];

export function buildRunOrchestration(input: {
  kind: TurnRouteKind;
  ownerBotId: string;
  responseMode: ResponseMode;
  reasonCode?: GroupRouterReasonCode | null;
  ownershipMode?: "owner" | "support";
  execution?: OrchestrationExecutionV1 | null;
  collaboration?: CollaborationLineageV1 | null;
}): RunOrchestrationV1 {
  const orchestration: RunOrchestrationV1 = {
    version: RUN_ORCHESTRATION_VERSION,
    routing: { kind: input.kind },
    ownership: { mode: input.ownershipMode ?? "owner", ownerBotId: input.ownerBotId },
    responseMode: input.responseMode,
  };
  if (input.reasonCode) orchestration.routing.reasonCode = input.reasonCode;
  if (input.execution) orchestration.execution = input.execution;
  if (input.collaboration) orchestration.collaboration = input.collaboration;
  return orchestration;
}

export function parseCollaborationLineage(value: unknown): CollaborationLineageV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.role !== "owner" && raw.role !== "support") return null;
  if (raw.source !== "user" && raw.source !== "bot_message" && raw.source !== "handoff") return null;
  if (raw.fromBotId !== null && typeof raw.fromBotId !== "string") return null;
  if (raw.parentRunId !== null && typeof raw.parentRunId !== "string") return null;
  if (typeof raw.handoffDepth !== "number" || !Number.isInteger(raw.handoffDepth) || raw.handoffDepth < 0) {
    return null;
  }
  if (typeof raw.messageHop !== "number" || !Number.isInteger(raw.messageHop) || raw.messageHop < 0) {
    return null;
  }
  return {
    role: raw.role,
    source: raw.source,
    fromBotId: raw.fromBotId ?? null,
    parentRunId: raw.parentRunId ?? null,
    handoffDepth: raw.handoffDepth,
    messageHop: raw.messageHop,
  };
}

function isTurnRouteKind(value: unknown): value is TurnRouteKind {
  return typeof value === "string" && (TURN_ROUTE_KINDS as readonly string[]).includes(value);
}

function isReasonCode(value: unknown): value is GroupRouterReasonCode {
  return (
    typeof value === "string" &&
    (["specialist_match", "generalist_match", "collaboration_request", "fallback_lead"] as readonly string[]).includes(
      value,
    )
  );
}

export function parseOrchestrationExecution(value: unknown): OrchestrationExecutionV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.interactive !== "boolean") return null;
  if (raw.planning !== "disabled" && raw.planning !== "auto") return null;
  const delegation = raw.delegation as Record<string, unknown> | undefined;
  if (!delegation || typeof delegation !== "object") return null;
  if (delegation.mode !== "disabled" && delegation.mode !== "auto") return null;
  if (typeof delegation.background !== "boolean") return null;
  if (typeof delegation.maxChildren !== "number" || !Number.isInteger(delegation.maxChildren) || delegation.maxChildren < 0) {
    return null;
  }
  if (typeof delegation.maxDepth !== "number" || !Number.isInteger(delegation.maxDepth) || delegation.maxDepth < 0) {
    return null;
  }
  return {
    interactive: raw.interactive,
    planning: raw.planning,
    delegation: {
      mode: delegation.mode,
      background: delegation.background,
      maxChildren: delegation.maxChildren,
      maxDepth: delegation.maxDepth,
    },
  };
}

/**
 * Read a stored orchestration back as a validated v1 snapshot. Returns null
 * for absent, foreign-shape or corrupt values so callers can treat them as
 * "no recorded decision" instead of trusting partial JSON.
 */
export function parseRunOrchestration(value: unknown): RunOrchestrationV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== RUN_ORCHESTRATION_VERSION) return null;
  const routing = raw.routing as Record<string, unknown> | undefined;
  const ownership = raw.ownership as Record<string, unknown> | undefined;
  if (!routing || typeof routing !== "object" || !isTurnRouteKind(routing.kind)) return null;
  if (!ownership || typeof ownership !== "object") return null;
  if (ownership.mode !== "owner" && ownership.mode !== "support") return null;
  if (typeof ownership.ownerBotId !== "string" || !ownership.ownerBotId) return null;
  if (raw.responseMode !== "single" && raw.responseMode !== "multi") return null;
  const orchestration: RunOrchestrationV1 = {
    version: RUN_ORCHESTRATION_VERSION,
    routing: {
      kind: routing.kind,
      ...(isReasonCode(routing.reasonCode) ? { reasonCode: routing.reasonCode } : {}),
    },
    ownership: { mode: ownership.mode, ownerBotId: ownership.ownerBotId },
    responseMode: raw.responseMode,
  };
  // A malformed execution block must not invalidate the routing/ownership
  // decision; readers fall back to the trigger-derived policy instead.
  if (raw.execution !== undefined && raw.execution !== null) {
    const execution = parseOrchestrationExecution(raw.execution);
    if (execution) orchestration.execution = execution;
  }
  // Same tolerance for the Phase 3 lineage block.
  if (raw.collaboration !== undefined && raw.collaboration !== null) {
    const collaboration = parseCollaborationLineage(raw.collaboration);
    if (collaboration) orchestration.collaboration = collaboration;
  }
  return orchestration;
}
