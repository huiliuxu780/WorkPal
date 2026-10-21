import type { BotAvatarState } from "@rakazo/contracts";

/**
 * Execution navigation handoff — module memory only: no Run id ever reaches
 * a browser-storage key, a DOM attribute or the URL (anchor deep links use
 * the existing `?m=` message param).
 */

/* Navigation handoff (module memory; never storage, never the DOM). */

export type ExecutionNavIntent = {
  threadId: string;
  runId: string;
  /** The rev the source list saw; the chat applies the loaded summary's own rev. */
  rev: number;
  /** True for waiting states: focus lands on the Intervention control. */
  attention: boolean;
};

let navIntent: ExecutionNavIntent | null = null;

/**
 * Announced on `window` when an intent is set while the target Thread is
 * ALREADY mounted (sidebar click on the open conversation): the transcript's
 * intent consumer re-checks on this event instead of waiting for a thread or
 * summary change. Module memory + one window event — no new RPC, URL state
 * or browser storage.
 */
export const EXECUTION_NAV_INTENT_EVENT = "workpal:execution-nav-intent";

export function setExecutionNavIntent(intent: ExecutionNavIntent): void {
  navIntent = intent;
}

export function peekExecutionNavIntent(): ExecutionNavIntent | null {
  return navIntent;
}

export function clearExecutionNavIntent(): void {
  navIntent = null;
}

/**
 * Sidebar roster refocus (UX-01B acceptance 12): clicking a Bot whose
 * trusted avatar state says it is waiting for the user arms the SAME
 * return-intent mechanism, so the target Thread focuses the
 * Intervention's first operable control after loading. Without a trusted
 * runId it navigates only — never guesses. `rev` carries the avatar state's
 * revision as the seen-version marker; the consumer applies the loaded
 * summary's own rev.
 */
export function rosterAttentionIntent(input: {
  threadId: string;
  state: Pick<BotAvatarState, "state" | "runId" | "revision"> | null | undefined;
}): ExecutionNavIntent | null {
  const { threadId, state } = input;
  if (!state?.runId) return null;
  if (state.state !== "waiting" && state.state !== "approval") return null;
  return { threadId, runId: state.runId, rev: state.revision, attention: true };
}
