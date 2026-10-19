import { t } from "@lingui/core/macro";

export function manualRetryErrorMessage(error: unknown): string {
  const data = (error as { data?: { reason?: unknown } })?.data;
  const nested = (error as { data?: { data?: { reason?: unknown } } })?.data?.data;
  const reason =
    (typeof data?.reason === "string" && data.reason) ||
    (typeof nested?.reason === "string" && nested.reason) ||
    "";
  switch (reason) {
    case "not_found":
    case "forbidden":
    case "thread_cleared":
    case "bot_unavailable":
      return t`This task is no longer available.`;
    case "thread_busy":
      return t`This conversation already has work in progress.`;
    case "completed":
      return t`This task already completed.`;
    case "already_active":
    case "not_terminal":
      return t`This run is still in progress.`;
    case "ineligible_trigger":
    case "not_root":
      return t`This run cannot be retried.`;
    case "nonce_conflict":
      return t`This retry request was already used for a different task.`;
    default:
      return t`Couldn't retry this task. Try again.`;
  }
}
