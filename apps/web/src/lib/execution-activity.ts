import { i18n } from "@lingui/core";
import type { ActivityItem, Run } from "@rakazo/contracts";
import { foldAdjacentTools, windowActivity } from "@rakazo/core";

export type ExecutionActivityView = {
  primary: string | null;
  note: string | null;
  recent: ActivityItem[];
  hiddenCount: number;
};

/** Present the existing event projection; never infer a Run transition from an activity row. */
export function selectExecutionActivity(
  run: Pick<Run, "id" | "status"> | null,
  items: readonly ActivityItem[],
): ExecutionActivityView {
  if (!run) {
    const { visible, hiddenCount } = windowActivity(foldAdjacentTools(items), 6);
    return { primary: null, note: null, recent: visible, hiddenCount };
  }
  const own = items.filter((item) => item.runId === run.id);
  const terminal = ["completed", "failed", "cancelled"].includes(run.status);
  const waiting = run.status === "waiting_input" || run.status === "waiting_takeover";
  const active = run.status === "running" || run.status === "leased";
  let primary: string | null = null;
  let primaryId: string | null = null;
  let note: string | null = null;

  if (waiting) {
    const currentWait = [...own].reverse().find((item) => item.status === "waiting");
    primary = currentWait?.title?.trim() || null;
    primaryId = currentWait?.id ?? null;
    note = i18n._("Activity paused while waiting for you");
  } else if (active) {
    const current = own.filter((item) => item.status === "running");
    if (current.length === 1) {
      primary = current[0]?.title?.trim() || null;
      primaryId = current[0]?.id ?? null;
    } else if (current.length > 1) {
      primary = i18n._("Multiple activities in progress");
    } else if (run.status === "running") {
      note = i18n._("Execution continues; no new activity update");
    }
  }

  if (terminal && own.some((item) => item.status === "running" || item.status === "waiting")) {
    note = i18n._("Some activity statuses have not synchronized");
  }
  // Paused, queued and terminal Runs may retain old running rows in the bounded
  // projection. Omit them rather than presenting them as current or complete.
  const recentSource = own.filter(
    (item) =>
      item.id !== primaryId && (active || (item.status !== "running" && item.status !== "waiting")),
  );
  const folded = foldAdjacentTools(recentSource);
  const { visible, hiddenCount } = windowActivity(folded, 6);
  return { primary, note, recent: visible, hiddenCount };
}
