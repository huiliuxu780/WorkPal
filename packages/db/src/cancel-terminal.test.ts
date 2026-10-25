import { describe, expect, it } from "vitest";
import {
  assertCancelVisibleText,
  cancelEventPayload,
  cancelPolicyFor,
  confirmedCancelOutcomeText,
  confirmedUnhandledNoticeText,
  reasonsReadyForCancelOutcome,
  supersededCancelPolicy,
} from "./cancel-terminal.js";

describe("cancel terminal policy", () => {
  it("gives every fixed reason an explicit outcome and steering choice", () => {
    expect(cancelPolicyFor("user_stopped")).toEqual({
      reason: "user_stopped",
      reportDelegationOutcome: false,
      steering: "delete",
    });
    for (const reason of [
      "wait_timeout",
      "plan_rejected",
      "budget_cancelled",
      "budget_narrowed",
    ] as const) {
      expect(cancelPolicyFor(reason).steering).toBe("release_and_continue");
      expect(cancelPolicyFor(reason).reportDelegationOutcome).toBe(true);
    }
    expect(cancelPolicyFor("teaching_started").steering).toBe("release_and_continue");
    for (const reason of [
      "member_removed",
      "group_archived",
      "bot_archived",
      "bot_deleted",
    ] as const) {
      expect(cancelPolicyFor(reason)).toMatchObject({
        reportDelegationOutcome: true,
        steering: "retain_unhandled",
      });
    }
    expect(cancelPolicyFor("thread_cleared").steering).toBe("delete");
    expect(cancelPolicyFor("routine_wake").steering).toBe("retain_unhandled");
    expect(cancelPolicyFor("parent_cancelled").steering).toBe("retain_unhandled");
  });

  it("requires an explicit superseded choice", () => {
    expect(supersededCancelPolicy({ disposition: "retain_unhandled" }).steering).toBe(
      "retain_unhandled",
    );
    expect(
      supersededCancelPolicy({ disposition: "migrate", replacementRunId: "run-next" }),
    ).toMatchObject({ steering: "migrate", replacementRunId: "run-next" });
    expect(cancelEventPayload(cancelPolicyFor("wait_timeout")).reason).toBe("wait_timeout");
  });

  it("does not project unconfirmed sentences or secret-bearing text", () => {
    expect(confirmedCancelOutcomeText("wait_timeout")).toBeNull();
    expect(confirmedCancelOutcomeText("user_stopped")).toBeNull();
    expect(confirmedUnhandledNoticeText("member_removed")).toBeNull();
    expect(reasonsReadyForCancelOutcome()).toEqual([]);
    expect(() => assertCancelVisibleText("cancelled by lease fence attempt 3")).toThrow(
      /whitelist/,
    );
    expect(() => assertCancelVisibleText("see /Users/rivers/secret.ts:12")).toThrow(/whitelist/);
  });
});
