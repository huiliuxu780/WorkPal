import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));

import { manualRetryErrorMessage } from "./manual-retry";

describe("manualRetryErrorMessage", () => {
  it("maps business reasons from the ORPC data payload", () => {
    expect(manualRetryErrorMessage({ data: { reason: "thread_busy" } })).toBe(
      "This conversation already has work in progress.",
    );
    expect(manualRetryErrorMessage({ data: { reason: "thread_cleared" } })).toBe(
      "This task is no longer available.",
    );
    expect(manualRetryErrorMessage({ data: { data: { reason: "completed" } } })).toBe(
      "This task already completed.",
    );
    expect(manualRetryErrorMessage({ data: { reason: "not_root" } })).toBe(
      "This run cannot be retried.",
    );
    expect(manualRetryErrorMessage({ data: { reason: "nonce_conflict" } })).toBe(
      "This retry request was already used for a different task.",
    );
    expect(manualRetryErrorMessage(new Error("network"))).toBe(
      "Couldn't retry this task. Try again.",
    );
  });
});
