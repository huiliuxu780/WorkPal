// @vitest-environment jsdom
/**
 * UX-01B level 1/2 structure for semantic Steps without a Plan:
 * - level 1 shows Step titles and their status labels only — no "x/y done",
 *   no durations, no attempt/evidence data;
 * - the trouble sentence stays as plain text without any fraction;
 * - level 2 (per-step Details toggle) owns duration, resultSummary, batch,
 *   attempt number and evidence reference counts;
 * - the failed Step's level 2 auto-opens on a failed Run and carries the
 *   failure target for the card's "View reason" action.
 */
import { i18n } from "@lingui/core";
import type { RunStepSnapshot } from "@rakazo/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + String(values[i] ?? ""), ""),
}));

import { RunStepsDisclosure } from "./RunStepsDisclosure";

const ISO = "2026-08-16T00:00:00.000Z";

function step(overrides: Partial<RunStepSnapshot> = {}): RunStepSnapshot {
  return {
    stepId: "review",
    runId: "run-1",
    sourceMessageId: "message-1",
    revision: 1,
    order: 0,
    title: "Review source",
    status: "completed",
    resultSummary: null,
    planItemId: null,
    parentStepId: null,
    attemptId: "attempt-1",
    attemptNumber: 1,
    startedAt: ISO,
    completedAt: ISO,
    evidence: [],
    batch: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(ui: React.ReactElement): HTMLDivElement {
  unmount();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

function unmount(): void {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
}

afterEach(unmount);

beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

describe("RunStepsDisclosure (steps-only level 1 + level 2)", () => {
  it("shows titles and status labels without any done fraction", () => {
    const host = mount(
      <RunStepsDisclosure
        steps={[step(), step({ stepId: "deploy", title: "Deploy fix", order: 1, status: "running", completedAt: null })]}
        failed={false}
      />,
    );
    const section = host.querySelector('[data-slot="steps"]');
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("Review source");
    expect(section!.textContent).toContain("Deploy fix");
    expect(section!.textContent).toContain("Done");
    expect(section!.textContent).toContain("In progress");
    expect(section!.textContent).not.toMatch(/\d+\/\d+/);
    expect(section!.textContent).not.toContain("done ·");
    // Level 1 carries no duration/attempt/evidence data.
    expect(section!.textContent).not.toContain("Attempt");
    expect(section!.textContent).not.toContain("evidence references");
  });

  it("omits an untrusted completion ratio for unknown statuses", () => {
    const host = mount(<RunStepsDisclosure steps={[step({ status: "unknown" })]} failed={false} />);
    expect(host.textContent).toContain('data-step-status');
    expect(host.querySelector('[data-step-status="unknown"]')).not.toBeNull();
    expect(host.textContent).not.toContain("0/1 done");
  });

  it("keeps the trouble sentence as plain text without a fraction", () => {
    const host = mount(
      <RunStepsDisclosure
        steps={[step({ status: "failed" }), step({ stepId: "b", order: 1, status: "blocked" })]}
        failed
      />,
    );
    expect(host.textContent).toContain("2 blocked or failed");
    expect(host.textContent).not.toMatch(/\d+\/\d+ done/);
  });

  it("keeps duration, attempt, evidence, resultSummary and batch in level 2 only", () => {
    const host = mount(
      <RunStepsDisclosure
        steps={[
          step({
            status: "completed",
            completedAt: "2026-08-16T00:04:05.000Z",
            attemptNumber: 3,
            resultSummary: "Reviewed 12 files",
            evidence: [
              { kind: "tool_event", id: "ev-1" },
              { kind: "artifact", id: "ev-2" },
            ],
            batch: { processed: 7, total: 10, unit: "files" },
          }),
        ]}
        failed={false}
      />,
    );
    expect(host.textContent).not.toContain("4m 5s");
    expect(host.textContent).not.toContain("Attempt 3");
    expect(host.textContent).not.toContain("Reviewed 12 files");
    expect(host.textContent).not.toContain("7 / 10 files");
    const toggle = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Details"),
    );
    expect(toggle).toBeTruthy();
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.textContent).toContain("4m 5s");
    expect(host.textContent).toContain("Attempt 3");
    expect(host.textContent).toContain("2 evidence references");
    expect(host.textContent).toContain("Reviewed 12 files");
    expect(host.textContent).toContain("7 / 10 files");
  });

  it("offers no toggle for a Step without level-2 content", () => {
    const host = mount(
      <RunStepsDisclosure
        steps={[
          step({
            status: "completed",
            startedAt: null,
            completedAt: null,
            attemptNumber: null,
            resultSummary: null,
            evidence: [],
            batch: null,
          }),
        ]}
        failed={false}
      />,
    );
    const toggles = [...host.querySelectorAll("button")].filter((button) =>
      button.textContent?.includes("Details"),
    );
    expect(toggles).toHaveLength(0);
  });

  it("auto-opens and marks the failure target for the failed Step on a failed Run", () => {
    const host = mount(
      <RunStepsDisclosure
        steps={[step(), step({ stepId: "deploy", title: "Deploy fix", order: 1, status: "failed", completedAt: null, resultSummary: "Deploy blocked by policy" })]}
        failed
      />,
    );
    const target = host.querySelector("[data-failure-target]");
    expect(target).not.toBeNull();
    expect(target!.textContent).toContain("Deploy blocked by policy");
    // The healthy step stays closed.
    const rows = [...host.querySelectorAll('[data-step-id]')];
    const healthyToggle = [...rows[0]!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Details"),
    );
    expect(healthyToggle?.getAttribute("aria-expanded") ?? "absent").not.toBe("true");
  });

  it("does not auto-open a failed Step while the Run is still live", () => {
    const host = mount(
      <RunStepsDisclosure
        steps={[step({ status: "failed", completedAt: null })]}
        failed={false}
      />,
    );
    expect(host.querySelector("[data-failure-target]")).toBeNull();
  });
});
