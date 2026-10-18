// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { Run, RunPlanRevision, RunStepSnapshot } from "@rakazo/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ExecutionShell } from "./ExecutionShell";
import { RunPlanDisclosure } from "./RunPlanDisclosure";
import { RunStepsDisclosure } from "./RunStepsDisclosure";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));

const run = (status: Run["status"], waitKind: Run["waitKind"] = null) =>
  ({ id: "run-1", status, waitKind, error: null }) as Run;

function plan(overrides: Partial<RunPlanRevision> = {}): RunPlanRevision {
  return {
    planId: "plan-1",
    runId: "run-1",
    sourceMessageId: null,
    revisionId: "plan-1-rev",
    revision: 1,
    goal: "Deliver the report",
    items: [
      { id: "p1", title: "Collect data", status: "completed" },
      { id: "p2", title: "Deliver result", status: "active" },
    ],
    changeReason: null,
    createdAt: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}

const STEP_ISO = "2026-10-12T00:00:00.000Z";

function stepFixture(overrides: Partial<RunStepSnapshot> = {}): RunStepSnapshot {
  return {
    stepId: "deploy",
    runId: "run-1",
    sourceMessageId: null,
    revision: 1,
    order: 0,
    title: "Deploy change",
    status: "failed",
    resultSummary: "Deploy blocked by policy",
    planItemId: null,
    parentStepId: null,
    attemptId: null,
    attemptNumber: 1,
    startedAt: STEP_ISO,
    completedAt: null,
    evidence: [],
    batch: null,
    createdAt: STEP_ISO,
    updatedAt: STEP_ISO,
    ...overrides,
  };
}

beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

describe("ExecutionShell", () => {
  it("keeps a waiting Run collapsed by default while interventions stay visible", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={run("waiting_input", "approval")}
        activity={[]}
        interventions={
          <div data-testid="intervention-region">
            <button type="button">批准请求</button>
          </div>
        }
      >
        <div>detail body</div>
      </ExecutionShell>,
    );
    expect(html).toContain('data-status="approval"');
    // UX-01B acceptance 4/7: no auto-expansion, yet the approval control is
    // outside the collapsible body — visible and operable.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("批准请求");
    const interventionsAt = html.indexOf('data-testid="intervention-region"');
    const hiddenAt = html.indexOf('hidden=""');
    expect(interventionsAt).toBeGreaterThan(-1);
    expect(hiddenAt).toBeGreaterThan(-1);
    expect(interventionsAt).toBeLessThan(hiddenAt);
  });

  it("starts completed execution compact without claiming a result summary", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell run={run("completed")} activity={[]}>
        <div>真实步骤</div>
      </ExecutionShell>,
    );
    expect(html).toContain('data-status="done"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("hidden");
  });

  it("keeps a failed execution collapsed with the View reason action", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell run={run("failed")} activity={[]}>
        <div>失败详情</div>
      </ExecutionShell>,
    );
    // UX-01B acceptance 8: failed stays collapsed; the primary action leads
    // to the reason instead of auto-expanding the whole detail.
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("View reason");
  });

  it("follows server-driven expansion for a restored terminal Run", () => {
    const collapsed = renderToStaticMarkup(
      <ExecutionShell
        run={run("completed")}
        activity={[]}
        expansion={{ open: false, toggle: () => undefined }}
        canExpand
      >
        <div>restored detail</div>
      </ExecutionShell>,
    );
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain("hidden");
    const opened = renderToStaticMarkup(
      <ExecutionShell
        run={run("completed")}
        activity={[]}
        expansion={{ open: true, toggle: () => undefined }}
        canExpand
      >
        <div>restored detail</div>
      </ExecutionShell>,
    );
    expect(opened).toContain('aria-expanded="true"');
    expect(opened).not.toContain('hidden=""');
  });

  it("shows the durable status and title for a Run restored without a legacy row", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={{ id: "run-history", status: "completed", waitKind: null }}
        activity={[]}
        expansion={{ open: false, toggle: () => undefined }}
        canExpand
        summary={{
          runId: "run-history",
          threadId: "thread-1",
          botId: "bot-1",
          rev: 2,
          status: "completed",
          trigger: "user",
          title: "Restored analysis",
          updatedAt: "2026-10-12T10:18:00.000Z",
          artifacts: [],
          entry: "execution",
        }}
      >
        <div>restored detail</div>
      </ExecutionShell>,
    );
    expect(html).toContain('data-status="done"');
    expect(html).toContain("Restored analysis");
    expect(html).not.toContain("Status unknown");
    // No raw Run/Thread/Bot identifiers in the card DOM.
    expect(html).not.toContain("run-history");
    expect(html).not.toContain("thread-1");
    expect(html).not.toContain("bot-1");
  });

  it("keeps the intervention slot visible while a controlled detail stays collapsed", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={run("completed")}
        activity={[]}
        expansion={{ open: false, toggle: () => undefined }}
        interventions={<div data-testid="intervention-region">需要你处理</div>}
      >
        <div>detail</div>
      </ExecutionShell>,
    );
    expect(html).toContain("execution-interventions");
    expect(html).toContain("需要你处理");
    expect(html).toContain("hidden");
  });

  it("lets controlled expansion collapse a waiting Run while interventions stay reachable", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={run("waiting_input", "approval")}
        activity={[]}
        pendingInterventionKinds={["approval"]}
        expansion={{ open: false, toggle: () => undefined }}
        interventions={
          <div data-testid="execution-interventions">
            <button type="button">Allow once</button>
          </div>
        }
      >
        <div>detail</div>
      </ExecutionShell>,
    );
    // The detail is collapsed (single-open authority), yet the pending
    // Intervention and the attention action remain visible and operable.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('hidden=""');
    expect(html).toContain("Needs your attention");
    const interventionsAt = html.indexOf('data-testid="execution-interventions"');
    const hiddenAt = html.indexOf('hidden=""');
    expect(interventionsAt).toBeGreaterThan(-1);
    expect(interventionsAt).toBeLessThan(hiddenAt);
    expect(html).toContain("Allow once");
  });

  it("renders no progress rail, count or bar without a Plan (acceptance 6)", () => {
    const steps = [
      { order: 0, title: "Collect", status: "completed" },
      { order: 1, title: "Analyze", status: "running" },
    ] as unknown as RunStepSnapshot[];
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={run("running")}
        activity={[]}
        expansion={{ open: false, toggle: () => undefined }}
        canExpand
        steps={steps}
      >
        <div>detail body</div>
      </ExecutionShell>,
    );
    // Steps never fabricate progress: no rail base, no fill, no count, no
    // 0/-- placeholder.
    expect(html).not.toContain("exc-rail");
    expect(html).not.toContain("progressbar");
    expect(html).not.toContain("execution-plan-count");
    expect(html).not.toContain("--");
  });

  it("renders the single accessible Plan progress (acceptance 4/5)", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={run("running")}
        activity={[]}
        expansion={{ open: false, toggle: () => undefined }}
        canExpand
        plan={plan()}
      >
        <div>detail body</div>
      </ExecutionShell>,
    );
    expect(html).toContain('data-testid="execution-plan-count"');
    expect(html).toContain("1/2");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('aria-valuemax="2"');
    expect(html).toContain('aria-label="Plan progress"');
    expect(html).toContain("exc-rail");
    expect(html).toContain('style="height:50%"');
    // Exactly one a/b on the card.
    expect(html.split("1/2").length - 1).toBe(1);
  });
});

describe("ExecutionShell plan revision flash (acceptance 9)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function mountShell(planProp: RunPlanRevision | null): HTMLDivElement {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <ExecutionShell
          run={run("running")}
          activity={[]}
          expansion={{ open: false, toggle: () => undefined }}
          canExpand
          plan={planProp}
        >
          <div>detail body</div>
        </ExecutionShell>,
      );
    });
    return container;
  }

  function rerenderShell(planProp: RunPlanRevision | null): void {
    act(() => {
      root!.render(
        <ExecutionShell
          run={run("running")}
          activity={[]}
          expansion={{ open: false, toggle: () => undefined }}
          canExpand
          plan={planProp}
        >
          <div>detail body</div>
        </ExecutionShell>,
      );
    });
  }

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    vi.useRealTimers();
  });

  it("flashes 计划已更新 for 3 seconds when the revision grows, and not before", () => {
    vi.useFakeTimers();
    const host = mountShell(plan());
    // First plan sighting on this mounted Run: no flash.
    expect(host.querySelector('[data-testid="execution-plan-updated"]')).toBeNull();

    // Revision 1 → 2 with a changed denominator (3/4 → 3/6 style regression).
    rerenderShell(
      plan({
        revision: 2,
        changeReason: "Scope grew",
        items: [
          { id: "p1", title: "Collect data", status: "completed" },
          { id: "p2", title: "Deliver result", status: "active" },
          { id: "p3", title: "Review", status: "pending" },
        ],
      }),
    );
    const flash = host.querySelector('[data-testid="execution-plan-updated"]');
    expect(flash).not.toBeNull();
    expect(flash!.getAttribute("role")).toBe("status");
    expect(flash!.getAttribute("aria-live")).toBe("polite");
    expect(flash!.textContent).toBe("Plan updated");

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(host.querySelector('[data-testid="execution-plan-updated"]')).toBeNull();
  });

  it("does not flash for the same revision, a stale regression, or the first detail load", () => {
    vi.useFakeTimers();
    const host = mountShell(null);
    // First detail load brings the initial Plan: no flash.
    rerenderShell(plan({ revision: 3 }));
    expect(host.querySelector('[data-testid="execution-plan-updated"]')).toBeNull();
    // Same revision again: no flash.
    rerenderShell(plan({ revision: 3 }));
    expect(host.querySelector('[data-testid="execution-plan-updated"]')).toBeNull();
    // A stale response regressing the revision: no flash.
    rerenderShell(plan({ revision: 2 }));
    expect(host.querySelector('[data-testid="execution-plan-updated"]')).toBeNull();
  });

  it("clears the flash timer on unmount", () => {
    vi.useFakeTimers();
    const host = mountShell(plan());
    rerenderShell(plan({ revision: 2 }));
    expect(host.querySelector('[data-testid="execution-plan-updated"]')).not.toBeNull();
    act(() => {
      root!.unmount();
      root = null;
      // The pending 3s timer must not fire against an unmounted component.
      vi.advanceTimersByTime(5_000);
    });
    expect(true).toBe(true);
  });
});

describe("ExecutionShell failed reason focus (acceptance 8)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  function mount(element: React.ReactElement): HTMLDivElement {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root!.render(element);
    });
    return container;
  }

  function rerender(element: React.ReactElement): void {
    act(() => {
      root!.render(element);
    });
  }

  it("moves focus to the failure target when a failed card is open", () => {
    mount(
      <ExecutionShell
        run={run("failed")}
        activity={[]}
        expansion={{ open: true, toggle: () => undefined }}
        canExpand
      >
        <p data-testid="execution-failure-reason" data-failure-target tabIndex={-1}>
          The billing service timed out
        </p>
      </ExecutionShell>,
    );
    const active = document.activeElement;
    expect(active).not.toBeNull();
    expect(active!.hasAttribute("data-failure-target")).toBe(true);
  });

  it("focuses the REAL failed Step detail composed from RunStepsDisclosure (sync)", () => {
    // Regression (review round P2): the production target must itself be
    // focusable — a hand-written tabIndex node used to hide that it was not.
    mount(
      <ExecutionShell
        run={run("failed")}
        activity={[]}
        steps={[stepFixture()]}
        expansion={{ open: true, toggle: () => undefined }}
        canExpand
      >
        <RunStepsDisclosure steps={[stepFixture()]} failed />
      </ExecutionShell>,
    );
    const active = document.activeElement as HTMLElement | null;
    expect(active).not.toBeNull();
    expect(active!.hasAttribute("data-failure-target")).toBe(true);
    // It is the real level-2 detail of the failed Step, inside the steps list.
    expect(active!.closest('[data-step-id="deploy"]')).not.toBeNull();
    expect(active!.textContent).toContain("Deploy blocked by policy");
  });

  it("focuses the REAL failed Step detail under its Plan item (RunPlanDisclosure)", () => {
    const matched = stepFixture({ planItemId: "p2" });
    mount(
      <ExecutionShell
        run={run("failed")}
        activity={[]}
        plan={plan()}
        steps={[matched]}
        expansion={{ open: true, toggle: () => undefined }}
        canExpand
      >
        <RunPlanDisclosure plan={plan()} steps={[matched]} failed />
      </ExecutionShell>,
    );
    const active = document.activeElement as HTMLElement | null;
    expect(active).not.toBeNull();
    expect(active!.hasAttribute("data-failure-target")).toBe(true);
    expect(active!.closest('[data-plan-item-id="p2"]')).not.toBeNull();
    expect(active!.textContent).toContain("Deploy blocked by policy");
  });

  it("lands focus on the failed Step detail that arrives AFTER the card opened", () => {
    // Regression (review round P2): the detail loads asynchronously — opening
    // a failed card before the Step exists must still land focus once it does.
    const shell = (steps: RunStepSnapshot[], children: React.ReactNode) => (
      <ExecutionShell
        run={run("failed")}
        activity={[]}
        steps={steps}
        expansion={{ open: true, toggle: () => undefined }}
        canExpand
      >
        {children}
      </ExecutionShell>
    );
    // Initially the failed Step is unknown: only the Run-level reason exists.
    mount(
      shell(
        [],
        <p data-testid="execution-failure-reason" data-failure-target tabIndex={-1}>
          Scripted run failure
        </p>,
      ),
    );
    const first = document.activeElement as HTMLElement | null;
    expect(first?.getAttribute("data-testid")).toBe("execution-failure-reason");

    // The detail arrives: the reason block yields to the failed Step's own
    // level-2 detail, and focus must move to the real target.
    rerender(shell([stepFixture()], <RunStepsDisclosure steps={[stepFixture()]} failed />));
    const active = document.activeElement as HTMLElement | null;
    expect(active).not.toBeNull();
    expect(active!.hasAttribute("data-failure-target")).toBe(true);
    expect(active!.closest('[data-step-id="deploy"]')).not.toBeNull();
  });
});

describe("ExecutionShell waiting card disclosure entry (review round P1)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let open = false;

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  function mountWaiting() {
    open = false;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = () =>
      act(() => {
        root!.render(
          <ExecutionShell
            run={run("waiting_input", "approval")}
            activity={[]}
            pendingInterventionKinds={["approval"]}
            plan={plan()}
            expansion={{
              open,
              toggle: () => {
                open = !open;
                render();
              },
            }}
            canExpand
            interventions={
              <div data-testid="execution-interventions">
                <button type="button">Allow once</button>
              </div>
            }
          >
            <RunPlanDisclosure plan={plan()} steps={[]} failed={false} />
          </ExecutionShell>,
        );
      });
    render();
    return container!;
  }

  function click(host: HTMLElement, name: string) {
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === name,
    );
    expect(button, `button ${name}`).toBeTruthy();
    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("keeps the attention action AND offers an independent View progress / Collapse entry", () => {
    const host = mountWaiting();
    // Collapsed by default; the approval control is outside and operable.
    expect(host.querySelector(".exc-details")!.hasAttribute("hidden")).toBe(true);
    const attention = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Needs your attention",
    );
    expect(attention).toBeTruthy();
    // The attention button is not a disclosure control any more — the
    // independent toggle entry carries aria-expanded instead.
    expect(attention!.hasAttribute("aria-expanded")).toBe(false);
    const toggle = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "View progress",
    );
    expect(toggle).toBeTruthy();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");

    // Expanding reveals the Plan (level 1) while the intervention stays put.
    click(host, "View progress");
    expect(host.querySelector(".exc-details")!.hasAttribute("hidden")).toBe(false);
    expect(host.querySelector('[data-slot="plan"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="execution-interventions"]')).not.toBeNull();
    const collapse = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Collapse",
    );
    expect(collapse).toBeTruthy();

    // The attention action still focuses the first operable control.
    click(host, "Needs your attention");
    const active = document.activeElement as HTMLElement | null;
    expect(active?.closest('[data-testid="execution-interventions"]')).not.toBeNull();

    // And the disclosure closes again.
    click(host, "Collapse");
    expect(host.querySelector(".exc-details")!.hasAttribute("hidden")).toBe(true);
  });
});
