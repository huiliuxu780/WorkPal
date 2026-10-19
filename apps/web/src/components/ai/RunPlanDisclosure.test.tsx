// @vitest-environment jsdom
/**
 * UX-01B level 1/2 structure for a published Plan:
 * - level 1 is the ONLY list: goal, v{revision}, changeReason and the items;
 * - the a/b count lives on the card head, never inside level 1;
 * - matched semantic Steps (by planItemId) live in level 2 under their item,
 *   closed until the user opens them (auto-open for the failed step);
 * - unmatched Steps stay reachable under "Other execution records";
 * - nothing auto-expands because the Run is live.
 */
import { i18n } from "@lingui/core";
import type { RunPlanRevision, RunStepSnapshot } from "@rakazo/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + String(values[i] ?? ""), ""),
}));

import { RunPlanDisclosure } from "./RunPlanDisclosure";

const ISO = "2026-08-16T00:00:00.000Z";

function step(overrides: Partial<RunStepSnapshot> = {}): RunStepSnapshot {
  return {
    stepId: "step-1",
    runId: "run-1",
    sourceMessageId: null,
    revision: 1,
    order: 0,
    title: "Review source",
    status: "completed",
    resultSummary: "Source reviewed carefully",
    planItemId: "deliver",
    parentStepId: null,
    attemptId: null,
    attemptNumber: 2,
    startedAt: ISO,
    completedAt: "2026-08-16T00:04:05.000Z",
    evidence: [
      { kind: "tool_event", id: "ev-1" },
      { kind: "artifact", id: "ev-2" },
    ],
    batch: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

const plan: RunPlanRevision = {
  planId: "plan:run-1",
  runId: "run-1",
  sourceMessageId: "message-1",
  revisionId: "plan:run-1:2",
  revision: 2,
  goal: "Check and deliver",
  items: [
    { id: "check", title: "Check source", status: "completed" },
    { id: "deliver", title: "Deliver result", status: "active" },
    { id: "extra", title: "Extra idea", status: "superseded", reason: "Replaced by p2" },
  ],
  changeReason: "Source reviewed",
  createdAt: ISO,
};

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

describe("RunPlanDisclosure (level 1 + grouped level 2)", () => {
  it("shows goal, revision and changeReason without a second a/b count", () => {
    const host = mount(<RunPlanDisclosure plan={plan} steps={[]} failed={false} />);
    const section = host.querySelector('[data-slot="plan"]');
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("Check and deliver");
    expect(section!.textContent).toContain("v2");
    expect(section!.textContent).toContain("Plan updated: Source reviewed");
    expect(section!.textContent).toContain("Check source");
    expect(section!.textContent).toContain("Deliver result");
    // The card head owns the only a/b — level 1 repeats no fraction.
    expect(section!.textContent).not.toMatch(/\d+\/\d+/);
    expect(section!.textContent).not.toContain("done");
    // No nested <details> auto-expansion mechanism remains.
    expect(section!.querySelector("details")).toBeNull();
  });

  it("keeps the reason disclosure for superseded/skipped/unresolved items", () => {
    const host = mount(<RunPlanDisclosure plan={plan} steps={[]} failed={false} />);
    const reasonToggle = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("View reason"),
    );
    expect(reasonToggle).toBeTruthy();
    act(() => {
      reasonToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.textContent).toContain("Replaced by p2");
  });

  it("hides matched Step evidence in level 2 until the item is opened", () => {
    const host = mount(<RunPlanDisclosure plan={plan} steps={[step()]} failed={false} />);
    // Level 1 shows no Step duration/attempt/evidence/resultSummary.
    expect(host.textContent).not.toContain("4m 5s");
    expect(host.textContent).not.toContain("Attempt 2");
    expect(host.textContent).not.toContain("evidence references");
    expect(host.textContent).not.toContain("Source reviewed carefully");
    const item = host.querySelector('[data-plan-item-id="deliver"]');
    expect(item).not.toBeNull();
    const toggle = [...item!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Details"),
    );
    expect(toggle).toBeTruthy();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
    // Level 2: duration, attempt, evidence count and resultSummary.
    expect(host.textContent).toContain("4m 5s");
    expect(host.textContent).toContain("Attempt 2");
    expect(host.textContent).toContain("2 evidence references");
    expect(host.textContent).toContain("Source reviewed carefully");
  });

  it("auto-opens the failed Step's level 2 and marks the failure target", () => {
    const failedStep = step({ stepId: "step-f", status: "failed", completedAt: null });
    const host = mount(<RunPlanDisclosure plan={plan} steps={[failedStep]} failed />);
    const target = host.querySelector("[data-failure-target]");
    expect(target).not.toBeNull();
    expect(target!.textContent).toContain("Review source");
    const item = host.querySelector('[data-plan-item-id="deliver"]');
    const toggle = [...item!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Details"),
    );
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps unmatched Steps under an explicit Other execution records entry", () => {
    const unlinked = step({ stepId: "step-u", planItemId: null, title: "Unlinked work" });
    const orphan = step({ stepId: "step-o", planItemId: "gone", title: "Orphaned work" });
    const host = mount(
      <RunPlanDisclosure plan={plan} steps={[unlinked, orphan]} failed={false} />,
    );
    const others = host.querySelector('[data-slot="steps"]');
    expect(others).not.toBeNull();
    expect(others!.textContent).toContain("Other execution records");
    expect(others!.textContent).toContain("Unlinked work");
    expect(others!.textContent).toContain("Orphaned work");
    // The Plan item's own details toggle does not claim the unmatched steps.
    const item = host.querySelector('[data-plan-item-id="deliver"]');
    expect(item!.textContent).not.toContain("Unlinked work");
  });

  it("omits the Other entry when every Step is matched", () => {
    const host = mount(<RunPlanDisclosure plan={plan} steps={[step()]} failed={false} />);
    expect(host.querySelector('[data-slot="steps"]')).toBeNull();
    expect(host.textContent).not.toContain("Other execution records");
  });

  it("shows the content version and review chip for reviewed plans (UX-02)", () => {
    const container = mount(
      <RunPlanDisclosure
        plan={plan}
        steps={[]}
        review={{
          planId: "plan:run-1",
          contentVersion: 1,
          reviewStatus: "changes_requested",
          approvedContentVersion: null,
          revision: 2,
          feedback: "Rework the delivery stage",
        }}
      />,
    );
    expect(container.querySelector('[data-testid="plan-content-version"]')!.textContent).toBe(
      "v1",
    );
    expect(container.querySelector('[data-testid="plan-review-state"]')!.textContent).toBe(
      "Changes requested",
    );
    // Legacy plans keep the historical raw-revision display, no review chip.
    const legacy = mount(<RunPlanDisclosure plan={plan} steps={[]} />);
    expect(legacy.querySelector('[data-testid="plan-content-version"]')).toBeNull();
    expect(legacy.textContent).toContain("v2");
  });
});
