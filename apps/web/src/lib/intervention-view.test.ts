import type { InterventionView } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  coveredAskMessageIds,
  mergeInterventionViews,
  pendingInterventionKindsForRun,
} from "./intervention-view";

function view(overrides: Partial<InterventionView> = {}): InterventionView {
  return {
    id: "intervention-1",
    revision: 1,
    kind: "input",
    status: "pending",
    spaceId: "space-1",
    threadId: "thread-1",
    runId: "run-1",
    attemptId: "attempt-1",
    botId: "bot-1",
    messageId: "message-1",
    createdAt: "2026-10-12T00:00:00.000Z",
    requestingActor: { botId: "bot-1" },
    input: { mode: "text" },
    ...overrides,
  };
}

describe("intervention view helpers", () => {
  it("keeps a settled card over a stale pending projection", () => {
    const pending = view();
    const settled = view({ revision: 2, status: "answered" });
    expect(mergeInterventionViews([pending], [settled])?.[0]?.status).toBe("answered");
    expect(mergeInterventionViews(undefined, [settled])).toBeUndefined();
  });

  it("prefers the server projection at equal revisions so effect status advances", () => {
    const receipt = view({
      revision: 2,
      status: "answered",
      kind: "approval",
      approval: { effectId: "effect-1", decision: "approved", effectStatus: "approved" },
    });
    const server = view({
      revision: 2,
      status: "answered",
      kind: "approval",
      approval: { effectId: "effect-1", decision: "approved", effectStatus: "completed" },
    });
    expect(mergeInterventionViews([server], [receipt])?.[0]?.approval?.effectStatus).toBe("completed");
    // The receipt still bridges the gap before the server catches up.
    expect(mergeInterventionViews([view()], [receipt])?.[0]?.approval?.effectStatus).toBe("approved");
  });

  it("covers projected asks and leaves legacy bubbles when there is no projection", () => {
    expect(coveredAskMessageIds([view()])).toEqual(new Set(["message-1"]));
    expect(coveredAskMessageIds(undefined).size).toBe(0);
  });

  describe("surface-scoped coverage (UX-01B)", () => {
    it("always covers a pending Intervention's ask", () => {
      const covered = coveredAskMessageIds([view()], {
        eligibleRunIds: new Set<string>(),
        settledAskMessageIds: new Set(["message-1"]),
      });
      expect(covered.has("message-1")).toBe(true);
    });

    it("covers settled cards while their Run keeps an Execution surface", () => {
      const covered = coveredAskMessageIds([view({ status: "answered" })], {
        eligibleRunIds: new Set(["run-1"]),
        settledAskMessageIds: new Set(["message-1"]),
      });
      expect(covered.has("message-1")).toBe(true);
    });

    it("un-covers a settled ask of a surface-less Run once the bubble block is settled", () => {
      // The Run completed without Plan/Steps: no region renders, so the
      // bubble's own answered AskCard stays as the honest history echo.
      const covered = coveredAskMessageIds([view({ status: "answered" })], {
        eligibleRunIds: new Set<string>(),
        settledAskMessageIds: new Set(["message-1"]),
      });
      expect(covered.has("message-1")).toBe(false);
    });

    it("keeps covering a settled view whose bubble block is still pending", () => {
      // A stopped Run's ask block never reached a settled status; uncovering
      // it would show an operable card for a dead Run.
      const covered = coveredAskMessageIds([view({ status: "expired" })], {
        eligibleRunIds: new Set<string>(),
        settledAskMessageIds: new Set<string>(),
      });
      expect(covered.has("message-1")).toBe(true);
    });
  });

  it("reports pending kinds for the header without treating terminal cards as waiting", () => {
    const approval = view({
      id: "approval-1",
      kind: "approval",
      messageId: "message-a",
      input: undefined,
      approval: { effectId: "effect-1", effectStatus: "intended" },
    });
    expect(pendingInterventionKindsForRun([approval, view({ status: "answered" })], "run-1")).toEqual([
      "approval",
    ]);
    expect(pendingInterventionKindsForRun([], "run-1")).toEqual([]);
    expect(pendingInterventionKindsForRun(undefined, "run-1")).toBeUndefined();
  });
});
