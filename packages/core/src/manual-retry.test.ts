import { describe, expect, it } from "vitest";
import {
  isManualRetryEligibleTrigger,
  isRootRunOrchestration,
  type ManualRetryChainEffect,
  projectManualRetryEligibility,
} from "./manual-retry.js";
import {
  decideManualRetryEffect,
  operationsForRetryPrompt,
  takeRetryOperationId,
} from "./node/manual-retry-match.js";
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
    operationId: overrides.operationId ?? overrides.id,
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

  it("reuses a completed recoverable result when the live call continues that operation id", () => {
    const decision = decideManualRetryEffect({
      tool: "send_email",
      request: args,
      operationId: "op-1",
      predecessors: [
        {
          effects: [
            effect({
              id: "e1",
              operationId: "op-1",
              kind: "send_email",
              status: "completed",
              result: { id: "msg-1" },
            }),
          ],
        },
      ],
    });
    expect(decision).toEqual({
      kind: "reuse",
      effect: expect.objectContaining({ id: "e1" }),
    });
  });

  it("treats a live call without operationId as a new independent operation", () => {
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        request: args,
        predecessors: [
          {
            effects: [
              effect({ id: "e1", operationId: "op-1", kind: "send_email", status: "completed" }),
            ],
          },
        ],
      }),
    ).toEqual({ kind: "execute" });
  });

  it("rejects a foreign operation id without matching another task's effect", () => {
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        request: args,
        operationId: "op-other-task",
        predecessors: [
          {
            effects: [
              effect({ id: "e1", operationId: "op-1", kind: "send_email", status: "completed" }),
            ],
          },
        ],
      }),
    ).toEqual({ kind: "reject", reason: "unknown_operation" });
  });

  it("rejects binding an existing operation id to different args or resource", () => {
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        request: { to: "b@example.com", subject: "hi" },
        operationId: "op-1",
        predecessors: [
          {
            effects: [
              effect({ id: "e1", operationId: "op-1", kind: "send_email", status: "completed" }),
            ],
          },
        ],
      }),
    ).toEqual({ kind: "reject", reason: "bind_mismatch" });
  });

  it("treats denied, intended, and authorized-retry rows as execute of the same operation", () => {
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        request: args,
        operationId: "op-1",
        predecessors: [
          {
            effects: [
              effect({ id: "e1", operationId: "op-1", kind: "send_email", status: "denied" }),
            ],
          },
        ],
      }),
    ).toEqual({ kind: "execute", operationId: "op-1" });
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        request: args,
        operationId: "op-1",
        predecessors: [
          {
            effects: [
              effect({
                id: "e1",
                operationId: "op-1",
                kind: "send_email",
                status: "completed",
                reviewDecision: "manual_retry_authorized",
              }),
            ],
          },
        ],
      }),
    ).toEqual({ kind: "execute", operationId: "op-1" });
  });

  it("pauses uncertain results and skips cancelled or confirmed-without-result", () => {
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        request: args,
        operationId: "op-1",
        predecessors: [
          {
            effects: [
              effect({ id: "e1", operationId: "op-1", kind: "send_email", status: "uncertain" }),
            ],
          },
        ],
      }),
    ).toEqual({ kind: "pause", effect: expect.objectContaining({ id: "e1" }) });
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        request: args,
        operationId: "op-1",
        predecessors: [
          {
            effects: [
              effect({
                id: "e1",
                operationId: "op-1",
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
        request: args,
        operationId: "op-1",
        predecessors: [
          {
            effects: [
              effect({
                id: "e1",
                operationId: "op-1",
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

  it("continues the second same-args operation after skipping the completed first", () => {
    const predecessors = [
      {
        effects: [
          effect({
            id: "e-first",
            operationId: "op-first",
            kind: "send_email",
            status: "completed",
            createdAt: "2026-10-19T00:00:00.000Z",
            result: { id: "first-send" },
          }),
          effect({
            id: "e-second",
            operationId: "op-second",
            kind: "send_email",
            status: "uncertain",
            createdAt: "2026-10-19T00:00:01.000Z",
            result: null,
          }),
        ],
      },
    ];
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        request: args,
        predecessors,
      }).kind,
    ).toBe("execute");
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        request: args,
        operationId: "op-second",
        predecessors,
      }),
    ).toEqual({ kind: "pause", effect: expect.objectContaining({ id: "e-second" }) });
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        request: args,
        operationId: "op-first",
        predecessors,
      }),
    ).toMatchObject({ kind: "reuse", effect: { id: "e-first" } });
  });

  it("associates reversed different operations by id, not call order", () => {
    const mail = { to: "a@example.com", subject: "hi" };
    const later = { to: "b@example.com", subject: "later" };
    const predecessors = [
      {
        effects: [
          effect({
            id: "e-a",
            operationId: "op-a",
            kind: "send_email",
            status: "completed",
            request: mail,
            result: { id: "a" },
            createdAt: "2026-10-19T00:00:00.000Z",
          }),
          effect({
            id: "e-b",
            operationId: "op-b",
            kind: "send_email",
            status: "completed",
            request: later,
            result: { id: "b" },
            createdAt: "2026-10-19T00:00:01.000Z",
          }),
        ],
      },
    ];
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        request: later,
        operationId: "op-b",
        predecessors,
      }),
    ).toMatchObject({ kind: "reuse", effect: { id: "e-b" } });
    expect(
      decideManualRetryEffect({
        tool: "send_email",
        request: mail,
        operationId: "op-a",
        predecessors,
      }),
    ).toMatchObject({ kind: "reuse", effect: { id: "e-a" } });
  });

  it("walks a three-hop chain to the nearest row of the same operation id", () => {
    const decision = decideManualRetryEffect({
      tool: "send_email",
      request: args,
      operationId: "op-1",
      predecessors: [
        {
          effects: [
            effect({
              id: "hop2",
              operationId: "op-1",
              kind: "send_email",
              status: "completed",
              result: { id: "from-hop2" },
              runId: "run-2",
            }),
          ],
        },
        {
          effects: [
            effect({
              id: "hop0",
              operationId: "op-1",
              kind: "send_email",
              status: "uncertain",
              result: null,
              runId: "run-0",
            }),
          ],
        },
      ],
    });
    expect(decision).toMatchObject({ kind: "reuse", effect: { id: "hop2" } });
  });

  it("reuses catalog and bound-direct stored requests against the same live envelope", () => {
    const marker = "__rakazoCatalogTool";
    const hookArgs = { url: "https://example.test/items", body: "hello" };
    const route = { connectorId: "fixture", resourceId: "hook", toolName: "hook_write" };
    const boundRequest = [marker, "direct", { route, args: hookArgs }];
    const catalogArgs = { id: "hook:hook_write", arguments: hookArgs };
    const catalogRequest = [marker, "fixture_execute_tool", catalogArgs, route];

    expect(
      decideManualRetryEffect({
        tool: "hook_write",
        request: boundRequest,
        operationId: "op-bound",
        predecessors: [
          {
            effects: [
              effect({
                id: "bound",
                operationId: "op-bound",
                kind: "hook_write",
                status: "completed",
                request: boundRequest,
                result: { id: "ext-1" },
              }),
            ],
          },
        ],
      }),
    ).toMatchObject({ kind: "reuse", effect: { id: "bound" } });

    expect(
      decideManualRetryEffect({
        tool: "hook_write",
        request: catalogRequest,
        operationId: "op-catalog",
        predecessors: [
          {
            effects: [
              effect({
                id: "catalog",
                operationId: "op-catalog",
                kind: "hook_write",
                status: "completed",
                request: catalogRequest,
                result: { id: "ext-2" },
              }),
            ],
          },
        ],
      }),
    ).toMatchObject({ kind: "reuse", effect: { id: "catalog" } });
  });

  it("treats a different connector resource or args as a new operation when no id is bound", () => {
    const marker = "__rakazoCatalogTool";
    const hookArgs = { url: "https://example.test/items", body: "hello" };
    const route = { connectorId: "fixture", resourceId: "hook", toolName: "hook_write" };
    const stored = [marker, "direct", { route, args: hookArgs }];
    const predecessors = [
      {
        effects: [
          effect({
            id: "bound",
            operationId: "op-bound",
            kind: "hook_write",
            status: "completed",
            request: stored,
            result: { id: "ext-1" },
          }),
        ],
      },
    ];

    expect(
      decideManualRetryEffect({
        tool: "hook_write",
        request: [
          marker,
          "direct",
          {
            route: { ...route, resourceId: "other-hook" },
            args: hookArgs,
          },
        ],
        predecessors,
      }).kind,
    ).toBe("execute");
    expect(
      decideManualRetryEffect({
        tool: "hook_write",
        request: [marker, "direct", { route, args: { ...hookArgs, body: "goodbye" } }],
        operationId: "op-bound",
        predecessors,
      }),
    ).toEqual({ kind: "reject", reason: "bind_mismatch" });
  });

  it("lists each logical operation once with its nearest status for the retry prompt", () => {
    const ops = operationsForRetryPrompt([
      {
        effects: [
          effect({
            id: "keep-hop2",
            operationId: "op-keep",
            kind: "send_email",
            status: "completed",
            result: { id: "from-hop2" },
            runId: "run-2",
          }),
        ],
      },
      {
        effects: [
          effect({
            id: "keep",
            operationId: "op-keep",
            kind: "send_email",
            status: "uncertain",
            result: null,
            createdAt: "2026-10-19T00:00:00.000Z",
          }),
          effect({
            id: "auth",
            operationId: "op-auth",
            kind: "send_email",
            status: "uncertain",
            result: null,
            createdAt: "2026-10-19T00:00:01.000Z",
          }),
        ],
      },
    ]);
    expect(ops).toEqual([
      expect.objectContaining({
        operationId: "op-keep",
        tool: "send_email",
        status: "completed",
        summary: expect.stringContaining("from-hop2"),
      }),
      expect.objectContaining({ operationId: "op-auth", status: "uncertain" }),
    ]);
  });

  it("strips retryOperationId from live args and catalog inner arguments", () => {
    const direct = { url: "https://example.test", retryOperationId: "op-1", body: "x" };
    expect(takeRetryOperationId(direct)).toBe("op-1");
    expect(direct).toEqual({ url: "https://example.test", body: "x" });
    const catalog = { id: "hook:write", arguments: { body: "x", retryOperationId: "op-2" } };
    expect(takeRetryOperationId(catalog)).toBe("op-2");
    expect(catalog).toEqual({ id: "hook:write", arguments: { body: "x" } });
  });
});
