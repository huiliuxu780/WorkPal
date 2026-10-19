import { i18n } from "@lingui/core";
import type { ActivityItem, Run } from "@rakazo/contracts";

export type ExecutionDisplayStatus =
  | "planning"
  | "working"
  | "background"
  | "approval"
  | "need_input"
  | "blocked"
  | "takeover"
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

export type ExecutionRunState = Pick<Run, "id" | "status" | "waitKind">;

/** A display projection of the root Run, never a second lifecycle state machine. */
export function deriveExecutionStatus(
  run: ExecutionRunState | null | undefined,
  activity: readonly ActivityItem[],
  options: {
    confirmedRootBackground?: boolean;
    blockedReason?: string | null;
    /**
     * Pending Intervention kinds for this Run. When omitted, waitKind stays
     * the header source so older snapshots keep their current labels.
     */
    pendingInterventionKinds?: readonly ("approval" | "input" | "plan_review")[];
  } = {},
): ExecutionStatusView {
  if (!run) {
    return {
      status: "unknown",
      label: i18n._("Status unknown"),
      detail: null,
      needsAttention: false,
    };
  }
  const own = activity.filter((item) => item.runId === run.id);
  const current = [...own].reverse().find((item) => item.status === "running");
  const waiting = [...own].reverse().find((item) => item.status === "waiting");
  const summary = current?.title?.trim() || null;
  const background = options.confirmedRootBackground === true;
  const view = (
    status: ExecutionDisplayStatus,
    label: string,
    detail: string | null = null,
    needsAttention = false,
  ): ExecutionStatusView => ({ status, label, detail, needsAttention });

  // Run terminal state wins over a stale waiting or planning activity row.
  if (run.status === "completed")
    return view(
      "done",
      i18n._("Execution completed"),
      background ? i18n._("Background task") : null,
    );
  if (run.status === "failed")
    return view(
      "failed",
      i18n._("Execution failed"),
      background ? i18n._("Background task") : null,
    );
  if (run.status === "cancelled")
    return view("cancelled", i18n._("Stopped"), background ? i18n._("Background task") : null);
  if (run.status === "waiting_input") {
    const kinds = options.pendingInterventionKinds;
    if (kinds) {
      // UX-02: a pending plan review is a decision wait with its own label;
      // it renders on the approval rail (needsAttention, diamond, Handle now).
      if (kinds.includes("plan_review"))
        return view(
          "approval",
          i18n._("Waiting for plan review"),
          waiting?.title?.trim() || null,
          true,
        );
      if (kinds.includes("approval"))
        return view(
          "approval",
          i18n._("Waiting for approval"),
          waiting?.title?.trim() || null,
          true,
        );
      if (kinds.includes("input"))
        return view(
          "need_input",
          i18n._("Waiting for your reply"),
          waiting?.title?.trim() || null,
          true,
        );
      return view("unknown", i18n._("Status unknown"), null, true);
    }
    if (run.waitKind === "approval")
      return view("approval", i18n._("Waiting for approval"), waiting?.title?.trim() || null, true);
    if (run.waitKind === "input")
      return view(
        "need_input",
        i18n._("Waiting for your reply"),
        waiting?.title?.trim() || null,
        true,
      );
    return view("unknown", i18n._("Status unknown"), null, true);
  }
  if (run.status === "waiting_takeover")
    return view(
      "takeover",
      i18n._("Waiting for takeover"),
      i18n._("Open the computer to take control"),
      true,
    );
  if (options.blockedReason?.trim())
    return view("blocked", i18n._("Temporarily blocked"), options.blockedReason.trim(), true);

  // A child BackgroundAgentTask does not make its parent Run a background Run.
  if (background) {
    return run.status === "queued"
      ? view("background", i18n._("Background task"), i18n._("Waiting to start"))
      : view("background", i18n._("Running in background"), summary);
  }
  if (run.status === "queued") return view("unknown", i18n._("Execution queued"));
  if (run.status === "leased") return view("working", i18n._("Executing"), i18n._("Starting"));
  if (current?.kind === "planning") return view("planning", i18n._("Planning"), summary);
  return view("working", i18n._("Executing"), summary);
}
