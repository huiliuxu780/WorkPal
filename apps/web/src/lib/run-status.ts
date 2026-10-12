import { t } from "@lingui/core/macro";
import type { RunActivityRow } from "@rakazo/contracts";

export type RunStatusLike = RunActivityRow["status"];

const ACTIVE_RUN_STATUSES: readonly RunStatusLike[] = [
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
];

export function isRunActive(status: RunStatusLike): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

export function runStatusLabel(status: RunStatusLike): string {
  switch (status) {
    case "queued":
      return t`Queued`;
    case "leased":
      return t`Starting`;
    case "running":
      return t`Running`;
    case "waiting_input":
      return t`Needs input`;
    case "waiting_takeover":
      return t`Needs takeover`;
    case "completed":
      return t`Done`;
    case "failed":
      return t`Failed`;
    case "cancelled":
      return t`Cancelled`;
    default:
      return status;
  }
}

export type RunStatusTone = "success" | "warning" | "destructive" | "muted" | "neutral";

export function runStatusTone(status: RunStatusLike): RunStatusTone {
  if (status === "failed") return "destructive";
  if (status === "cancelled") return "muted";
  if (status === "completed") return "success";
  if (status === "waiting_input" || status === "waiting_takeover") return "warning";
  return "neutral";
}

export function runStatusTextClass(status: RunStatusLike): string {
  switch (runStatusTone(status)) {
    case "destructive":
      return "text-destructive";
    case "muted":
      return "text-muted-foreground";
    case "success":
      return "text-success";
    case "warning":
      return "text-warning";
    default:
      return "text-foreground";
  }
}

/** Status pill recipe: 15% translucent tone background + same-color text. */
export function runStatusPillClass(status: RunStatusLike): string {
  switch (runStatusTone(status)) {
    case "destructive":
      return "bg-destructive/15 text-destructive";
    case "muted":
      return "bg-muted-foreground/15 text-muted-foreground";
    case "success":
      return "bg-success/15 text-success";
    case "warning":
      return "bg-warning/15 text-warning";
    default:
      return "bg-foreground/10 text-foreground";
  }
}
