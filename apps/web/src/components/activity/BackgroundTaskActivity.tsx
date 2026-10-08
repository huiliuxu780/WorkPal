import { t } from "@lingui/core/macro";
import type { ActivityItem } from "@rakazo/contracts";

/**
 * Phase 4 background task cards (§14/§38/§45). These outlive the parent run
 * and survive refreshes because they project from durable BackgroundAgentTask
 * rows. Cancel calls the existing runtime endpoint through the caller — no new
 * execution logic. Completed cards carry no cancel control.
 */

const STATUS_GLYPH: Record<ActivityItem["status"], string> = {
  pending: "◷",
  running: "◷",
  waiting: "!",
  completed: "✓",
  failed: "×",
  cancelled: "–",
};

export function BackgroundTaskActivity({
  items,
  onCancel,
}: {
  items: readonly ActivityItem[];
  onCancel?: (taskId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 py-1" data-testid="background-tasks">
      {items.map((item) => (
        <div
          key={item.id}
          data-testid="background-task-card"
          data-status={item.status}
          className="flex items-center gap-2 rounded-lg border border-border bg-card/40 px-2.5 py-1.5 text-[13px] text-muted-foreground"
        >
          <span
            aria-hidden
            className={
              item.status === "running"
                ? "w-4 shrink-0 text-center text-warning"
                : item.status === "failed"
                  ? "w-4 shrink-0 text-center text-destructive"
                  : "w-4 shrink-0 text-center"
            }
          >
            {STATUS_GLYPH[item.status]}
          </span>
          <div className="min-w-0 flex-1">
            <div dir="auto" className="truncate">
              {item.title}
            </div>
            {item.detail ? (
              <div dir="auto" className="truncate text-xs opacity-70">
                {item.detail}
              </div>
            ) : null}
          </div>
          {item.taskId && onCancel ? (
            <button
              type="button"
              data-testid="background-task-cancel"
              onClick={() => onCancel(item.taskId!)}
              className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-foreground/75 transition-colors hover:bg-accent"
            >
              {t`Cancel`}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
