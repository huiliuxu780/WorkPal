import {
  parseRunOrchestration,
  type OrchestrationExecutionV1,
} from "./orchestration.js";
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

export type TurnPolicy = {
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
      return {
        version: "v1",
        interaction: { interactive: false },
        planning: { mode: "disabled" },
        delegation: { ...delegation, background: false },
        ownership: { mode: "support", ownerBotId: input.ownerBotId },
        routing: { kind: input.routingKind ?? "bot_message" },
      };
    case "handoff":
      // The target bot is the new response owner of this stage.
      return {
        version: "v1",
        interaction: { interactive: true },
        planning: { mode: "auto" },
        delegation,
        ownership: { mode: "owner", ownerBotId: input.ownerBotId },
        routing: { kind: input.routingKind ?? "handoff" },
      };
    case "automation":
      // No human in the loop: dangerous side effects are still gated by Tool
      // Approval — planning approval would strand the run.
      return {
        version: "v1",
        interaction: { interactive: false },
        planning: { mode: "disabled" },
        delegation,
        ownership: { mode: "owner", ownerBotId: input.ownerBotId },
        routing: { kind: input.routingKind ?? "automation" },
      };
    case "chat":
      return {
        version: "v1",
        interaction: { interactive: true },
        planning: { mode: "auto" },
        delegation,
        ownership: { mode: "owner", ownerBotId: input.ownerBotId },
        routing: { kind: input.routingKind ?? "direct" },
      };
  }
}

export function orchestrationExecution(policy: TurnPolicy): OrchestrationExecutionV1 {
  return {
    interactive: policy.interaction.interactive,
    planning: policy.planning.mode,
    delegation: { ...policy.delegation },
  };
}

/**
 * The execution block a Run snapshot stores for one policy source. Ownership
 * and routing are not part of the execution block, so the owner id is a
 * placeholder here — snapshots carry the real values in their own fields.
 */
export function turnExecutionForSource(source: TurnPolicySource): OrchestrationExecutionV1 {
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
}): TurnPolicy {
  const snapshot = parseRunOrchestration(input.orchestration);
  if (snapshot?.execution) {
    return {
      version: "v1",
      interaction: { interactive: snapshot.execution.interactive },
      planning: { mode: snapshot.execution.planning },
      delegation: { ...snapshot.execution.delegation },
      ownership: { mode: snapshot.ownership.mode, ownerBotId: snapshot.ownership.ownerBotId },
      routing: { kind: snapshot.routing.kind },
    };
  }
  const base = resolveTurnPolicy({
    source: turnPolicySourceForTrigger(input.trigger),
    ownerBotId: input.ownerBotId,
  });
  if (snapshot) {
    // A pre-Phase-2 snapshot still pins ownership and routing exactly.
    return {
      ...base,
      ownership: { mode: snapshot.ownership.mode, ownerBotId: snapshot.ownership.ownerBotId },
      routing: { kind: snapshot.routing.kind },
    };
  }
  return base;
}
