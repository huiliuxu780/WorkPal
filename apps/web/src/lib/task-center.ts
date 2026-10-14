import { t } from "@lingui/core/macro";
import type { TaskCenterItem, TaskCenterPage } from "@rakazo/contracts";
import type { ExecutionStatusView } from "./execution-status";

/**
 * Task Center Web logic — the cross-conversation SECOND ENTRY to existing
 * Runs. Everything here is list coordination and presentation mapping over
 * the server's authoritative page: no second status matrix (the card reuses
 * `deriveExecutionStatus`), no percentage (production has no trusted
 * processed/total source, so it is never rendered), and no new lifecycle.
 *
 * The navigation handoff is module memory only: no Run id ever reaches a new
 * browser-storage key, a DOM attribute or the URL (the anchor deep link uses
 * the existing `?m=` message param).
 */

export const TASK_CENTER_PAGE_LIMIT = 30;

export type TaskCenterListState = {
  items: TaskCenterItem[];
  nextCursor: string | null;
  activeCount: number;
  /** Monotonic id of the latest applied response; stale responses never regress the list. */
  appliedRequest: number;
  /** Bumped by every applied refresh; appends only merge into the list they were requested against. */
  epoch: number;
};

export const emptyTaskCenterList: TaskCenterListState = {
  items: [],
  nextCursor: null,
  activeCount: 0,
  appliedRequest: 0,
  epoch: 0,
};

/**
 * Apply a first-page refresh. The response is the authoritative window, so
 * items it no longer carries drop out (cleared or archived Runs disappear);
 * for a Run present on both sides the higher `rev` wins, so a late duplicate
 * can never regress a newer summary. A response older than the last applied
 * one (out-of-order or repeated) is discarded whole.
 */
export function applyTaskCenterRefresh(
  state: TaskCenterListState,
  page: TaskCenterPage,
  requestId: number,
): TaskCenterListState {
  if (requestId <= state.appliedRequest) return state;
  const byRun = new Map(state.items.map((item) => [item.summary.runId, item]));
  const items = page.items.map((item) => {
    const existing = byRun.get(item.summary.runId);
    return existing && existing.summary.rev > item.summary.rev ? existing : item;
  });
  return {
    items,
    nextCursor: page.nextCursor,
    activeCount: page.activeCount,
    appliedRequest: requestId,
    epoch: state.epoch + 1,
  };
}

/**
 * Append a load-more page: dedupe by runId with the higher `rev` winning and
 * no Run ever appearing twice. The append is discarded when a refresh landed
 * while it was in flight (epoch moved) — a stale page must not re-add items
 * the fresh authoritative window already dropped.
 */
export function applyTaskCenterAppend(
  state: TaskCenterListState,
  page: TaskCenterPage,
  requestId: number,
  requestEpoch: number,
): TaskCenterListState {
  if (requestId <= state.appliedRequest || requestEpoch !== state.epoch) return state;
  const items = [...state.items];
  const indexOf = new Map(items.map((item, index) => [item.summary.runId, index]));
  for (const item of page.items) {
    const index = indexOf.get(item.summary.runId);
    if (index === undefined) {
      indexOf.set(item.summary.runId, items.length);
      items.push(item);
      continue;
    }
    if (item.summary.rev > items[index]!.summary.rev) items[index] = item;
  }
  return {
    items,
    nextCursor: page.nextCursor,
    activeCount: page.activeCount,
    appliedRequest: requestId,
    epoch: state.epoch,
  };
}

/**
 * The Task Center primary-action verb. A presentation mapping over the
 * EXISTING derived display status — every verb returns to the original
 * conversation; nothing here re-derives state.
 */
export function taskCenterVerb(status: ExecutionStatusView): string {
  if (status.needsAttention) return t`Handle now`;
  if (status.status === "done") return t`View result`;
  if (status.status === "failed") return t`View execution`;
  return t`Back to conversation`;
}

/* ------------------------------------------------------------------ */
/* Navigation handoff (module memory; never storage, never the DOM)    */
/* ------------------------------------------------------------------ */

export type TaskCenterNavIntent = {
  threadId: string;
  runId: string;
  /** The rev the Task Center list saw; the chat applies the loaded summary's own rev. */
  rev: number;
  /** True for waiting states: focus lands on the Intervention control. */
  attention: boolean;
};

let navIntent: TaskCenterNavIntent | null = null;

export function setTaskCenterNavIntent(intent: TaskCenterNavIntent): void {
  navIntent = intent;
}

export function peekTaskCenterNavIntent(): TaskCenterNavIntent | null {
  return navIntent;
}

export function clearTaskCenterNavIntent(): void {
  navIntent = null;
}
