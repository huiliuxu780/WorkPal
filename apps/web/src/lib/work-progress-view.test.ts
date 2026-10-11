import type { RunStepSnapshot, RunTodoSnapshot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { unlinkedRunTodos } from "./work-progress-view.js";

describe("unlinkedRunTodos", () => {
  it("suppresses only an explicitly linked Todo for a Step in the same Run", () => {
    const base = { runId: "run-1", todoId: "todo-1", linkedStepId: "step-1" } as RunTodoSnapshot;
    const steps = [{ runId: "run-1", stepId: "step-1" }] as RunStepSnapshot[];
    expect(unlinkedRunTodos([base], steps)).toEqual([]);
    expect(unlinkedRunTodos([{ ...base, runId: "run-2" }], steps)).toHaveLength(1);
    expect(unlinkedRunTodos([{ ...base, linkedStepId: null }], steps)).toHaveLength(1);
  });
});
