import type { GroupRouterReasonCode } from "./group-routing.js";
import type { ResponseMode, TurnRouteKind } from "./response-owner.js";

/**
 * Product Harness snapshot persisted on a Run the moment it is created
 * (Product Harness §8). The snapshot is immutable for the Run's lifetime: a
 * retry or continuation must reuse the stored decision and must never
 * re-route a Run to a different bot.
 */

export const RUN_ORCHESTRATION_VERSION = "v1" as const;

export type RunOrchestrationV1 = {
  version: typeof RUN_ORCHESTRATION_VERSION;
  routing: {
    kind: TurnRouteKind;
    /** Present only when the Group Router participated in this decision. */
    reasonCode?: GroupRouterReasonCode;
  };
  ownership: {
    /** Phase 1 only produces "owner"; "support" belongs to later phases. */
    mode: "owner" | "support";
    ownerBotId: string;
  };
  responseMode: ResponseMode;
};

const TURN_ROUTE_KINDS: readonly TurnRouteKind[] = [
  "direct",
  "explicit_mention",
  "explicit_multi",
  "reply_target",
  "group_router",
  "fallback_lead",
];

export function buildRunOrchestration(input: {
  kind: TurnRouteKind;
  ownerBotId: string;
  responseMode: ResponseMode;
  reasonCode?: GroupRouterReasonCode | null;
}): RunOrchestrationV1 {
  const orchestration: RunOrchestrationV1 = {
    version: RUN_ORCHESTRATION_VERSION,
    routing: { kind: input.kind },
    ownership: { mode: "owner", ownerBotId: input.ownerBotId },
    responseMode: input.responseMode,
  };
  if (input.reasonCode) orchestration.routing.reasonCode = input.reasonCode;
  return orchestration;
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
  return {
    version: RUN_ORCHESTRATION_VERSION,
    routing: {
      kind: routing.kind,
      ...(isReasonCode(routing.reasonCode) ? { reasonCode: routing.reasonCode } : {}),
    },
    ownership: { mode: ownership.mode, ownerBotId: ownership.ownerBotId },
    responseMode: raw.responseMode,
  };
}
