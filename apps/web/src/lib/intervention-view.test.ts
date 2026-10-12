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

  it("covers projected asks and leaves legacy bubbles when there is no projection", () => {
    expect(coveredAskMessageIds([view()])).toEqual(new Set(["message-1"]));
    expect(coveredAskMessageIds(undefined).size).toBe(0);
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
