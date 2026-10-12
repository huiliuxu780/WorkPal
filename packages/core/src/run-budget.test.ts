import { describe, expect, it } from "vitest";
import { budgetWithOverride, increasedBudgetForViolation, runBudgetForInteraction, runBudgetViolations } from "./run-budget.js";

describe("Run budget", () => {
  it("uses distinct interactive and unattended limits", () => {
    expect(runBudgetForInteraction(true)).toMatchObject({
      maxTokens: 200_000, maxCostUsd: 1, maxDurationSec: 900, maxToolCalls: 50,
      maxChildAgents: 3, maxDepth: 1,
    });
    expect(runBudgetForInteraction(false)).toMatchObject({
      maxTokens: 500_000, maxCostUsd: 3, maxDurationSec: 3_600, maxToolCalls: 150,
    });
  });

  it("reports every exceeded measured dimension without inventing a dollar cost", () => {
    const budget = runBudgetForInteraction(true);
    expect(runBudgetViolations(budget, {
      tokens: 200_001, costUsd: null, durationSec: 901, toolCalls: 51,
    }).map((item) => item.reason)).toEqual(["duration_sec", "tokens", "tool_calls"]);
    expect(runBudgetViolations(budget, {
      tokens: 0, costUsd: 1.01, durationSec: 0, toolCalls: 0,
    })).toEqual([{ reason: "cost_usd", limit: 1, observed: 1.01 }]);
  });

  it("only accepts finite increases and raises the exceeded dimension above observed spend", () => {
    const base = runBudgetForInteraction(true);
    expect(budgetWithOverride(base, { maxTokens: 10, maxCostUsd: Infinity })).toEqual(base);
    expect(increasedBudgetForViolation(base, null, { reason: "tokens", observed: 210_000 })).toMatchObject({
      maxTokens: 420_000, maxToolCalls: 50,
    });
  });
});
