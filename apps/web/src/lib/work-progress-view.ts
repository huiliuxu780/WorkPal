import type { RunStepSnapshot, RunTodoSnapshot } from "@rakazo/contracts";

/** Only an explicit same-Run link suppresses a duplicate Todo row. */
export function unlinkedRunTodos(
  todos: readonly RunTodoSnapshot[],
  steps: readonly RunStepSnapshot[],
): RunTodoSnapshot[] {
  const stepKeys = new Set(steps.map((step) => `${step.runId}\u0000${step.stepId}`));
  return todos.filter(
    (todo) => !todo.linkedStepId || !stepKeys.has(`${todo.runId}\u0000${todo.linkedStepId}`),
  );
}
