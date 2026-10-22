import type {
  ExecutionSnapshot,
  ExecutionSummary,
  InterventionView,
  Run,
  RunPlanRevision,
  RunStepSnapshot,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { installExecutionDetail } from "./execution-history";
import { eligibleExecutionRunIds, shouldRenderExecutionSurface } from "./execution-surface";

/**
 * UX-01B core rule 1: the Execution surface exists if and only if a Run has
 * a structured Plan, a semantic Step, a pending Intervention, or has failed.
 * Todos, tool Activity, message steps blocks and plain running states never
 * create one on their own.
 */

const ISO = "2026-10-12T00:00:00.000Z";

function summary(overrides: Partial<ExecutionSummary> = {}): ExecutionSummary {
  return {
    runId: "run-1",
    threadId: "thread-1",
    botId: "bot-1",
    rev: 5,
    status: "completed",
    trigger: "user",
    title: "Analyze",
    updatedAt: ISO,
    artifacts: [],
    entry: "execution",
    ...overrides,
  };
}

function run(id: string, status: Run["status"]): Pick<Run, "id" | "status" | "waitKind"> {
  return { id, status, waitKind: null };
}

function plan(runId: string, overrides: Partial<RunPlanRevision> = {}): RunPlanRevision {
  return {
    planId: `plan-${runId}`,
    runId,
    sourceMessageId: null,
    revisionId: `plan-${runId}-1`,
    revision: 1,
    goal: "Deliver the report",
    items: [{ id: "p1", title: "Collect", status: "completed" }],
    changeReason: null,
    createdAt: ISO,
    ...overrides,
  };
}

function step(runId: string, stepId: string, overrides: Partial<RunStepSnapshot> = {}): RunStepSnapshot {
  return {
    stepId,
    runId,
    sourceMessageId: null,
    revision: 1,
    order: 0,
    title: "Collect data",
    status: "completed",
    resultSummary: null,
    planItemId: null,
    parentStepId: null,
    attemptId: null,
    attemptNumber: null,
    startedAt: ISO,
    completedAt: ISO,
    evidence: [],
    batch: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function intervention(overrides: Partial<InterventionView> = {}): InterventionView {
  return {
    id: "iv-1",
    revision: 1,
    kind: "approval",
    status: "pending",
    spaceId: "space-1",
    threadId: "thread-1",
    runId: "run-1",
    attemptId: "attempt-1",
    botId: "bot-1",
    messageId: "m-1",
    createdAt: ISO,
    requestingActor: { botId: "bot-1" },
    presentation: { text: "Send it?" },
    ...overrides,
  } as InterventionView;
}

function detailSnapshot(overrides: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    summary: summary(),
    steps: { items: [], truncated: false },
    todos: { items: [], truncated: false },
    timeline: [],
    activityPage: { items: [], olderCursor: null, truncated: false },
    interventions: [],
    ...overrides,
  } as ExecutionSnapshot;
}

describe("shouldRenderExecutionSurface", () => {
  const none = {
    hasPlan: false,
    hasSemanticSteps: false,
    hasPendingIntervention: false,
    failed: false,
  };

  it("is false when none of the four conditions hold", () => {
    expect(shouldRenderExecutionSurface(none)).toBe(false);
  });

  it("is true for a structured Plan alone", () => {
    expect(shouldRenderExecutionSurface({ ...none, hasPlan: true })).toBe(true);
  });

  it("is true for semantic Steps alone — even a single Step", () => {
    expect(shouldRenderExecutionSurface({ ...none, hasSemanticSteps: true })).toBe(true);
  });

  it("is true for a pending Intervention alone", () => {
    expect(shouldRenderExecutionSurface({ ...none, hasPendingIntervention: true })).toBe(true);
  });

  it("is true for a failed Run alone", () => {
    expect(shouldRenderExecutionSurface({ ...none, failed: true })).toBe(true);
  });
});

describe("eligibleExecutionRunIds", () => {
  const base = {
    runs: [] as Pick<Run, "id" | "status" | "waitKind">[],
    plans: [] as RunPlanRevision[],
    steps: [] as RunStepSnapshot[],
    serverSummaries: null as Map<string, ExecutionSummary> | null,
    executionDetails: {},
    interventions: [] as InterventionView[],
  };

  it("includes a Run with a structured Plan", () => {
    const ids = eligibleExecutionRunIds({
      ...base,
      plans: [plan("run-plan")],
      serverSummaries: new Map([["run-plan", summary({ runId: "run-plan" })]]),
    });
    expect(ids.has("run-plan")).toBe(true);
  });

  it("includes a Run with a single semantic Step", () => {
    const ids = eligibleExecutionRunIds({
      ...base,
      steps: [step("run-step", "s1")],
      serverSummaries: new Map([["run-step", summary({ runId: "run-step" })]]),
    });
    expect(ids.has("run-step")).toBe(true);
  });

  it("includes a Run whose summary counts semantic Steps not yet loaded", () => {
    const ids = eligibleExecutionRunIds({
      ...base,
      serverSummaries: new Map([
        ["run-counted", summary({ runId: "run-counted", counts: { steps: 2, actions: 9 } })],
      ]),
    });
    expect(ids.has("run-counted")).toBe(true);
  });

  it("includes a Run with a pending Intervention view", () => {
    const ids = eligibleExecutionRunIds({
      ...base,
      interventions: [intervention({ runId: "run-iv" })],
      serverSummaries: new Map([["run-iv", summary({ runId: "run-iv", status: "waiting_input" })]]),
    });
    expect(ids.has("run-iv")).toBe(true);
  });

  it("includes a Run that executes in another Thread and projects only its Intervention", () => {
    // RT-04 / AC20: the answering Thread holds no Run row and no summary for the
    // executing Run — `loadExecutionSummaries` is Thread-scoped — so the pending
    // projection is the only signal that can earn the card a surface here.
    const ids = eligibleExecutionRunIds({
      ...base,
      interventions: [intervention({ runId: "run-in-pair-thread" })],
    });
    expect(ids.has("run-in-pair-thread")).toBe(true);
    // Once settled it no longer earns one: a finished foreign execution has no
    // surface in a Thread that never ran it.
    const settled = eligibleExecutionRunIds({
      ...base,
      interventions: [intervention({ runId: "run-in-pair-thread", status: "answered" })],
    });
    expect(settled.has("run-in-pair-thread")).toBe(false);
  });

  it("includes a waiting Run even before its Intervention projection arrives", () => {
    const ids = eligibleExecutionRunIds({
      ...base,
      runs: [run("run-waiting", "waiting_input")],
      serverSummaries: new Map([
        ["run-waiting", summary({ runId: "run-waiting", status: "waiting_input" })],
      ]),
    });
    expect(ids.has("run-waiting")).toBe(true);
  });

  it("includes a waiting_takeover Run", () => {
    const ids = eligibleExecutionRunIds({
      ...base,
      runs: [run("run-takeover", "waiting_takeover")],
    });
    expect(ids.has("run-takeover")).toBe(true);
  });

  it("includes a failed Run from summary status alone", () => {
    const ids = eligibleExecutionRunIds({
      ...base,
      serverSummaries: new Map([["run-failed", summary({ runId: "run-failed", status: "failed" })]]),
    });
    expect(ids.has("run-failed")).toBe(true);
  });

  it("includes a failed legacy Run without any summary", () => {
    const ids = eligibleExecutionRunIds({ ...base, runs: [run("run-legacy", "failed")] });
    expect(ids.has("run-legacy")).toBe(true);
  });

  it("excludes a completed plain Run whose summary carries only action counts", () => {
    const ids = eligibleExecutionRunIds({
      ...base,
      serverSummaries: new Map([
        ["run-plain", summary({ runId: "run-plain", counts: { actions: 12, agents: 1 } })],
      ]),
    });
    expect(ids.has("run-plain")).toBe(false);
  });

  it("excludes an active plain Run (lightweight status territory)", () => {
    const ids = eligibleExecutionRunIds({
      ...base,
      runs: [run("run-active", "running")],
      serverSummaries: new Map([["run-active", summary({ runId: "run-active", status: "running" })]]),
    });
    expect(ids.has("run-active")).toBe(false);
  });

  it("excludes a completed Run whose only Interventions are settled", () => {
    const ids = eligibleExecutionRunIds({
      ...base,
      interventions: [intervention({ runId: "run-settled", status: "answered" })],
      serverSummaries: new Map([["run-settled", summary({ runId: "run-settled" })]]),
    });
    expect(ids.has("run-settled")).toBe(false);
  });

  it("reads a Plan from a loaded detail snapshot", () => {
    const snapshot = detailSnapshot({
      summary: summary({ runId: "run-detail", rev: 7 }),
      plan: plan("run-detail"),
    });
    const ids = eligibleExecutionRunIds({
      ...base,
      serverSummaries: new Map([["run-detail", summary({ runId: "run-detail", rev: 7 })]]),
      executionDetails: installExecutionDetail({}, "run-detail", snapshot),
    });
    expect(ids.has("run-detail")).toBe(true);
  });

  it("ignores a stale cached detail whose rev fell behind the summary", () => {
    const snapshot = detailSnapshot({
      summary: summary({ runId: "run-stale", rev: 3 }),
      plan: plan("run-stale"),
    });
    const ids = eligibleExecutionRunIds({
      ...base,
      serverSummaries: new Map([["run-stale", summary({ runId: "run-stale", rev: 9 })]]),
      executionDetails: installExecutionDetail({}, "run-stale", snapshot),
    });
    expect(ids.has("run-stale")).toBe(false);
  });

  it("prefers detail steps over thread-level arrays like the render path", () => {
    // The thread-level array still lists a step of another Run; the detail of
    // this Run is authoritative and empty, and the summary counts no steps.
    const snapshot = detailSnapshot({
      summary: summary({ runId: "run-d", rev: 5 }),
      steps: { items: [], truncated: false },
    });
    const ids = eligibleExecutionRunIds({
      ...base,
      steps: [step("run-other", "sx")],
      serverSummaries: new Map([
        ["run-d", summary({ runId: "run-d", rev: 5 })],
        ["run-other", summary({ runId: "run-other", rev: 5 })],
      ]),
      executionDetails: installExecutionDetail({}, "run-d", snapshot),
    });
    expect(ids.has("run-d")).toBe(false);
    expect(ids.has("run-other")).toBe(true);
  });
});
