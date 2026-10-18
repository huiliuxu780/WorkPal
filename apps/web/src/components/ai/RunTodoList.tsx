import { t } from "@lingui/core/macro";
import type { RunTodoSnapshot } from "@rakazo/contracts";
import { memo } from "react";

/**
 * The legacy Todo fallback ("事项清单", UX-01C acceptance 16).
 *
 * Renders ONLY inside an already-legal execution surface whose expanded data
 * has neither a structured Plan nor semantic Steps, and only while expanded
 * (the caller gates on the fixed degradation order Plan → Steps → 事项清单).
 * User-visible copy never says "Todo"/"待办" and never carries a count,
 * fraction or bar — this is old-data context, not progress.
 */

const marks: Record<RunTodoSnapshot["status"], string> = {
  pending: "○",
  active: "●",
  resolved: "✓",
  deferred: "–",
};
const labels: Record<RunTodoSnapshot["status"], () => string> = {
  pending: () => t`Pending`,
  active: () => t`In progress`,
  resolved: () => t`Resolved`,
  deferred: () => t`Deferred`,
};

export const RunTodoList = memo(function RunTodoList({
  todos,
}: {
  todos: readonly RunTodoSnapshot[];
}) {
  if (todos.length === 0) return null;
  const ordered = [...todos].sort(
    (left, right) => left.order - right.order || left.todoId.localeCompare(right.todoId),
  );
  return (
    <section
      data-slot="todos"
      className="ms-1 my-2 border-s border-border ps-4 text-[13px] text-foreground/85"
    >
      <h3 className="py-2 text-xs font-medium text-muted-foreground">{t`Work items`}</h3>
      <p dir="auto" className="pb-2 text-xs text-muted-foreground">
        {t`This run has no plan. These were the working items at the time.`}
      </p>
      <ul className="space-y-1.5 pb-2">
        {ordered.map((todo) => (
          <li
            key={`${todo.runId}:${todo.todoId}`}
            data-todo-id={todo.todoId}
            data-todo-status={todo.status}
            className="flex min-w-0 items-start gap-2"
          >
            <span aria-hidden="true" className="w-3 shrink-0 text-center">
              {marks[todo.status]}
            </span>
            <span dir="auto" className="min-w-0 flex-1">
              {todo.title}
              {todo.reason ? (
                <span className="block text-xs text-muted-foreground">{todo.reason}</span>
              ) : null}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{labels[todo.status]()}</span>
          </li>
        ))}
      </ul>
    </section>
  );
});
