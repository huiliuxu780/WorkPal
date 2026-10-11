import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + String(values[i] ?? ""), ""),
}));

import type { RunStepSnapshot } from "@rakazo/contracts";
import { RunStepsDisclosure } from "./RunStepsDisclosure";

function step(status: RunStepSnapshot["status"]): RunStepSnapshot {
  return {
    stepId: "review",
    runId: "run-1",
    sourceMessageId: "message-1",
    revision: 1,
    order: 0,
    title: "Review source",
    status,
    resultSummary: null,
    planItemId: null,
    parentStepId: null,
    attemptId: "attempt-1",
    attemptNumber: 1,
    startedAt: "2026-08-16T00:00:00.000Z",
    completedAt: null,
    evidence: [],
    batch: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
}

describe("RunStepsDisclosure", () => {
  it("shows semantic Step status and omits an untrusted completion ratio", () => {
    const html = renderToStaticMarkup(
      <RunStepsDisclosure steps={[step("unknown")]} live={false} />,
    );
    expect(html).toContain('data-slot="steps"');
    expect(html).toContain('data-step-status="unknown"');
    expect(html).toContain("some statuses unconfirmed");
    expect(html).not.toContain("0/1 done");
  });
});
