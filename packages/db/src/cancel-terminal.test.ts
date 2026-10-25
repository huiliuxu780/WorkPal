import { describe, expect, it } from "vitest";
import {
  assertCancelVisibleText,
  cancelEventPayload,
  cancelPolicyFor,
  confirmedCancelOutcomeText,
  confirmedDeferredNoticeText,
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

  it("projects only the confirmed outcome and notice sentences", () => {
    expect(confirmedCancelOutcomeText("wait_timeout")).toBe("已取消：等太久了，这项委托没有完成。");
    expect(confirmedCancelOutcomeText("plan_rejected")).toBe(
      "已取消：方案没有被采纳，这项委托已结束。",
    );
    expect(confirmedCancelOutcomeText("budget_cancelled")).toBe(
      "已取消：已超出预算，这项委托已停止。",
    );
    expect(confirmedCancelOutcomeText("budget_narrowed")).toBe(
      "已取消：已超出预算，这项委托已停止。",
    );
    expect(confirmedCancelOutcomeText("teaching_started")).toBe(
      "已取消：对方开始教学，这项委托已停下。",
    );
    expect(confirmedCancelOutcomeText("superseded")).toBe(
      "新的要求已经接上，刚才那条补充也算进去了。",
    );
    expect(confirmedCancelOutcomeText("user_stopped")).toBeNull();
    expect(confirmedCancelOutcomeText("member_removed")).toBeNull();
    expect(confirmedUnhandledNoticeText("member_removed", "小橙")).toBe(
      "未处理：小橙已经不在这个群里。这条消息还在，请重新指定一位成员。",
    );
    expect(confirmedUnhandledNoticeText("group_archived")).toBe(
      "未处理：这个群已归档。这条消息还在，请重新指定一位成员。",
    );
    expect(confirmedUnhandledNoticeText("bot_archived", "小橙")).toBe(
      "未处理：小橙已归档。这条消息还在，请重新指定一位成员。",
    );
    expect(confirmedUnhandledNoticeText("bot_deleted", "小紫")).toBe(
      "未处理：小紫已删除。这条消息还在，请重新指定一位成员。",
    );
    expect(confirmedUnhandledNoticeText("superseded")).toBe(
      "未处理：没有可接替的工作。这条消息还在，请重新指定一位成员。",
    );
    expect(confirmedUnhandledNoticeText("member_removed")).toBe(
      "未处理：该成员已经不在这个群里。这条消息还在，请重新指定一位成员。",
    );
    expect(confirmedUnhandledNoticeText("parent_cancelled")).toBeNull();
    expect(confirmedUnhandledNoticeText("routine_wake")).toBeNull();
    expect(confirmedDeferredNoticeText("小蓝")).toBe(
      "小蓝正在教学。你补充的话会在教学结束后再处理。",
    );
    expect(confirmedDeferredNoticeText()).toBe("该成员正在教学。你补充的话会在教学结束后再处理。");
    expect(reasonsReadyForCancelOutcome()).toEqual([
      "wait_timeout",
      "plan_rejected",
      "budget_cancelled",
      "budget_narrowed",
      "teaching_started",
      "superseded",
    ]);
    expect(() => assertCancelVisibleText("cancelled by lease fence attempt 3")).toThrow(
      /whitelist/,
    );
    expect(() => assertCancelVisibleText("see /Users/rivers/secret.ts:12")).toThrow(/whitelist/);
  });
});
