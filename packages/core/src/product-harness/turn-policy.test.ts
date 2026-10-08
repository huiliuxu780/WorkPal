import { describe, expect, it } from "vitest";
import { buildRunOrchestration, parseRunOrchestration } from "./orchestration.js";
import {
  DEFAULT_DELEGATION_MAX_CHILDREN,
  DEFAULT_DELEGATION_MAX_DEPTH,
  orchestrationExecution,
  resolveTurnPolicy,
  turnPolicyFromRun,
  turnPolicySourceForTrigger,
} from "./turn-policy.js";

describe("turnPolicySourceForTrigger", () => {
  it("maps user turns to chat and internal wakes to support sources", () => {
    expect(turnPolicySourceForTrigger("user")).toBe("chat");
    expect(turnPolicySourceForTrigger("follow_up")).toBe("chat");
    expect(turnPolicySourceForTrigger("reaction")).toBe("chat");
    expect(turnPolicySourceForTrigger("bot_message")).toBe("bot_message");
    expect(turnPolicySourceForTrigger("handoff")).toBe("handoff");
    for (const trigger of [
      "routine",
      "webhook",
      "messaging",
      "created",
      "call_end",
      "skill",
      "cloud_agent",
      "spawn",
    ]) {
      expect(turnPolicySourceForTrigger(trigger)).toBe("automation");
    }
    expect(turnPolicySourceForTrigger("something-new")).toBe("chat");
  });
});

describe("resolveTurnPolicy", () => {
  it("gives an ordinary chat owner the full automatic policy", () => {
    expect(
      resolveTurnPolicy({ source: "chat", ownerBotId: "alice", routingKind: "group_router" }),
    ).toEqual({
      version: "v1",
      interaction: { interactive: true },
      planning: { mode: "auto" },
      delegation: {
        mode: "auto",
        background: true,
        maxChildren: DEFAULT_DELEGATION_MAX_CHILDREN,
        maxDepth: DEFAULT_DELEGATION_MAX_DEPTH,
      },
      ownership: { mode: "owner", ownerBotId: "alice" },
      routing: { kind: "group_router" },
    });
  });

  it("never lets bot_message cooperation stall on plan approval or backgrounds", () => {
    const policy = resolveTurnPolicy({ source: "bot_message", ownerBotId: "bob" });
    expect(policy.interaction.interactive).toBe(false);
    expect(policy.planning.mode).toBe("disabled");
    expect(policy.delegation.mode).toBe("auto");
    expect(policy.delegation.background).toBe(false);
    expect(policy.ownership.mode).toBe("support");
  });

  it("hands off with full owner capability", () => {
    const policy = resolveTurnPolicy({ source: "handoff", ownerBotId: "bob" });
    expect(policy.interaction.interactive).toBe(true);
    expect(policy.planning.mode).toBe("auto");
    expect(policy.ownership.mode).toBe("owner");
    expect(policy.routing.kind).toBe("handoff");
  });

  it("disables planning for automation while keeping background helpers", () => {
    const policy = resolveTurnPolicy({ source: "automation", ownerBotId: "ops" });
    expect(policy.interaction.interactive).toBe(false);
    expect(policy.planning.mode).toBe("disabled");
    expect(policy.delegation.background).toBe(true);
    expect(policy.delegation.mode).toBe("auto");
  });
});

describe("orchestration execution snapshot", () => {
  it("round-trips the execution block through the v1 snapshot", () => {
    const policy = resolveTurnPolicy({ source: "automation", ownerBotId: "ops" });
    const snapshot = buildRunOrchestration({
      kind: "automation",
      ownerBotId: "ops",
      responseMode: "single",
      execution: orchestrationExecution(policy),
    });
    const parsed = parseRunOrchestration(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed?.execution).toEqual({
      interactive: false,
      planning: "disabled",
      delegation: { mode: "auto", background: true, maxChildren: 3, maxDepth: 1 },
    });
  });

  it("drops a malformed execution block but keeps the ownership decision", () => {
    const parsed = parseRunOrchestration({
      version: "v1",
      routing: { kind: "direct" },
      ownership: { mode: "owner", ownerBotId: "alice" },
      responseMode: "single",
      execution: { interactive: "yes", planning: "auto" },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.execution).toBeUndefined();
    expect(parsed?.ownership.ownerBotId).toBe("alice");
  });
});

describe("turnPolicyFromRun", () => {
  it("reuses the persisted policy — a retry never recomputes", () => {
    const stored = buildRunOrchestration({
      kind: "group_router",
      ownerBotId: "coding",
      responseMode: "single",
      reasonCode: "specialist_match",
      execution: {
        interactive: true,
        planning: "disabled",
        delegation: { mode: "auto", background: false, maxChildren: 1, maxDepth: 1 },
      },
    });
    const policy = turnPolicyFromRun({ trigger: "user", ownerBotId: "other", orchestration: stored });
    // Even though the trigger says "user", the snapshot wins verbatim.
    expect(policy.planning.mode).toBe("disabled");
    expect(policy.delegation.background).toBe(false);
    expect(policy.delegation.maxChildren).toBe(1);
    expect(policy.ownership.ownerBotId).toBe("coding");
    expect(policy.routing.kind).toBe("group_router");
  });

  it("pins ownership and routing from a Phase 1 snapshot without an execution block", () => {
    const stored = buildRunOrchestration({
      kind: "fallback_lead",
      ownerBotId: "finance",
      responseMode: "single",
      reasonCode: "fallback_lead",
    });
    const policy = turnPolicyFromRun({ trigger: "user", ownerBotId: "x", orchestration: stored });
    expect(policy.planning.mode).toBe("auto");
    expect(policy.ownership.ownerBotId).toBe("finance");
    expect(policy.routing.kind).toBe("fallback_lead");
  });

  it("derives the policy from the trigger for legacy rows without a snapshot", () => {
    const policy = turnPolicyFromRun({ trigger: "bot_message", ownerBotId: "bob", orchestration: null });
    expect(policy.planning.mode).toBe("disabled");
    expect(policy.ownership.mode).toBe("support");
    const routine = turnPolicyFromRun({ trigger: "routine", ownerBotId: "ops", orchestration: null });
    expect(routing(routine)).toBe("automation");
    const legacy = turnPolicyFromRun({ trigger: "user", ownerBotId: "alice", orchestration: { junk: 1 } });
    expect(routing(legacy)).toBe("direct");
  });
});

function routing(policy: { routing: { kind: string } }): string {
  return policy.routing.kind;
}
