import { i18n } from "@lingui/core";
import type { ActivityItem, ExecutionSummary, InterventionView, Run } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));

import { ExecutionActivity } from "./ExecutionActivity";
import { ExecutionShell } from "./ExecutionShell";

beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

const run = (status: Run["status"], waitKind: Run["waitKind"] = null) =>
  ({ id: "run-id-1", status, waitKind, error: null }) as Run;

function summary(overrides: Partial<ExecutionSummary> = {}): ExecutionSummary {
  return {
    runId: "run-id-1",
    threadId: "thread-id-1",
    botId: "bot-id-1",
    rev: 4,
    status: "completed",
    trigger: "user",
    title: "Analyze this year's tickets",
    updatedAt: "2026-10-12T10:18:00.000Z",
    artifacts: [],
    entry: "execution",
    ...overrides,
  };
}

function intervention(overrides: Partial<InterventionView> = {}): InterventionView {
  return {
    id: "intervention-id-1",
    revision: 1,
    kind: "approval",
    status: "pending",
    spaceId: "space-id-1",
    threadId: "thread-id-1",
    runId: "run-id-1",
    attemptId: "attempt-id-1",
    botId: "bot-id-1",
    messageId: "message-id-1",
    createdAt: "2026-10-12T00:00:00.000Z",
    requestingActor: { botId: "bot-id-1" },
    presentation: { text: "Send the report now?" },
    ...overrides,
  };
}

const runningActivity = [
  {
    id: "act-1",
    runId: "run-id-1",
    botId: "bot-id-1",
    threadId: "thread-id-1",
    kind: "working",
    status: "running",
    title: "Checking ticket TK-19002",
  },
] as ActivityItem[];

const occurrences = (html: string, needle: string) => html.split(needle).length - 1;

describe("ExecutionCard", () => {
  it("renders a collapsed terminal card with title, metadata and the result verb", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={run("completed")}
        activity={[]}
        expansion={{ open: false, toggle: () => undefined }}
        canExpand
        summary={summary({
          outcome: "Found 3 anomalous tickets",
          completedAt: "2026-10-12T11:04:00.000Z",
          durationMs: 2_765_000,
          counts: { steps: 3, actions: 12 },
        })}
      >
        <div>restored detail</div>
      </ExecutionShell>,
    );
    expect(html).toContain('data-testid="execution-card"');
    expect(html).toContain("Analyze this year&#x27;s tickets");
    expect(html).toContain("Found 3 anomalous tickets");
    expect(html).toContain("3 steps · 12 actions · 46m 05s");
    expect(html).toContain("View result");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("hidden");
  });

  it("switches the verb to Collapse when expanded", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={run("completed")}
        activity={[]}
        expansion={{ open: true, toggle: () => undefined }}
        canExpand
        summary={summary()}
      >
        <div>detail body</div>
      </ExecutionShell>,
    );
    expect(html).toContain("Collapse");
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('hidden=""');
  });

  it("keeps a pending Intervention operable while the detail is collapsed", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={run("completed")}
        activity={[]}
        expansion={{ open: false, toggle: () => undefined }}
        summary={summary()}
        interventions={
          <div data-testid="intervention-region">
            <button type="button">Allow once</button>
          </div>
        }
      >
        <div>detail body</div>
      </ExecutionShell>,
    );
    // The interventions slot renders outside the hidden detail container.
    const interventionsAt = html.indexOf('data-testid="execution-interventions"');
    const hiddenAt = html.indexOf('hidden=""');
    expect(interventionsAt).toBeGreaterThan(-1);
    expect(html.indexOf("Allow once")).toBeGreaterThan(-1);
    expect(hiddenAt).toBeGreaterThan(-1);
    expect(interventionsAt).toBeLessThan(hiddenAt);
  });

  it("turns the primary action into the attention verb while waiting for approval", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={run("waiting_input", "approval")}
        activity={[]}
        pendingInterventionKinds={["approval"]}
        pendingInterventionViews={[intervention()]}
        summary={summary({ status: "waiting_input", waitKind: "approval" })}
        interventions={<div data-testid="intervention-region">card</div>}
      >
        <div>detail body</div>
      </ExecutionShell>,
    );
    expect(html).toContain("Needs your attention");
    expect(html).toContain("Send the report now?");
    expect(html).toContain('data-attention="1"');
    // A waiting Run is always expanded — the detail is reachable, never inert.
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain(" inert=");
  });

  it("prefers the approval question over an older input question on the card line", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={run("waiting_input", "approval")}
        activity={[]}
        pendingInterventionKinds={["input", "approval"]}
        pendingInterventionViews={[
          intervention({
            id: "input-1",
            kind: "input",
            createdAt: "2026-10-11T00:00:00.000Z",
            presentation: { text: "Which city?" },
          }),
          intervention({ id: "approval-1", presentation: { text: "Send it now?" } }),
        ]}
        interventions={<div data-testid="intervention-region">cards</div>}
      >
        <div>detail body</div>
      </ExecutionShell>,
    );
    expect(html).toContain("Send it now?");
    expect(html).not.toContain("Which city?");
  });

  it("shows only the safe failure summary and offers no retry", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={run("failed")}
        activity={[]}
        expansion={{ open: false, toggle: () => undefined }}
        canExpand
        summary={summary({ status: "failed", failure: "The billing service timed out" })}
      >
        <div>detail body</div>
      </ExecutionShell>,
    );
    expect(html).toContain("The billing service timed out");
    expect(html).not.toMatch(/retry/i);
    expect(html).not.toMatch(/重试/);
    expect(html).toContain("View execution");
    // The visible status sentence appears once (the card aria-label repeats it
    // for screen readers by design, which is not a second status header).
    expect(occurrences(html, ">Execution failed<")).toBe(1);
  });

  it("keeps exactly one status sentence across card and detail", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={run("running")}
        activity={runningActivity}
        expansion={{ open: true, toggle: () => undefined }}
        canExpand
        summary={summary({ status: "running" })}
      >
        <ExecutionActivity run={run("running")} items={runningActivity} />
      </ExecutionShell>,
    );
    // The card head owns the current-activity sentence; the expanded detail
    // section yields its duplicate primary line.
    expect(occurrences(html, "Checking ticket TK-19002")).toBe(1);
    expect(occurrences(html, ">Executing<")).toBe(1);
  });

  it("renders a long title and omits empty metadata entirely", () => {
    const longTitle = "Ticket-".repeat(60) + "analysis";
    const html = renderToStaticMarkup(
      <ExecutionShell
        run={run("completed")}
        activity={[]}
        expansion={{ open: false, toggle: () => undefined }}
        canExpand
        summary={summary({ title: longTitle })}
      >
        <div>detail body</div>
      </ExecutionShell>,
    );
    expect(html).toContain(longTitle);
    expect(html).toContain("exc-title");
    expect(html).not.toContain("exc-meta");
    expect(html).not.toContain("0 steps");
    expect(html).not.toContain("--");
  });

  it("stays conservative when the step list is truncated", () => {
    const steps = [
      { order: 0, title: "Collect", status: "completed" },
      { order: 1, title: "Analyze", status: "running" },
    ] as never;
    const truncated = renderToStaticMarkup(
      <ExecutionShell
        run={run("running")}
        activity={[]}
        expansion={{ open: false, toggle: () => undefined }}
        canExpand
        summary={summary({ status: "running" })}
        steps={steps}
        stepsTruncated
      >
        <div>detail body</div>
      </ExecutionShell>,
    );
    expect(truncated).not.toContain(`style="height:`);
    const honest = renderToStaticMarkup(
      <ExecutionShell
        run={run("running")}
        activity={[]}
        expansion={{ open: false, toggle: () => undefined }}
        canExpand
        summary={summary({ status: "running" })}
        steps={steps}
      >
        <div>detail body</div>
      </ExecutionShell>,
    );
    expect(honest).toContain(`style="height:50%"`);
  });

  it("keeps raw Run/Thread/Bot identifiers out of the shell and card DOM", () => {
    const html = renderToStaticMarkup(
      <ExecutionShell run={run("completed")} activity={[]} summary={summary()}>
        <div>detail body</div>
      </ExecutionShell>,
    );
    expect(occurrences(html, "run-id-1")).toBe(0);
    expect(html).not.toContain("thread-id-1");
    expect(html).not.toContain("bot-id-1");
    const article = html.slice(
      html.indexOf("<article"),
      html.indexOf(">", html.indexOf("<article")),
    );
    expect(article).not.toContain("run-id-1");
    expect(article).not.toContain("thread-id-1");
    expect(article).not.toContain("bot-id-1");
  });

  it("marks live foreground cards and drops the tint when expanded or background", () => {
    const live = renderToStaticMarkup(
      <ExecutionShell
        run={run("running")}
        activity={runningActivity}
        expansion={{ open: false, toggle: () => undefined }}
        canExpand
        summary={summary({ status: "running" })}
      >
        <div>detail body</div>
      </ExecutionShell>,
    );
    expect(live).toContain('data-live="1"');
    const opened = renderToStaticMarkup(
      <ExecutionShell
        run={run("running")}
        activity={runningActivity}
        expansion={{ open: true, toggle: () => undefined }}
        canExpand
        summary={summary({ status: "running" })}
      >
        <div>detail body</div>
      </ExecutionShell>,
    );
    expect(opened).toContain('data-live="0"');
    const background = renderToStaticMarkup(
      <ExecutionShell
        run={run("running")}
        activity={runningActivity}
        confirmedRootBackground
        expansion={{ open: false, toggle: () => undefined }}
        canExpand
        summary={summary({ status: "running" })}
      >
        <div>detail body</div>
      </ExecutionShell>,
    );
    expect(background).toContain('data-background="1"');
    expect(background).toContain('data-live="0"');
  });
});
