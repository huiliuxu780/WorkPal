import { describe, expect, it } from "vitest";
import {
  isManualRetryEligibleTrigger,
  isRootRunOrchestration,
  type ManualRetryChainEffect,
  projectManualRetryEligibility,
} from "./manual-retry.js";
import { completedOpsForRetryPrompt, decideManualRetryEffect } from "./node/manual-retry-match.js";
import { supportCollaboration, userTurnCollaboration } from "./product-harness/collaboration.js";
import { buildRunOrchestration } from "./product-harness/orchestration.js";

function effect(
  overrides: Partial<ManualRetryChainEffect> &
    Pick<ManualRetryChainEffect, "id" | "kind" | "status">,
): ManualRetryChainEffect {
  return {
    runId: "run-old",
    request: { to: "a@example.com", subject: "hi" },
    result: { ok: true },
    reviewDecision: null,
    createdAt: "2026-10-19T00:00:00.000Z",
    ...overrides,
  };
}

const rootOrchestration = buildRunOrchestration({
  kind: "direct",
  ownerBotId: "bot-1",
  responseMode: "single",
  collaboration: userTurnCollaboration(),
});

describe("manual retry eligibility", () => {
  it("allows failed and cancelled roots with conversational triggers", () => {
    expect(
      projectManualRetryEligibility({
        status: "failed",
        trigger: "user",
        orchestration: rootOrchestration,
      }),
    ).toEqual({ allowed: true });
    expect(
      projectManualRetryEligibility({
        status: "cancelled",
        trigger: "routine",
        orchestration: rootOrchestration,
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses helpers, delivery/created/spawn, and non-terminal rows", () => {
    const helper = buildRunOrchestration({
      kind: "bot_message",
      ownerBotId: "bot-2",
      responseMode: "single",
      ownershipMode: "support",
      collaboration: supportCollaboration({
        fromBotId: "bot-1",
        parentRunId: "run-parent",
        handoffDepth: 0,
        messageHop: 1,
      }),
    });
    expect(
      projectManualRetryEligibility({
        status: "failed",
        trigger: "bot_message",
        orchestration: helper,
      }).reason,
    ).toBe("not_root");
    expect(isRootRunOrchestration(helper)).toBe(false);
    expect(isManualRetryEligibleTrigger("delivery")).toBe(false);
    expect(
      projectManualRetryEligibility({
        status: "failed",
        trigger: "delivery",
        orchestration: rootOrchestration,
      }).reason,
    ).toBe("ineligible_trigger");
    expect(
      projectManualRetryEligibility({
        status: "running",
        trigger: "user",
        orchestration: rootOrchestration,
      }).reason,
    ).toBe("not_terminal");
    expect(
      projectManualRetryEligibility({
        status: "completed",
        trigger: "user",
        orchestration: rootOrchestration,
      }).reason,
    ).toBe("completed");
  });

  it("hides retry when a successor is active or completed", () => {
    expect(
      projectManualRetryEligibility({
        status: "failed",
        trigger: "user",
        orchestration: rootOrchestration,
        successorStatus: "queued",
      }).reason,
    ).toBe("already_active");
    expect(
      projectManualRetryEligibility({
        status: "failed",
        trigger: "user",
        orchestration: rootOrchestration,
        successorStatus: "completed",
      }).reason,
    ).toBe("completed");
    expect(
      projectManualRetryEligibility({
        status: "failed",
        trigger: "user",
        orchestration: rootOrchestration,
        successorStatus: "failed",
      }),
    ).toEqual({ allowed: true });
  });
});

describe("decideManualRetryEffect", () => {
  const args = { to: "a@example.com", subject: "hi" };

  it("reuses a completed recoverable result on the same tool/args/occurrence", () => {
    const decision = decideManualRetryEffect({
      tool: "send_email",
      args,
      occurrence: 0,
      predecessors: [
        {
          effects: [
            effect({ id: "e1", kind: "send_email", status: "completed", result: { id: "msg-1" } }),
          ],
        },
      ],
    });
    expect(decision).toEqual({
      kind: "reuse",
      effect: expect.objectContaining({ id: "e1" }),
    });
  });

  it("does not match a different target, args, or occurrence", () => {
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        args: { to: "b@example.com", subject: "hi" },
        occurrence: 0,
        predecessors: [
          { effects: [effect({ id: "e1", kind: "send_email", status: "completed" })] },
        ],
      }).kind,
    ).toBe("execute");
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        args,
        occurrence: 1,
        predecessors: [
          { effects: [effect({ id: "e1", kind: "send_email", status: "completed" })] },
        ],
      }).kind,
    ).toBe("execute");
  });

  it("treats denied, intended, and authorized-retry rows as new operations", () => {
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        args,
        occurrence: 0,
        predecessors: [{ effects: [effect({ id: "e1", kind: "send_email", status: "denied" })] }],
      }).kind,
    ).toBe("execute");
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        args,
        occurrence: 0,
        predecessors: [
          {
            effects: [
              effect({
                id: "e1",
                kind: "send_email",
                status: "completed",
                reviewDecision: "manual_retry_authorized",
              }),
            ],
          },
        ],
      }).kind,
    ).toBe("execute");
  });

  it("pauses uncertain results and skips cancelled or confirmed-without-result", () => {
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        args,
        occurrence: 0,
        predecessors: [
          { effects: [effect({ id: "e1", kind: "send_email", status: "uncertain" })] },
        ],
      }),
    ).toEqual({ kind: "pause", effect: expect.objectContaining({ id: "e1" }) });
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        args,
        occurrence: 0,
        predecessors: [
          {
            effects: [
              effect({
                id: "e1",
                kind: "send_email",
                status: "uncertain",
                reviewDecision: "manual_retry_cancelled",
              }),
            ],
          },
        ],
      }),
    ).toEqual({ kind: "skip", reason: "cancelled" });
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        args,
        occurrence: 0,
        predecessors: [
          {
            effects: [
              effect({
                id: "e1",
                kind: "send_email",
                status: "uncertain",
                result: null,
                reviewDecision: "manual_retry_confirmed",
              }),
            ],
          },
        ],
      }),
    ).toEqual({ kind: "skip", reason: "confirmed_without_result" });
  });

  it("prefers the nearest predecessor and keeps occurrence order", () => {
    const decision = decideManualRetryEffect({
      tool: "send_email",
      args,
      occurrence: 1,
      predecessors: [
        {
          effects: [
            effect({
              id: "near-0",
              kind: "send_email",
              status: "completed",
              createdAt: "2026-10-19T00:00:00.000Z",
              result: { n: 0 },
            }),
            effect({
              id: "near-1",
              kind: "send_email",
              status: "completed",
              createdAt: "2026-10-19T00:00:01.000Z",
              result: { n: 1 },
            }),
          ],
        },
      ],
    });
    expect(decision).toMatchObject({ kind: "reuse", effect: { id: "near-1" } });
  });

  it("does not list authorized or cancelled ops as completed prompt context", () => {
    const ops = completedOpsForRetryPrompt([
      {
        effects: [
          effect({ id: "keep", kind: "send_email", status: "completed", result: { id: "m1" } }),
          effect({
            id: "auth",
            kind: "send_email",
            status: "completed",
            reviewDecision: "manual_retry_authorized",
          }),
        ],
      },
    ]);
    expect(ops).toEqual([{ tool: "send_email", summary: expect.stringContaining("m1") }]);
  });
});
