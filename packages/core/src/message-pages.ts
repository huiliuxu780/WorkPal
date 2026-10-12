import type { ExecutionSummary } from "@rakazo/contracts";

interface MessageIdentity {
  id: string;
  seq?: number;
}

export interface ThreadHistory<TMessage extends MessageIdentity> {
  threadId: string;
  messages: readonly TMessage[];
  olderCursor: number | null;
  /** Per-Run execution summaries carried by snapshots and history pages. */
  executions?: readonly ExecutionSummary[];
}

/**
 * Merge execution summaries across a refresh (or an older-page prepend).
 * The first source wins per Run — it is the fresher view of that Run — while
 * summaries only known to the other source survive, so loaded history pages
 * keep restoring their executions after a snapshot refresh.
 */
export function mergeExecutionsByRun(
  first: readonly ExecutionSummary[] | undefined,
  second: readonly ExecutionSummary[] | undefined,
): ExecutionSummary[] | undefined {
  if (first === undefined && second === undefined) return undefined;
  const seen = new Set<string>();
  return [...(first ?? []), ...(second ?? [])].filter((execution) => {
    if (seen.has(execution.runId)) return false;
    seen.add(execution.runId);
    return true;
  });
}

export function mergeThreadHistory<
  TMessage extends MessageIdentity,
  TSnapshot extends ThreadHistory<TMessage>,
>(previous: TSnapshot | null, recent: TSnapshot, preserveLoadedHistory = false): TSnapshot {
  if (!previous || previous.threadId !== recent.threadId || !preserveLoadedHistory) return recent;
  const executions = mergeExecutionsByRun(recent.executions, previous.executions);
  return {
    ...recent,
    messages: mergeMessagePages(previous.messages, recent.messages),
    olderCursor: previous.olderCursor,
    ...(executions ? { executions } : {}),
  };
}

export function prependThreadHistoryPage<
  TMessage extends MessageIdentity,
  TSnapshot extends ThreadHistory<TMessage>,
>(previous: TSnapshot | null, page: ThreadHistory<TMessage>): TSnapshot | null {
  if (!previous || previous.threadId !== page.threadId || previous.olderCursor == null) {
    return previous;
  }
  const executions = mergeExecutionsByRun(previous.executions, page.executions);
  return {
    ...previous,
    messages: mergeMessagesById(page.messages, previous.messages),
    olderCursor: page.olderCursor,
    ...(executions ? { executions } : {}),
  };
}

export function mergeMessagePages<T extends MessageIdentity>(
  previous: readonly T[],
  recent: readonly T[],
): T[] {
  const firstRecentSeq = recent.reduce<number | null>((first, message) => {
    if (!isDurableMessage(message) || typeof message.seq !== "number") return first;
    return Math.min(first ?? message.seq, message.seq);
  }, null);
  const retained =
    firstRecentSeq === null
      ? []
      : previous.filter(
          (message) =>
            isDurableMessage(message) &&
            typeof message.seq === "number" &&
            message.seq < firstRecentSeq,
        );
  return mergeMessagesById(retained, recent);
}

export function mergeMessagesById<T extends { id: string }>(
  first: readonly T[],
  second: readonly T[],
): T[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

export function upsertMessageById<T extends { id: string }>(messages: readonly T[], next: T): T[] {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index < 0) return [...messages, next];
  const updated = [...messages];
  updated[index] = next;
  return updated;
}

function isDurableMessage(message: { id: string }): boolean {
  return !message.id.startsWith("progress:") && !message.id.startsWith("subagent:");
}
