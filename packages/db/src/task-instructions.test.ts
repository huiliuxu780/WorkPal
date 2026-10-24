import { describe, expect, it } from "vitest";
import { decideTaskAmendment } from "./task-instructions.js";

const task = { id: "task-1", revision: 1, status: "queued" };
const amendmentRef = { taskId: "task-1", consumedRevision: 2 };

describe("Task amendment state decision", () => {
  it.each([
    ["queued", null, "queued_update_only"],
    ["queued", 1, "active_steering"],
    ["leased", null, "active_steering"],
    ["running", 1, "active_steering"],
    ["waiting_input", 1, "active_steering"],
    ["waiting_takeover", 1, "active_steering"],
  ])("maps %s with consumed revision %s to %s", (status, consumedRevision, expected) => {
    expect(
      decideTaskAmendment({
        task,
        targetRun: { id: "run-1", status, consumedRevision },
        amendmentRef,
      }).kind,
    ).toBe(expected);
  });

  it.each([
    ["completed", "completed", "completed_follow_up"],
    ["failed", "failed", "failed_record_only"],
    ["cancelled", "cancelled", "cancelled_record_only"],
  ])("maps terminal %s without reviving it", (runStatus, taskStatus, expected) => {
    expect(
      decideTaskAmendment({
        task: { ...task, status: taskStatus },
        targetRun: { id: "run-1", status: runStatus, consumedRevision: 1 },
        amendmentRef,
        followUpRunId: "run-follow-up",
      }).kind,
    ).toBe(expected);
  });

  it("fails closed for missing, unknown and incoherent state", () => {
    expect(decideTaskAmendment({ task: null, targetRun: null, amendmentRef }).kind).toBe(
      "not_found",
    );
    expect(
      decideTaskAmendment({
        task,
        targetRun: { id: "run-1", status: "future_state", consumedRevision: null },
        amendmentRef,
      }),
    ).toEqual({ kind: "conflict", reason: "unknown_run_status" });
    expect(
      decideTaskAmendment({
        task: { ...task, status: "completed" },
        targetRun: { id: "run-1", status: "running", consumedRevision: 1 },
        amendmentRef,
      }),
    ).toEqual({ kind: "conflict", reason: "task_run_status_mismatch" });
  });
});
