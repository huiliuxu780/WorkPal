import { i18n } from "@lingui/core";
import type {
  ActivityItem,
  ExecutionSummary,
  InterventionView,
  Run,
  RunPlanRevision,
  RunStepSnapshot,
} from "@rakazo/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));

import {
  buildExecutionCardModel,
  currentItemElapsedMinutes,
  currentPlanItem,
  effectivePlanItems,
  planProgress,
  resultHasText,
} from "./execution-card";
import { deriveExecutionStatus } from "./execution-status";

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
    presentation: { text: "Send the report to billing@example.com?" },
    ...overrides,
  };
}

const activity = (title: string, status: ActivityItem["status"] = "running"): ActivityItem =>
  ({
    id: `act-${title}`,
    runId: "run-id-1",
    botId: "bot-id-1",
    threadId: "thread-id-1",
    kind: "working",
    status,
    title,
  }) as ActivityItem;

function plan(overrides: Partial<RunPlanRevision> = {}): RunPlanRevision {
  return {
    planId: "plan-id-1",
    runId: "run-id-1",
    sourceMessageId: null,
    revisionId: "plan-rev-1",
    revision: 1,
    goal: "Deliver the quarterly report",
    items: [
      { id: "p1", title: "Collect data", status: "completed" },
      { id: "p2", title: "Deliver result", status: "active" },
    ],
    changeReason: null,
    createdAt: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}

function planStep(overrides: Partial<RunStepSnapshot> = {}): RunStepSnapshot {
  return {
    stepId: "step-1",
    runId: "run-id-1",
    sourceMessageId: null,
    revision: 1,
    order: 0,
    title: "Deliver result",
    status: "running",
    resultSummary: null,
    planItemId: "p2",
    parentStepId: null,
    attemptId: null,
    attemptNumber: null,
    startedAt: "2026-10-12T10:00:00.000Z",
    completedAt: null,
    evidence: [],
    batch: null,
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T10:00:00.000Z",
    ...overrides,
  };
}

function model(
  runState: Run | null,
  items: readonly ActivityItem[] = [],
  options: Parameters<typeof deriveExecutionStatus>[2] = {},
  input: Partial<Parameters<typeof buildExecutionCardModel>[0]> = {},
) {
  const status = deriveExecutionStatus(runState, items, options);
  return buildExecutionCardModel({
    status,
    expanded: false,
    canExpand: true,
    ...input,
  });
}

describe("buildExecutionCardModel status coverage", () => {
  it("maps queued with no fabricated metadata", () => {
    const card = model(run("queued"), [], {}, { summary: null });
    expect(card.status).toBe("unknown");
    expect(card.statusLabel).toBe("Execution queued");
    expect(card.live).toBe(true);
    expect(card.title).toBeNull();
    expect(card.aux).toBeNull();
    expect(card.metaParts).toEqual([]);
    expect(card.planProgress).toBeNull();
    expect(card.action).toEqual({ verb: "View progress", act: "toggle" });
  });

  it("maps leased to the starting activity line", () => {
    const card = model(run("leased"));
    expect(card.status).toBe("working");
    expect(card.aux).toEqual({ kind: "activity", text: "Starting" });
    expect(card.action?.verb).toBe("View progress");
  });

  it("maps running to the latest safe activity line", () => {
    const card = model(run("running"), [activity("Checking ticket TK-19002")]);
    expect(card.status).toBe("working");
    expect(card.aux).toEqual({ kind: "activity", text: "Checking ticket TK-19002" });
  });

  it("maps waiting approval with the sanitized question first", () => {
    const card = model(
      run("waiting_input", "approval"),
      [],
      { pendingInterventionKinds: ["approval"] },
      {
        summary: summary({ status: "waiting_input", waitKind: "approval" }),
        pendingInterventions: [intervention()],
      },
    );
    expect(card.status).toBe("approval");
    expect(card.needsAttention).toBe(true);
    expect(card.aux).toEqual({
      kind: "intervention",
      text: "Send the report to billing@example.com?",
    });
    expect(card.action).toEqual({ verb: "Needs your attention", act: "attention" });
    // Review round P1: the attention card keeps an INDEPENDENT disclosure
    // entry so Plan/Steps/evidence stay reachable while waiting.
    expect(card.secondaryAction).toEqual({ verb: "View progress", act: "toggle" });
  });

  it("flips the secondary disclosure entry to Collapse while expanded", () => {
    const card = model(
      run("waiting_input", "approval"),
      [],
      { pendingInterventionKinds: ["approval"] },
      {
        summary: summary({ status: "waiting_input", waitKind: "approval" }),
        pendingInterventions: [intervention()],
        expanded: true,
      },
    );
    expect(card.action).toEqual({ verb: "Needs your attention", act: "attention" });
    expect(card.secondaryAction).toEqual({ verb: "Collapse", act: "toggle" });
  });

  it("omits the secondary entry without a detail body", () => {
    const waiting = model(
      run("waiting_input", "approval"),
      [],
      { pendingInterventionKinds: ["approval"] },
      { pendingInterventions: [intervention()], canExpand: false },
    );
    expect(waiting.action).toEqual({ verb: "Needs your attention", act: "attention" });
    expect(waiting.secondaryAction).toBeNull();
    const plain = model(run("running"), [], {}, { summary: summary({ status: "running" }) });
    expect(plain.secondaryAction).toBeNull();
  });

  it("orders an approval ahead of an older input question", () => {
    const card = model(
      run("waiting_input", "approval"),
      [],
      { pendingInterventionKinds: ["input", "approval"] },
      {
        pendingInterventions: [
          intervention({
            id: "input-1",
            kind: "input",
            createdAt: "2026-10-11T00:00:00.000Z",
            presentation: { text: "Which city?" },
          }),
          intervention({
            id: "approval-1",
            createdAt: "2026-10-12T00:00:00.000Z",
            presentation: { text: "Send it now?" },
          }),
        ],
      },
    );
    expect(card.aux).toEqual({ kind: "intervention", text: "Send it now?" });
  });

  it("maps waiting input", () => {
    const card = model(
      run("waiting_input", "input"),
      [],
      { pendingInterventionKinds: ["input"] },
      {
        pendingInterventions: [
          intervention({ kind: "input", presentation: { text: "Which city?" } }),
        ],
      },
    );
    expect(card.status).toBe("need_input");
    expect(card.aux).toEqual({ kind: "intervention", text: "Which city?" });
  });

  it("maps waiting takeover without inventing an intervention line", () => {
    const card = model(run("waiting_takeover", "takeover"), [], {
      pendingInterventionKinds: [],
    });
    expect(card.status).toBe("takeover");
    expect(card.aux).toEqual({ kind: "activity", text: "Open the computer to take control" });
    expect(card.action).toEqual({ verb: "Needs your attention", act: "attention" });
  });

  it("maps completed with outcome, real non-step metadata and the result verb", () => {
    const card = model(
      run("completed"),
      [],
      {},
      {
        summary: summary({
          outcome: "Found 3 anomalous tickets",
          completedAt: "2026-10-12T11:04:00.000Z",
          durationMs: 46 * 60_000 + 5_000,
          counts: { steps: 3, actions: 12, agents: 2, artifacts: 1 },
          artifacts: [{ id: "artifact-1", name: "report.md" }],
        }),
      },
    );
    expect(card.status).toBe("done");
    expect(card.aux).toEqual({ kind: "outcome", text: "Found 3 anomalous tickets" });
    expect(card.title).toBe("Analyze this year's tickets");
    // UX-01B acceptance 5: the step count never renders as card metadata.
    expect(card.metaParts).toEqual(["12 actions", "2 collaborators", "1 artifact", "46m 05s"]);
    expect(card.artifactsLine).toBe("Generated report.md");
    expect(card.when).not.toBeNull();
    expect(card.action).toEqual({ verb: "View result", act: "toggle" });
  });

  it("yields the outcome line to the expanded result section", () => {
    const card = model(
      run("completed"),
      [],
      {},
      {
        summary: summary({ outcome: "Found 3 anomalous tickets" }),
        expanded: true,
        hasResult: true,
      },
    );
    expect(card.aux).toBeNull();
    expect(card.action).toEqual({ verb: "Collapse", act: "toggle" });
  });

  it("suppresses the outcome line while the result bubble is on the page", () => {
    const card = model(
      run("completed"),
      [],
      {},
      { summary: summary({ outcome: "Found 3 anomalous tickets" }), resultOnPage: true },
    );
    expect(card.aux).toBeNull();
    const offPage = model(
      run("completed"),
      [],
      {},
      { summary: summary({ outcome: "Found 3 anomalous tickets" }), resultOnPage: false },
    );
    expect(offPage.aux).toEqual({ kind: "outcome", text: "Found 3 anomalous tickets" });
  });

  it("maps failed with the safe failure projection, the reason verb and no retry", () => {
    const card = model(
      run("failed"),
      [],
      {},
      {
        summary: summary({ status: "failed", failure: "The billing service timed out" }),
        steps: [
          { order: 0, title: "Collect", status: "completed" },
          { order: 1, title: "Deploy", status: "failed" },
          { order: 2, title: "Report", status: "pending" },
        ] as never,
      },
    );
    expect(card.status).toBe("failed");
    expect(card.aux).toEqual({
      kind: "failure",
      text: "Step 2 · Deploy · The billing service timed out",
    });
    // UX-01B acceptance 8: the failed Run's primary action is the reason path.
    expect(card.action).toEqual({ verb: "View reason", act: "toggle" });
    expect(card.retryAction).toBeNull();
  });

  it("adds Retry beside View reason when the server allows a manual retry", () => {
    const card = model(
      run("failed"),
      [],
      {},
      {
        summary: summary({
          status: "failed",
          failure: "The billing service timed out",
          manualRetry: { allowed: true },
        }),
      },
    );
    expect(card.action).toEqual({ verb: "View reason", act: "toggle" });
    expect(card.retryAction).toEqual({ verb: "Retry", act: "retry" });
  });

  it("shows Retrying… while a manual retry is submitting", () => {
    const card = model(
      run("failed"),
      [],
      {},
      {
        summary: summary({
          status: "failed",
          failure: "The billing service timed out",
          manualRetry: { allowed: true },
        }),
        retrying: true,
      },
    );
    expect(card.retryAction).toEqual({ verb: "Retrying…", act: "retry" });
  });

  it("marks an already-retried card and offers View retry instead of Retry", () => {
    const card = model(
      run("failed"),
      [],
      {},
      {
        summary: summary({
          status: "failed",
          failure: "The billing service timed out",
          retrySuccessorRunId: "run-id-2",
          manualRetry: { allowed: true },
        }),
      },
    );
    expect(card.retryAction).toEqual({ verb: "View retry", act: "view_successor" });
    expect(card.alreadyRetriedLabel).toBe("Already retried");
  });

  it("maps cancelled without a result sentence", () => {
    const card = model(
      run("cancelled"),
      [],
      {},
      { summary: summary({ status: "cancelled", outcome: "stale outcome" }) },
    );
    expect(card.status).toBe("cancelled");
    expect(card.aux).toBeNull();
    expect(card.live).toBe(false);
    expect(card.action?.verb).toBe("View progress");
  });

  it("maps a confirmed background Run without a live tint", () => {
    const card = model(run("running"), [activity("Digesting inbox")], {
      confirmedRootBackground: true,
    });
    expect(card.status).toBe("background");
    expect(card.background).toBe(true);
    expect(card.live).toBe(false);
  });

  it("omits everything untrusted for unknown or incomplete fields", () => {
    const card = model(null, [], {}, { summary: null, canExpand: false });
    expect(card.status).toBe("unknown");
    expect(card.statusLabel).toBe("Status unknown");
    expect(card.title).toBeNull();
    expect(card.aux).toBeNull();
    expect(card.metaParts).toEqual([]);
    expect(card.when).toBeNull();
    expect(card.planProgress).toBeNull();
    expect(card.action).toBeNull();
  });

  it("never renders zero counts, placeholders or percentages", () => {
    const card = model(
      run("completed"),
      [],
      {},
      { summary: summary({ counts: { steps: 0, actions: 0 } }) },
    );
    expect(card.metaParts).toEqual([]);
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("%");
    expect(serialized).not.toContain("--");
  });

  it("keeps identifiers, credentials and raw errors out of the model", () => {
    const card = model(
      run("failed"),
      [],
      {},
      {
        summary: summary({ status: "failed", failure: "The billing service timed out" }),
        pendingInterventions: [
          intervention({
            presentation: {
              text: "Sign in to continue?",
              credential: {
                name: "Billing",
                origin: "https://billing.internal",
                authType: "login",
              } as never,
            },
          }),
        ],
      },
    );
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("run-id-1");
    expect(serialized).not.toContain("thread-id-1");
    expect(serialized).not.toContain("bot-id-1");
    expect(serialized).not.toContain("attempt-id-1");
    expect(serialized).not.toContain("billing.internal");
    expect(card.aux?.text).toBe("The billing service timed out");
  });
});

describe("effectivePlanItems / planProgress (UX-01B acceptance 5)", () => {
  it("excludes skipped and superseded items and keeps unresolved in the denominator", () => {
    const revised = plan({
      items: [
        { id: "p1", title: "Collect", status: "completed" },
        { id: "p2", title: "Old approach", status: "superseded" },
        { id: "p3", title: "Optional extra", status: "skipped" },
        { id: "p4", title: "Deliver", status: "unresolved" },
        { id: "p5", title: "Review", status: "pending" },
      ],
    });
    expect(effectivePlanItems(revised).map((item) => item.id)).toEqual(["p1", "p4", "p5"]);
    // unresolved counts toward the denominator, never the numerator.
    expect(planProgress(revised)).toMatchObject({ completed: 1, total: 3, fraction: 1 / 3 });
  });

  it("is the single progress source: completed over effective total", () => {
    const progress = planProgress(
      plan({
        items: [
          { id: "a", title: "a", status: "completed" },
          { id: "b", title: "b", status: "completed" },
          { id: "c", title: "c", status: "completed" },
          { id: "d", title: "d", status: "active" },
          { id: "e", title: "e", status: "pending" },
        ],
      }),
    );
    expect(progress).toMatchObject({ completed: 3, total: 5, fraction: 3 / 5 });
    expect(progress?.label).toBe("Plan progress");
  });

  it("allows regression when a revision grows the denominator (3/4 → 3/6)", () => {
    const before = planProgress(
      plan({
        items: [
          { id: "a", title: "a", status: "completed" },
          { id: "b", title: "b", status: "completed" },
          { id: "c", title: "c", status: "completed" },
          { id: "d", title: "d", status: "active" },
        ],
      }),
    );
    const after = planProgress(
      plan({
        revision: 2,
        items: [
          { id: "a", title: "a", status: "completed" },
          { id: "b", title: "b", status: "completed" },
          { id: "c", title: "c", status: "completed" },
          { id: "d", title: "d", status: "active" },
          { id: "e", title: "e", status: "pending" },
          { id: "f", title: "f", status: "pending" },
        ],
      }),
    );
    expect(before).toMatchObject({ completed: 3, total: 4 });
    expect(after).toMatchObject({ completed: 3, total: 6 });
    expect(after!.fraction).toBeLessThan(before!.fraction);
  });

  it("is null without a Plan or without effective items — never 0 or a guess", () => {
    expect(planProgress(null)).toBeNull();
    expect(planProgress(undefined)).toBeNull();
    expect(
      planProgress(
        plan({
          items: [
            { id: "a", title: "a", status: "skipped" },
            { id: "b", title: "b", status: "superseded" },
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe("currentPlanItem / currentItemElapsedMinutes (UX-01B boundary ruling)", () => {
  it("prefers the active item, then the first unresolved one", () => {
    expect(currentPlanItem(plan())?.id).toBe("p2");
    expect(
      currentPlanItem(
        plan({
          items: [
            { id: "p1", title: "Collect", status: "completed" },
            { id: "p2", title: "Deliver", status: "unresolved" },
            { id: "p3", title: "Review", status: "pending" },
          ],
        }),
      )?.id,
    ).toBe("p2");
    expect(
      currentPlanItem(plan({ items: [{ id: "p1", title: "Collect", status: "completed" }] })),
    ).toBeNull();
    expect(currentPlanItem(null)).toBeNull();
  });

  it("derives elapsed only from a planItemId-matched Step with a valid startedAt", () => {
    const now = Date.parse("2026-10-12T10:06:30.000Z");
    const current = currentPlanItem(plan());
    // Running matched Step: now - startedAt.
    expect(currentItemElapsedMinutes({ item: current, steps: [planStep()], now })).toBe(6);
    // Completed matched Step: completedAt - startedAt.
    expect(
      currentItemElapsedMinutes({
        item: current,
        steps: [planStep({ status: "completed", completedAt: "2026-10-12T10:04:00.000Z" })],
        now,
      }),
    ).toBe(4);
    // A fraction under one minute is honestly 0 ("under 1 min"), never a fake 1.
    expect(
      currentItemElapsedMinutes({
        item: current,
        steps: [planStep({ startedAt: "2026-10-12T10:06:00.000Z" })],
        now,
      }),
    ).toBe(0);
  });

  it("is null without a matched Step, without startedAt, or with invalid times", () => {
    const now = Date.parse("2026-10-12T10:06:30.000Z");
    const current = currentPlanItem(plan());
    expect(currentItemElapsedMinutes({ item: current, steps: [], now })).toBeNull();
    // A Step of another Plan item never lends its time.
    expect(
      currentItemElapsedMinutes({ item: current, steps: [planStep({ planItemId: "p1" })], now }),
    ).toBeNull();
    // An unlinked Step (planItemId null) never lends its time.
    expect(
      currentItemElapsedMinutes({ item: current, steps: [planStep({ planItemId: null })], now }),
    ).toBeNull();
    expect(
      currentItemElapsedMinutes({ item: current, steps: [planStep({ startedAt: null })], now }),
    ).toBeNull();
    expect(
      currentItemElapsedMinutes({
        item: current,
        steps: [planStep({ startedAt: "not-a-date" as never })],
        now,
      }),
    ).toBeNull();
    expect(currentItemElapsedMinutes({ item: null, steps: [planStep()], now })).toBeNull();
  });

  it("picks the latest matched Step when several exist", () => {
    const now = Date.parse("2026-10-12T10:30:00.000Z");
    const minutes = currentItemElapsedMinutes({
      item: currentPlanItem(plan()),
      steps: [
        planStep({
          stepId: "old",
          startedAt: "2026-10-12T10:00:00.000Z",
          completedAt: "2026-10-12T10:10:00.000Z",
          status: "completed",
        }),
        planStep({ stepId: "new", startedAt: "2026-10-12T10:20:00.000Z" }),
      ],
      now,
    });
    expect(minutes).toBe(10);
  });
});

describe("buildExecutionCardModel Plan integration (UX-01B acceptance 4/5/6)", () => {
  it("carries the single Plan progress and never a Steps-derived one", () => {
    const card = model(run("running"), [], {}, { plan: plan() });
    expect(card.planProgress).toMatchObject({ completed: 1, total: 2, fraction: 1 / 2 });
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("%");
    expect(serialized).not.toContain("--");
  });

  it("has no progress at all without a Plan, even with loaded steps", () => {
    const card = model(run("running"), [], {}, { steps: [planStep()] });
    expect(card.planProgress).toBeNull();
  });

  it("shows the current Plan item line with trusted elapsed minutes", () => {
    const card = model(
      run("running"),
      [activity("Checking ticket")],
      {},
      {
        plan: plan(),
        steps: [planStep()],
        now: Date.parse("2026-10-12T10:06:30.000Z"),
      },
    );
    // The Plan current-item line replaces the raw activity line at level 0.
    expect(card.aux).toEqual({ kind: "current", text: "Current: Deliver result · 6 min elapsed" });
  });

  it("shows the current item without elapsed when no trusted Step time exists", () => {
    const card = model(run("running"), [], {}, { plan: plan() });
    expect(card.aux).toEqual({ kind: "current", text: "Current: Deliver result" });
  });

  it("shows under-1-min elapsed honestly", () => {
    const card = model(
      run("running"),
      [],
      {},
      {
        plan: plan(),
        steps: [planStep({ startedAt: "2026-10-12T10:06:00.000Z" })],
        now: Date.parse("2026-10-12T10:06:30.000Z"),
      },
    );
    expect(card.aux).toEqual({
      kind: "current",
      text: "Current: Deliver result · under 1 min elapsed",
    });
  });

  it("keeps the pending Intervention line ahead of the current item line", () => {
    const card = model(
      run("waiting_input", "approval"),
      [],
      { pendingInterventionKinds: ["approval"] },
      {
        plan: plan(),
        pendingInterventions: [intervention()],
        summary: summary({ status: "waiting_input", waitKind: "approval" }),
      },
    );
    expect(card.aux).toEqual({
      kind: "intervention",
      text: "Send the report to billing@example.com?",
    });
  });

  it("keeps the failure line ahead of the current item line on a failed Run", () => {
    const card = model(
      run("failed"),
      [],
      {},
      {
        plan: plan(),
        summary: summary({ status: "failed", failure: "The billing service timed out" }),
      },
    );
    expect(card.aux?.kind).toBe("failure");
    expect(card.aux?.text).toContain("The billing service timed out");
  });

  it("omits the current item line on terminal Runs", () => {
    const card = model(
      run("completed"),
      [],
      {},
      {
        plan: plan(),
        summary: summary({ outcome: "All done" }),
      },
    );
    expect(card.aux).toEqual({ kind: "outcome", text: "All done" });
  });

  it("carries the localized revision-flash label for the shell timer", () => {
    const card = model(run("running"), [], {}, { plan: plan() });
    expect(card.planUpdatedLabel).toBe("Plan updated");
  });
});

describe("resultHasText", () => {
  it("only accepts a real text block", () => {
    expect(resultHasText(undefined)).toBe(false);
    expect(
      resultHasText({ messageId: "m", blocks: [{ kind: "text", text: "  " }], truncated: false }),
    ).toBe(false);
    expect(
      resultHasText({ messageId: "m", blocks: [{ kind: "text", text: "done" }], truncated: false }),
    ).toBe(true);
  });
});
