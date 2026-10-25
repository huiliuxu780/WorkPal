import { describe, expect, it } from "vitest";
import {
  type AmendmentTargetFact,
  decideMessageRoute,
  isSteerableChatRun,
  type SteeringCandidate,
} from "./message-routing.js";

const candidate = (
  runId: string,
  overrides: Partial<SteeringCandidate> = {},
): SteeringCandidate => ({
  runId,
  taskId: `task-${runId}`,
  botId: "bot-a",
  status: "running",
  trigger: "user",
  ...overrides,
});

const amendableTarget = (overrides: Partial<AmendmentTargetFact> = {}): AmendmentTargetFact => ({
  taskId: "task-1",
  botId: "bot-a",
  amendable: true,
  ...overrides,
});

describe("isSteerableChatRun", () => {
  it("accepts open conversational turns only", () => {
    expect(isSteerableChatRun({ status: "queued", trigger: "user" })).toBe(true);
    expect(isSteerableChatRun({ status: "leased", trigger: "follow_up" })).toBe(true);
    expect(isSteerableChatRun({ status: "running", trigger: "messaging" })).toBe(true);
    expect(isSteerableChatRun({ status: "waiting_takeover", trigger: "bot_message" })).toBe(true);
  });

  it("rejects waiting asks, terminal Runs, and non-conversational turns", () => {
    expect(isSteerableChatRun({ status: "waiting_input", trigger: "user" })).toBe(false);
    expect(isSteerableChatRun({ status: "completed", trigger: "user" })).toBe(false);
    expect(isSteerableChatRun({ status: "failed", trigger: "user" })).toBe(false);
    expect(isSteerableChatRun({ status: "cancelled", trigger: "user" })).toBe(false);
    expect(isSteerableChatRun({ status: "running", trigger: "routine" })).toBe(false);
    expect(isSteerableChatRun({ status: "running", trigger: "webhook" })).toBe(false);
    expect(isSteerableChatRun({ status: "running", trigger: "created" })).toBe(false);
    expect(isSteerableChatRun({ status: "running", trigger: "delivery" })).toBe(false);
    expect(isSteerableChatRun({ status: "unknown", trigger: "user" })).toBe(false);
  });
});

describe("decideMessageRoute", () => {
  it("steers the only eligible candidate", () => {
    expect(
      decideMessageRoute({
        botId: "bot-a",
        candidates: [candidate("run-1")],
      }),
    ).toEqual({
      kind: "steer_existing_run",
      runId: "run-1",
      taskId: "task-run-1",
      botId: "bot-a",
    });
  });

  it("creates an independent run for two candidates instead of choosing one", () => {
    const decision = decideMessageRoute({
      botId: "bot-a",
      candidates: [candidate("run-1"), candidate("run-2")],
    });
    expect(decision).toEqual({
      kind: "create_independent_run",
      botId: "bot-a",
      reason: "multiple_steerable_candidates",
    });
    expect(JSON.stringify(decision)).not.toContain("run-1");
  });

  it("returns the same decision when database order reverses", () => {
    const forward = decideMessageRoute({
      botId: "bot-a",
      candidates: [candidate("run-1"), candidate("run-2"), candidate("run-3")],
    });
    const reversed = decideMessageRoute({
      botId: "bot-a",
      candidates: [candidate("run-3"), candidate("run-2"), candidate("run-1")],
    });
    expect(reversed).toEqual(forward);
    const singleForward = decideMessageRoute({
      botId: "bot-a",
      candidates: [candidate("run-1"), candidate("run-off", { status: "completed" })],
    });
    const singleReversed = decideMessageRoute({
      botId: "bot-a",
      candidates: [candidate("run-off", { status: "completed" }), candidate("run-1")],
    });
    expect(singleReversed).toEqual(singleForward);
    expect(singleForward).toMatchObject({ runId: "run-1" });
  });

  it("ignores duplicate rows for the same Run", () => {
    expect(
      decideMessageRoute({
        botId: "bot-a",
        candidates: [candidate("run-1"), candidate("run-1")],
      }),
    ).toMatchObject({ kind: "steer_existing_run", runId: "run-1" });
  });

  it("creates an independent run when nothing can take steering", () => {
    expect(decideMessageRoute({ botId: "bot-a", candidates: [] })).toEqual({
      kind: "create_independent_run",
      botId: "bot-a",
      reason: "no_steerable_candidate",
    });
    expect(
      decideMessageRoute({
        botId: "bot-a",
        candidates: [
          candidate("run-routine", { trigger: "routine" }),
          candidate("run-webhook", { trigger: "webhook" }),
          candidate("run-waiting", { status: "waiting_input" }),
        ],
      }),
    ).toEqual({
      kind: "create_independent_run",
      botId: "bot-a",
      reason: "no_steerable_candidate",
    });
  });

  it("never steers a Run of a different Bot", () => {
    expect(
      decideMessageRoute({
        botId: "bot-a",
        candidates: [candidate("run-b", { botId: "bot-b" })],
      }),
    ).toEqual({
      kind: "create_independent_run",
      botId: "bot-a",
      reason: "no_steerable_candidate",
    });
  });

  it("amends exactly the explicitly addressed Task", () => {
    expect(
      decideMessageRoute({
        botId: "bot-a",
        explicitTargetTaskId: "task-1",
        amendmentTarget: amendableTarget(),
        candidates: [candidate("run-1")],
      }),
    ).toEqual({ kind: "amend_target_task", taskId: "task-1", botId: "bot-a" });
  });

  it("rejects an explicit Task that is missing, foreign, or of another Bot", () => {
    expect(
      decideMessageRoute({
        botId: "bot-a",
        explicitTargetTaskId: "task-1",
        amendmentTarget: null,
        candidates: [candidate("run-1")],
      }),
    ).toEqual({ kind: "reject", code: "target_task_not_found" });
    expect(
      decideMessageRoute({
        botId: "bot-a",
        explicitTargetTaskId: "task-1",
        amendmentTarget: amendableTarget({ taskId: "task-other" }),
        candidates: [candidate("run-1")],
      }),
    ).toEqual({ kind: "reject", code: "target_task_not_found" });
    expect(
      decideMessageRoute({
        botId: "bot-a",
        explicitTargetTaskId: "task-1",
        amendmentTarget: amendableTarget({ botId: "bot-b" }),
        candidates: [candidate("run-1")],
      }),
    ).toEqual({ kind: "reject", code: "target_task_not_found" });
  });

  it("rejects a Task that cannot take an amendment instead of creating a new one", () => {
    expect(
      decideMessageRoute({
        botId: "bot-a",
        explicitTargetTaskId: "task-1",
        amendmentTarget: amendableTarget({ amendable: false }),
        candidates: [],
      }),
    ).toEqual({ kind: "reject", code: "target_task_not_amendable" });
  });
});
