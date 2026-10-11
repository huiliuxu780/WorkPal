import { budgetWithOverride, runBudgetForInteraction, type RunBudget } from "../run-budget.js";
import { RUN_RETRY_DELAYS_MS, type AutomaticRetryReason } from "../retry-policy.js";
import { type OrchestrationExecutionV2, parseRunOrchestration } from "./orchestration.js";
import type { TurnRouteKind } from "./response-owner.js";

/**
 * Product Harness Phase 2 — Turn Policy.
 *
 * The internal execution policy for one Run: what the owning Agent is allowed
 * to do this turn (plan / delegate / background / support identity). It is
 * derived from deterministic product context — the Run's trigger and its
 * immutable orchestration snapshot — never from an extra model call, and it
 * is never user-selectable. The AgentScope Java runtime executes within it;
 * the Agent still decides *whether* to plan or delegate inside what is
 * allowed.
 */

export type TurnPlanningMode = "disabled" | "auto";
export type TurnDelegationMode = "disabled" | "auto";

export type TurnPolicyRoutingKind = TurnRouteKind;

export type TurnPolicyV1 = {
  version: "v1";
  interaction: { interactive: boolean };
  planning: { mode: TurnPlanningMode };
  delegation: {
    mode: TurnDelegationMode;
    background: boolean;
    maxChildren: number;
    maxDepth: number;
  };
  ownership: { mode: "owner" | "support"; ownerBotId: string };
  routing: { kind: TurnPolicyRoutingKind };
};

export type TurnPolicy = Omit<TurnPolicyV1, "version"> & {
  version: "v2";
  budget: RunBudget;
  approval: { timeoutSec: number; onTimeout: "expire" };
  retry: { maxAuto: number; retryable: AutomaticRetryReason[] };
  subagent: { permissionInheritance: "subset-readonly" };
};

export const DEFAULT_APPROVAL_TIMEOUT_SEC = 86_400;
export const DEFAULT_RETRYABLE_REASONS: readonly AutomaticRetryReason[] = [
  "llm_timeout", "network_error", "provider_5xx", "lease_lost",
];

function upgradeTurnPolicy(
  legacy: TurnPolicyV1,
  stored?: Pick<TurnPolicy, "budget" | "approval" | "retry" | "subagent">,
  budgetOverride?: unknown,
): TurnPolicy {
  const budget = stored?.budget ?? runBudgetForInteraction(legacy.interaction.interactive);
  return {
    ...legacy,
    version: "v2",
    budget: {
      ...budgetWithOverride(budget, budgetOverride),
      maxChildAgents: Math.min(budget.maxChildAgents, legacy.delegation.maxChildren),
      maxDepth: Math.min(budget.maxDepth, legacy.delegation.maxDepth),
    },
    approval: stored?.approval ?? { timeoutSec: DEFAULT_APPROVAL_TIMEOUT_SEC, onTimeout: "expire" },
    retry: stored?.retry ?? {
      maxAuto: RUN_RETRY_DELAYS_MS.length,
      retryable: [...DEFAULT_RETRYABLE_REASONS],
    },
    subagent: stored?.subagent ?? { permissionInheritance: "subset-readonly" },
  };
}

/** v1 budgets (Product Harness §5/§11): flat helper fan-out, no agent trees. */
export const DEFAULT_DELEGATION_MAX_CHILDREN = 3;
export const DEFAULT_DELEGATION_MAX_DEPTH = 1;

export type TurnPolicySource = "chat" | "bot_message" | "handoff" | "automation";

/**
 * Run triggers whose work must never stall waiting for interactive approval:
 * scheduled, inbound, ambient, intro, post-call continuation, cloud-agent
 * notification and spawned-child runs. (`resume` never appears on a created
 * Run row — resumed Runs keep their original trigger.)
 */
const AUTOMATION_TRIGGERS = new Set([
  "routine",
  "webhook",
  "messaging",
  "created",
  "call_end",
  "skill",
  "cloud_agent",
  "spawn",
  "delivery",
]);

export function turnPolicySourceForTrigger(trigger: string): TurnPolicySource {
  if (trigger === "bot_message") return "bot_message";
  if (trigger === "handoff") return "handoff";
  if (AUTOMATION_TRIGGERS.has(trigger)) return "automation";
  return "chat";
}

export function resolveTurnPolicy(input: {
  source: TurnPolicySource;
  ownerBotId: string;
  routingKind?: TurnPolicyRoutingKind;
}): TurnPolicy {
  const delegation = {
    mode: "auto" as TurnDelegationMode,
    background: true,
    maxChildren: DEFAULT_DELEGATION_MAX_CHILDREN,
    maxDepth: DEFAULT_DELEGATION_MAX_DEPTH,
  };
  switch (input.source) {
    case "bot_message":
      // Internal cooperation must never block on plan approval: a delegated
      // sub-task answers the requesting agent, not the user.
      return upgradeTurnPolicy({
        version: "v1",
        interaction: { interactive: false },
        planning: { mode: "disabled" },
        delegation: { ...delegation, background: false },
        ownership: { mode: "support", ownerBotId: input.ownerBotId },
        routing: { kind: input.routingKind ?? "bot_message" },
      });
    case "handoff":
      // The target bot is the new response owner of this stage.
      return upgradeTurnPolicy({
        version: "v1",
        interaction: { interactive: true },
        planning: { mode: "auto" },
        delegation,
        ownership: { mode: "owner", ownerBotId: input.ownerBotId },
        routing: { kind: input.routingKind ?? "handoff" },
      });
    case "automation":
      // No human in the loop: dangerous side effects are still gated by Tool
      // Approval — planning approval would strand the run.
      return upgradeTurnPolicy({
        version: "v1",
        interaction: { interactive: false },
        planning: { mode: "disabled" },
        delegation,
        ownership: { mode: "owner", ownerBotId: input.ownerBotId },
        routing: { kind: input.routingKind ?? "automation" },
      });
    case "chat":
      return upgradeTurnPolicy({
        version: "v1",
        interaction: { interactive: true },
        planning: { mode: "auto" },
        delegation,
        ownership: { mode: "owner", ownerBotId: input.ownerBotId },
        routing: { kind: input.routingKind ?? "direct" },
      });
  }
}

export function orchestrationExecution(policy: TurnPolicy): OrchestrationExecutionV2 {
  return {
    version: "v2",
    interactive: policy.interaction.interactive,
    planning: policy.planning.mode,
    delegation: { ...policy.delegation },
    budget: { ...policy.budget },
    approval: { ...policy.approval },
    retry: { maxAuto: policy.retry.maxAuto, retryable: [...policy.retry.retryable] },
    subagent: { ...policy.subagent },
  };
}

/**
 * The execution block a Run snapshot stores for one policy source. Ownership
 * and routing are not part of the execution block, so the owner id is a
 * placeholder here — snapshots carry the real values in their own fields.
 */
export function turnExecutionForSource(source: TurnPolicySource): OrchestrationExecutionV2 {
  return orchestrationExecution(resolveTurnPolicy({ source, ownerBotId: "turn-owner" }));
}

/**
 * The policy a runtime request must carry for one Run: the immutable snapshot
 * when the Run has one (a retry never recomputes), otherwise the deterministic
 * fallback derived from the Run's trigger. Runs without routing information
 * (legacy rows and pre-Phase-1 triggers) keep behaving as chat turns.
 */
export function turnPolicyFromRun(input: {
  trigger: string;
  ownerBotId: string;
  orchestration: unknown;
  budgetOverride?: unknown;
}): TurnPolicy {
  if (input.trigger === "delivery") {
    const policy = resolveTurnPolicy({ source: "automation", ownerBotId: input.ownerBotId });
    return upgradeTurnPolicy({
      ...policy,
      version: "v1",
      delegation: { mode: "disabled", background: false, maxChildren: 0, maxDepth: 0 },
    }, undefined, input.budgetOverride);
  }
  const snapshot = parseRunOrchestration(input.orchestration);
  const rawExecution = input.orchestration && typeof input.orchestration === "object"
    ? (input.orchestration as { execution?: unknown }).execution
    : undefined;
  if (rawExecution && typeof rawExecution === "object" &&
      (rawExecution as { version?: unknown }).version === "v2" && !snapshot?.execution) {
    // A corrupt v2 constraint block must not silently regain planning or helper access.
    return upgradeTurnPolicy({
      version: "v1",
      interaction: { interactive: false },
      planning: { mode: "disabled" },
      delegation: { mode: "disabled", background: false, maxChildren: 0, maxDepth: 0 },
      ownership: snapshot
        ? { mode: snapshot.ownership.mode, ownerBotId: snapshot.ownership.ownerBotId }
        : { mode: "owner", ownerBotId: input.ownerBotId },
      routing: { kind: snapshot?.routing.kind ?? "direct" },
    }, undefined, input.budgetOverride);
  }
  if (snapshot?.execution) {
    const execution = snapshot.execution;
    return upgradeTurnPolicy({
      version: "v1",
      interaction: { interactive: execution.interactive },
      planning: { mode: execution.planning },
      delegation: { ...execution.delegation },
      ownership: { mode: snapshot.ownership.mode, ownerBotId: snapshot.ownership.ownerBotId },
      routing: { kind: snapshot.routing.kind },
    }, "version" in execution && execution.version === "v2" ? execution : undefined, input.budgetOverride);
  }
  const base = resolveTurnPolicy({
    source: turnPolicySourceForTrigger(input.trigger),
    ownerBotId: input.ownerBotId,
  });
  if (snapshot) {
    // A pre-Phase-2 snapshot still pins ownership and routing exactly.
    const pinned = {
      ...base,
      ownership: { mode: snapshot.ownership.mode, ownerBotId: snapshot.ownership.ownerBotId },
      routing: { kind: snapshot.routing.kind },
    };
    return input.budgetOverride
      ? upgradeTurnPolicy({ ...pinned, version: "v1" }, undefined, input.budgetOverride)
      : pinned;
  }
  return input.budgetOverride ? upgradeTurnPolicy({ ...base, version: "v1" }, undefined, input.budgetOverride) : base;
}
