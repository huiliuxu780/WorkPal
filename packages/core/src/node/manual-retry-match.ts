import { createHash } from "node:crypto";
import {
  MANUAL_RETRY_EFFECT_AUTHORIZED,
  MANUAL_RETRY_EFFECT_CANCELLED,
  MANUAL_RETRY_EFFECT_CONFIRMED,
} from "@rakazo/contracts";
import { stableJsonValue } from "../approval-effect-key.js";
import type { ManualRetryChainEffect, ManualRetryEffectDecision } from "../manual-retry.js";

export function manualRetryArgsDigest(request: unknown): string {
  return createHash("sha256").update(stableJsonValue(request)).digest("hex");
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
        return manualRetryArgsDigest(effect.request) === digest;
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
  args: Record<string, unknown>;
  occurrence: number;
  predecessors: ReadonlyArray<{ effects: readonly ManualRetryChainEffect[] }>;
}): ManualRetryEffectDecision {
  let digest: string;
  try {
    digest = manualRetryArgsDigest(input.args);
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
