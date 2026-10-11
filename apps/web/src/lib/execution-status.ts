import { i18n } from "@lingui/core";
import type { ActivityItem, Run } from "@rakazo/contracts";

export type ExecutionDisplayStatus =
  | "planning"
  | "working"
  | "background"
  | "approval"
  | "need_input"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled"
  | "unknown";

export type ExecutionStatusView = {
  status: ExecutionDisplayStatus;
  label: string;
  detail: string | null;
  needsAttention: boolean;
};

/** A display projection of the root Run, never a second lifecycle state machine. */
export function deriveExecutionStatus(
  run: Run | null | undefined,
  activity: readonly ActivityItem[],
  options: { confirmedRootBackground?: boolean } = {},
): ExecutionStatusView {
  if (!run) {
    return { status: "unknown", label: i18n._("Status unknown"), detail: null, needsAttention: false };
  }
  const own = activity.filter((item) => item.runId === run.id);
  const current = [...own]
    .reverse()
    .find((item) => item.status === "running" || item.status === "waiting");
  const summary = current?.title?.trim() || null;
  const background = options.confirmedRootBackground === true;
  const view = (
    status: ExecutionDisplayStatus,
    label: string,
    detail: string | null = null,
    needsAttention = false,
  ): ExecutionStatusView => ({ status, label, detail, needsAttention });

  // Run terminal state wins over a stale waiting or planning activity row.
  if (run.status === "completed") return view("done", i18n._("Execution completed"), background ? i18n._("Background task") : null);
  if (run.status === "failed")
    return view("failed", i18n._("Execution failed"), background ? i18n._("Background task") : null);
  if (run.status === "cancelled")
    return view("cancelled", i18n._("Stopped"), background ? i18n._("Background task") : null);
  if (run.status === "waiting_input") {
    if (run.waitKind === "approval")
      return view("approval", i18n._("Waiting for approval"), summary, true);
    return view("need_input", i18n._("Waiting for your reply"), summary, true);
  }
  if (run.status === "waiting_takeover")
    return view("blocked", i18n._("Temporarily blocked"), i18n._("Waiting for you to take control"), true);

  // A child BackgroundAgentTask does not make its parent Run a background Run.
  if (background) {
    return run.status === "queued"
      ? view("background", i18n._("Background task"), i18n._("Waiting to start"))
      : view("background", i18n._("Running in background"), summary);
  }
  if (run.status === "queued") return view("working", i18n._("Waiting to start"), summary);
  if (run.status === "leased") return view("working", i18n._("Starting"), summary);
  if (current?.kind === "planning") return view("planning", i18n._("Planning"), summary);
  return view("working", i18n._("Executing"), summary);
}
