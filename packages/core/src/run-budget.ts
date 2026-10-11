export type RunBudget = {
  maxTokens: number;
  maxCostUsd: number;
  maxDurationSec: number;
  maxToolCalls: number;
  maxChildAgents: number;
  maxDepth: number;
};

export type RunBudgetUsage = {
  tokens: number;
  /** Null means the model has no trusted price source. */
  costUsd: number | null;
  durationSec: number;
  toolCalls: number;
};

export type RunBudgetLimit = "tokens" | "cost_usd" | "duration_sec" | "tool_calls";

export const BUDGET_ACTIONS = [
  { id: "increase_budget", label: "Increase the budget and continue" },
  { id: "narrow_scope", label: "Stop and send a narrower request" },
  { id: "cancel_run", label: "Cancel this run" },
] as const;

export function budgetAskCheckpoint(violation: { reason: RunBudgetLimit; observed: number }) {
  return JSON.stringify({ kind: "budget_ask_v1", ...violation });
}

export function parseBudgetAskCheckpoint(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.kind !== "budget_ask_v1") return null;
    if (!["tokens", "cost_usd", "duration_sec", "tool_calls"].includes(String(parsed.reason))) return null;
    if (typeof parsed.observed !== "number" || !Number.isFinite(parsed.observed) || parsed.observed < 0) return null;
    return { reason: parsed.reason as RunBudgetLimit, observed: parsed.observed };
  } catch {
    return null;
  }
}

export const INTERACTIVE_RUN_BUDGET: Readonly<RunBudget> = {
  maxTokens: 200_000,
  maxCostUsd: 1,
  maxDurationSec: 900,
  maxToolCalls: 50,
  maxChildAgents: 3,
  maxDepth: 1,
};

export const UNATTENDED_RUN_BUDGET: Readonly<RunBudget> = {
  maxTokens: 500_000,
  maxCostUsd: 3,
  maxDurationSec: 3_600,
  maxToolCalls: 150,
  maxChildAgents: 3,
  maxDepth: 1,
};

export function runBudgetForInteraction(interactive: boolean): RunBudget {
  return { ...(interactive ? INTERACTIVE_RUN_BUDGET : UNATTENDED_RUN_BUDGET) };
}

export function budgetWithOverride(base: RunBudget, override: unknown): RunBudget {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const raw = override as Record<string, unknown>;
  const budget = { ...base };
  for (const key of ["maxTokens", "maxCostUsd", "maxDurationSec", "maxToolCalls"] as const) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= base[key]) budget[key] = value;
  }
  return budget;
}

export function increasedBudgetForViolation(
  base: RunBudget,
  override: unknown,
  violation: { reason: RunBudgetLimit; observed: number },
): RunBudget {
  const current = budgetWithOverride(base, override);
  const key = {
    tokens: "maxTokens",
    cost_usd: "maxCostUsd",
    duration_sec: "maxDurationSec",
    tool_calls: "maxToolCalls",
  }[violation.reason] as "maxTokens" | "maxCostUsd" | "maxDurationSec" | "maxToolCalls";
  current[key] = Math.max(current[key] * 2, violation.observed * 2);
  return current;
}

export function runBudgetViolations(budget: RunBudget, usage: RunBudgetUsage) {
  const exceeded: Array<{ reason: RunBudgetLimit; limit: number; observed: number }> = [];
  if (usage.durationSec > budget.maxDurationSec) {
    exceeded.push({ reason: "duration_sec", limit: budget.maxDurationSec, observed: usage.durationSec });
  }
  if (usage.tokens > budget.maxTokens) {
    exceeded.push({ reason: "tokens", limit: budget.maxTokens, observed: usage.tokens });
  }
  if (usage.costUsd !== null && usage.costUsd > budget.maxCostUsd) {
    exceeded.push({ reason: "cost_usd", limit: budget.maxCostUsd, observed: usage.costUsd });
  }
  if (usage.toolCalls > budget.maxToolCalls) {
    exceeded.push({ reason: "tool_calls", limit: budget.maxToolCalls, observed: usage.toolCalls });
  }
  return exceeded;
}
