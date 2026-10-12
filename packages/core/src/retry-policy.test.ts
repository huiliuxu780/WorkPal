import { describe, expect, it } from "vitest";
import { automaticRetryDelayMs } from "./retry-policy.js";

describe("automatic Run retry policy", () => {
  const safe = {
    reason: "network_error" as const,
    hasCommittedOrUncertainEffect: false,
    hasToolCall: false,
  };

  it("uses 5s then 30s and stops after two retries", () => {
    expect(automaticRetryDelayMs({ ...safe, completedAutoRetries: 0 })).toBe(5_000);
    expect(automaticRetryDelayMs({ ...safe, completedAutoRetries: 1 })).toBe(30_000);
    expect(automaticRetryDelayMs({ ...safe, completedAutoRetries: 2 })).toBeNull();
  });

  it("refuses to replay a possibly irreversible tool effect", () => {
    expect(
      automaticRetryDelayMs({
        ...safe,
        completedAutoRetries: 0,
        hasCommittedOrUncertainEffect: true,
      }),
    ).toBeNull();
    expect(
      automaticRetryDelayMs({ ...safe, completedAutoRetries: 0, hasToolCall: true }),
    ).toBeNull();
  });
});
