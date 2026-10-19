import { describe, expect, it } from "vitest";
import {
  ManualRetryDenyReason,
  ManualRetryInputSchema,
  ManualRetryOutputSchema,
} from "./manual-retry.js";

describe("manual retry contract", () => {
  it("accepts a retry request and a created-run response", () => {
    expect(ManualRetryInputSchema.parse({ runId: "run-1", clientNonce: "nonce-1" })).toEqual({
      runId: "run-1",
      clientNonce: "nonce-1",
    });
    expect(
      ManualRetryOutputSchema.parse({
        sourceRunId: "run-1",
        runId: "run-2",
        taskId: "task-1",
        threadId: "thread-1",
        botId: "bot-1",
        replayed: false,
        target: { kind: "bot", botId: "bot-1" },
      }).replayed,
    ).toBe(false);
  });

  it("lists the closed deny-reason set", () => {
    expect(ManualRetryDenyReason.options).toContain("thread_cleared");
    expect(ManualRetryDenyReason.options).toContain("thread_busy");
    expect(ManualRetryInputSchema.safeParse({ runId: "run-1", clientNonce: "" }).success).toBe(
      false,
    );
  });
});
