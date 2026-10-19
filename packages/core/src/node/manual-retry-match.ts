import { createHash } from "node:crypto";
import {
  MANUAL_RETRY_EFFECT_AUTHORIZED,
  MANUAL_RETRY_EFFECT_CANCELLED,
  MANUAL_RETRY_EFFECT_CONFIRMED,
} from "@rakazo/contracts";
import { stableJsonValue } from "../approval-effect-key.js";
import {
  type ManualRetryChainEffect,
  type ManualRetryEffectDecision,
  RETRY_OPERATION_ID_KEY,
} from "../manual-retry.js";

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

function logicalOperationId(effect: ManualRetryChainEffect): string {
  return effect.operationId || effect.id;
}

function sameIdentity(effect: ManualRetryChainEffect, tool: string, request: unknown): boolean {
  if (effect.kind !== tool) return false;
  try {
    return manualRetryIdentityDigest(effect.request) === manualRetryIdentityDigest(request);
  } catch {
    return false;
  }
}

function byCreatedThenId(left: ManualRetryChainEffect, right: ManualRetryChainEffect): number {
  const leftAt = new Date(left.createdAt).getTime();
  const rightAt = new Date(right.createdAt).getTime();
  if (leftAt !== rightAt) return leftAt - rightAt;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function findByOperationId(
  predecessors: ReadonlyArray<{ effects: readonly ManualRetryChainEffect[] }>,
  operationId: string,
): ManualRetryChainEffect | undefined {
  for (const predecessor of predecessors) {
    const matches = predecessor.effects.filter(
      (effect) => logicalOperationId(effect) === operationId,
    );
    if (matches.length === 0) continue;
    return [...matches].sort(byCreatedThenId)[matches.length - 1];
  }
  return undefined;
}

/**
 * Same-run follow-up of a continued operation. Completed or in-flight rows
 * must not send again. Intended/approved rows still need the live execute
 * path (approval claim). Returns null to fall through to predecessor hops.
 */
function decideCurrentRunOperation(
  effect: ManualRetryChainEffect,
): ManualRetryEffectDecision | null {
  if (effect.status === "completed" && recoverableResult(effect.result)) {
    return { kind: "reuse", effect };
  }
  if (effect.status === "executing") {
    return recoverableResult(effect.result)
      ? { kind: "reuse", effect }
      : { kind: "skip", reason: "confirmed_without_result" };
  }
  if (
    effect.status === "uncertain" ||
    effect.status === "failed" ||
    effect.status === "ambiguous" ||
    (effect.status === "completed" && !recoverableResult(effect.result))
  ) {
    return { kind: "pause", effect };
  }
  return null;
}

function decideOne(effect: ManualRetryChainEffect): ManualRetryEffectDecision {
  const decision = effect.reviewDecision;
  if (decision === MANUAL_RETRY_EFFECT_AUTHORIZED) {
    return { kind: "execute", operationId: logicalOperationId(effect) };
  }
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
    return { kind: "execute", operationId: logicalOperationId(effect) };
  }
  return { kind: "pause", effect };
}

export function decideManualRetryEffect(input: {
  tool: string;
  request: unknown;
  operationId?: string | null;
  predecessors: ReadonlyArray<{ effects: readonly ManualRetryChainEffect[] }>;
  current?: readonly ManualRetryChainEffect[];
}): ManualRetryEffectDecision {
  const operationId = input.operationId?.trim();
  if (!operationId) return { kind: "execute" };
  const currentMatch = findByOperationId([{ effects: input.current ?? [] }], operationId);
  if (currentMatch) {
    if (!sameIdentity(currentMatch, input.tool, input.request)) {
      return { kind: "reject", reason: "bind_mismatch" };
    }
    const currentDecision = decideCurrentRunOperation(currentMatch);
    if (currentDecision) return currentDecision;
  }
  const match = findByOperationId(input.predecessors, operationId);
  if (!match) return { kind: "reject", reason: "unknown_operation" };
  if (!sameIdentity(match, input.tool, input.request)) {
    return { kind: "reject", reason: "bind_mismatch" };
  }
  return decideOne(match);
}

export type ManualRetryPromptOp = {
  operationId: string;
  tool: string;
  status: string;
  summary: string;
};

export function operationsForRetryPrompt(
  predecessors: ReadonlyArray<{ effects: readonly ManualRetryChainEffect[] }>,
): ManualRetryPromptOp[] {
  const nearest = new Map<string, ManualRetryChainEffect>();
  for (const predecessor of predecessors) {
    for (const effect of [...predecessor.effects].sort(byCreatedThenId)) {
      const operationId = logicalOperationId(effect);
      if (!nearest.has(operationId)) nearest.set(operationId, effect);
    }
  }
  const ops: ManualRetryPromptOp[] = [];
  const seen = new Set<string>();
  for (const predecessor of [...predecessors].reverse()) {
    for (const effect of [...predecessor.effects].sort(byCreatedThenId)) {
      const operationId = logicalOperationId(effect);
      if (seen.has(operationId)) continue;
      seen.add(operationId);
      const row = nearest.get(operationId)!;
      ops.push({
        operationId,
        tool: row.kind,
        status: row.status,
        summary: summarizeEffectResult(row.result),
      });
    }
  }
  return ops.slice(0, 40);
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

function readOperationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id || id.length > 128) return undefined;
  return id;
}

/**
 * Pull the reserved retry operation id off live tool args (and catalog inner
 * arguments). Mutates `args` so the field never reaches persist/send/hash.
 */
export function takeRetryOperationId(args: Record<string, unknown>): string | undefined {
  const direct = readOperationId(args[RETRY_OPERATION_ID_KEY]);
  if (direct) {
    delete args[RETRY_OPERATION_ID_KEY];
    return direct;
  }
  const inner = args.arguments;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const nested = inner as Record<string, unknown>;
    const fromInner = readOperationId(nested[RETRY_OPERATION_ID_KEY]);
    if (fromInner) {
      delete nested[RETRY_OPERATION_ID_KEY];
      return fromInner;
    }
  }
  return undefined;
}
