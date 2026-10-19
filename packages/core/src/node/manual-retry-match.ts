import { createHash } from "node:crypto";
import {
  MANUAL_RETRY_EFFECT_AUTHORIZED,
  MANUAL_RETRY_EFFECT_CANCELLED,
  MANUAL_RETRY_EFFECT_CONFIRMED,
} from "@rakazo/contracts";
import { stableJsonValue } from "../approval-effect-key.js";
import type { ManualRetryChainEffect, ManualRetryEffectDecision } from "../manual-retry.js";

/** Same marker adapters persist on catalog / bound-direct `ExternalEffect.request`. */
const RETRY_REQUEST_MARKER = "__rakazoCatalogTool";
const DIRECT_RETRY_TAG = "direct";

type RetryBoundRoute = {
  connectorId: string;
  resourceId: string;
  toolName: string;
  resourceRevision?: string | number;
};

export function manualRetryArgsDigest(request: unknown): string {
  return createHash("sha256").update(stableJsonValue(request)).digest("hex");
}

function parseRetryBoundRoute(value: unknown): RetryBoundRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const route = value as Record<string, unknown>;
  if (
    typeof route.connectorId !== "string" ||
    typeof route.resourceId !== "string" ||
    typeof route.toolName !== "string"
  ) {
    return undefined;
  }
  if (
    route.resourceRevision !== undefined &&
    typeof route.resourceRevision !== "string" &&
    typeof route.resourceRevision !== "number"
  ) {
    return undefined;
  }
  return {
    connectorId: route.connectorId,
    resourceId: route.resourceId,
    toolName: route.toolName,
    ...(route.resourceRevision !== undefined ? { resourceRevision: route.resourceRevision } : {}),
  };
}

function catalogRetryDetails(
  request: unknown,
): { toolName: string; args: Record<string, unknown>; route?: RetryBoundRoute } | undefined {
  if (
    !Array.isArray(request) ||
    (request.length !== 3 && request.length !== 4) ||
    request[0] !== RETRY_REQUEST_MARKER ||
    typeof request[1] !== "string" ||
    !request[1].endsWith("_execute_tool") ||
    !request[2] ||
    typeof request[2] !== "object" ||
    Array.isArray(request[2])
  ) {
    return undefined;
  }
  if (request.length === 3) {
    return { toolName: request[1], args: request[2] as Record<string, unknown> };
  }
  const route = parseRetryBoundRoute(request[3]);
  if (!route) return undefined;
  return {
    toolName: request[1],
    args: request[2] as Record<string, unknown>,
    route,
  };
}

function boundDirectRetryDetails(
  request: unknown,
): { route: RetryBoundRoute; args: Record<string, unknown> } | undefined {
  if (
    !Array.isArray(request) ||
    request.length !== 3 ||
    request[0] !== RETRY_REQUEST_MARKER ||
    request[1] !== DIRECT_RETRY_TAG ||
    !request[2] ||
    typeof request[2] !== "object" ||
    Array.isArray(request[2])
  ) {
    return undefined;
  }
  const payload = request[2] as { route?: unknown; args?: unknown };
  const route = parseRetryBoundRoute(payload.route);
  if (!route || !payload.args || typeof payload.args !== "object" || Array.isArray(payload.args)) {
    return undefined;
  }
  return { route, args: payload.args as Record<string, unknown> };
}

/** Unwrap catalog / bound-direct envelopes so live args and stored requests compare as one identity. */
export function canonicalizeManualRetryRequest(request: unknown): unknown {
  const bound = boundDirectRetryDetails(request);
  if (bound) {
    return { form: "direct", route: bound.route, args: bound.args };
  }
  const catalog = catalogRetryDetails(request);
  if (catalog) {
    return {
      form: "catalog",
      tool: catalog.toolName,
      args: catalog.args,
      route: catalog.route ?? null,
    };
  }
  return request;
}

function manualRetryIdentityDigest(request: unknown): string {
  return manualRetryArgsDigest(canonicalizeManualRetryRequest(request));
}

function recoverableResult(result: unknown): boolean {
  if (result == null) return false;
  if (typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (record.error != null && record.error !== "") return false;
  }
  return true;
}

function occurrenceIndex(
  effects: readonly ManualRetryChainEffect[],
  tool: string,
  digest: string,
  occurrence: number,
): ManualRetryChainEffect | undefined {
  const matches = effects
    .filter((effect) => {
      if (effect.kind !== tool) return false;
      try {
        return manualRetryIdentityDigest(effect.request) === digest;
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      const leftAt = new Date(left.createdAt).getTime();
      const rightAt = new Date(right.createdAt).getTime();
      if (leftAt !== rightAt) return leftAt - rightAt;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  return matches[occurrence];
}

function decideOne(effect: ManualRetryChainEffect): ManualRetryEffectDecision {
  const decision = effect.reviewDecision;
  if (decision === MANUAL_RETRY_EFFECT_AUTHORIZED) return { kind: "execute" };
  if (decision === MANUAL_RETRY_EFFECT_CANCELLED) {
    return { kind: "skip", reason: "cancelled" };
  }
  if (decision === MANUAL_RETRY_EFFECT_CONFIRMED) {
    if (effect.status === "completed" && recoverableResult(effect.result)) {
      return { kind: "reuse", effect };
    }
    return { kind: "skip", reason: "confirmed_without_result" };
  }
  if (effect.status === "completed" && recoverableResult(effect.result)) {
    return { kind: "reuse", effect };
  }
  if (
    effect.status === "intended" ||
    effect.status === "denied" ||
    effect.status === "cancelled" ||
    effect.status === "approved"
  ) {
    return { kind: "execute" };
  }
  return { kind: "pause", effect };
}

export function decideManualRetryEffect(input: {
  tool: string;
  request: unknown;
  occurrence: number;
  predecessors: ReadonlyArray<{ effects: readonly ManualRetryChainEffect[] }>;
}): ManualRetryEffectDecision {
  let digest: string;
  try {
    digest = manualRetryIdentityDigest(input.request);
  } catch {
    return { kind: "execute" };
  }
  for (const predecessor of input.predecessors) {
    const match = occurrenceIndex(predecessor.effects, input.tool, digest, input.occurrence);
    if (!match) continue;
    return decideOne(match);
  }
  return { kind: "execute" };
}

export function completedOpsForRetryPrompt(
  predecessors: ReadonlyArray<{ effects: readonly ManualRetryChainEffect[] }>,
): Array<{ tool: string; summary: string }> {
  const ops: Array<{ tool: string; summary: string }> = [];
  const seen = new Set<string>();
  for (const predecessor of predecessors) {
    for (const effect of predecessor.effects) {
      if (effect.status !== "completed" || !recoverableResult(effect.result)) continue;
      if (effect.reviewDecision === MANUAL_RETRY_EFFECT_AUTHORIZED) continue;
      if (effect.reviewDecision === MANUAL_RETRY_EFFECT_CANCELLED) continue;
      const key = `${effect.kind}:${effect.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ops.push({
        tool: effect.kind,
        summary: summarizeEffectResult(effect.result),
      });
    }
  }
  return ops.slice(0, 20);
}

function summarizeEffectResult(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 180);
  if (result && typeof result === "object") {
    try {
      return JSON.stringify(result).slice(0, 180);
    } catch {
      return "completed";
    }
  }
  return "completed";
}
