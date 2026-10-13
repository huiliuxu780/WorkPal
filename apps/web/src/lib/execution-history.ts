import type {
  ActivityItem,
  ExecutionActivityPage,
  ExecutionSnapshot,
  ExecutionSummary,
  Run,
  RunPlanRevision,
  RunStepSnapshot,
  RunTodoSnapshot,
  ThreadSnapshot,
} from "@rakazo/contracts";

/**
 * Web consumption of the per-Run ExecutionSnapshot read model (HISTORY-001).
 * All compatibility branching lives here: when the server carries
 * `executions`, the anchors and data come from it; otherwise the transcript
 * keeps deriving from the legacy thread-level arrays.
 */

export type LegacyExecutionData = {
  plans?: readonly RunPlanRevision[];
  steps?: readonly RunStepSnapshot[];
  todos?: readonly RunTodoSnapshot[];
  activity?: readonly ActivityItem[];
};

/** runId → server summary, or null when the server predates `executions`. */
export function summariesByRun(
  snapshot: Pick<ThreadSnapshot, "executions"> | null | undefined,
): Map<string, ExecutionSummary> | null {
  if (!snapshot || snapshot.executions === undefined) return null;
  return new Map(snapshot.executions.map((summary) => [summary.runId, summary]));
}

/**
 * The transcript anchor for a Run. The server value wins only when its
 * message is actually loaded: a paged-out anchor must never hide a shell
 * whose Intervention Region still holds a pending card, so it falls back to
 * the caller's derivation and re-anchors when that page is loaded. A summary
 * without an anchor and a legacy server fall back the same way.
 */
export function resolveExecutionAnchor(input: {
  summary?: ExecutionSummary;
  legacyAnchorMessageId: string | null;
  anchorIsLoaded?: boolean;
}): string | null {
  const anchor = input.summary?.anchorMessageId;
  if (anchor && input.anchorIsLoaded !== false) return anchor;
  return input.legacyAnchorMessageId;
}

/** Detail data for one Run: fetched snapshot first, legacy thread arrays as fallback. */
export function executionDataForRun(input: {
  runId: string;
  detail?: ExecutionSnapshot;
  legacy: LegacyExecutionData;
}): {
  plan?: RunPlanRevision;
  steps: RunStepSnapshot[];
  todos: RunTodoSnapshot[];
  activity: ActivityItem[];
  summary?: ExecutionSummary;
} {
  const { runId, detail, legacy } = input;
  if (detail) {
    return {
      ...(detail.plan ? { plan: detail.plan } : {}),
      steps: detail.steps.items,
      todos: detail.todos.items,
      // The full first Activity page — not the short semantic timeline — so
      // nothing between the timeline bound and the page bound is ever lost.
      activity: detail.activityPage.items,
      summary: detail.summary,
    };
  }
  return {
    ...(legacy.plans?.find((plan) => plan.runId === runId)
      ? { plan: legacy.plans.find((plan) => plan.runId === runId) }
      : {}),
    steps: (legacy.steps ?? []).filter((step) => step.runId === runId),
    todos: (legacy.todos ?? []).filter((todo) => todo.runId === runId),
    activity: (legacy.activity ?? []).filter((item) => item.runId === runId),
  };
}

/**
 * Merge an older Activity page under the newer items already rendered.
 * Dedupe is by ActivityItem id and the NEWER status wins, so a called/
 * completed pair split across the page boundary reconciles to its completed
 * status and no id ever appears twice. The result has no gap: every id from
 * both pages is present exactly once.
 */
export function mergeActivityPages(
  newer: readonly ActivityItem[],
  older: readonly ActivityItem[],
): ActivityItem[] {
  const newerIds = new Set(newer.map((item) => item.id));
  const dedupedOlder = older.filter((item) => !newerIds.has(item.id));
  return [...dedupedOlder, ...newer];
}

/**
 * One versioned detail unit: the fetched snapshot, its first Activity page
 * cursor, and the older pages loaded against it. All three belong to the same
 * rev and must be replaced together — a stale response that swaps only some
 * of them would pair a newer detail with an older paging state.
 */
export type ExecutionDetailEntry = {
  rev: number;
  snapshot: ExecutionSnapshot;
  olderCursor: string | null;
  olderActivity: ActivityItem[];
};
export type ExecutionDetailCache = Record<string, ExecutionDetailEntry>;

/**
 * The cached detail entry for a Run, valid while it is at least as fresh as
 * the thread summary. Live Activity can advance the server rev without
 * refreshing the thread-level summary; a freshly fetched detail then wins.
 * A missing summary (legacy server) keeps the cache usable.
 */
export function selectCachedDetailEntry(
  cache: ExecutionDetailCache,
  runId: string,
  summaryRev: number | null,
): ExecutionDetailEntry | undefined {
  const entry = cache[runId];
  if (!entry) return undefined;
  if (summaryRev !== null && entry.rev < summaryRev) return undefined;
  return entry;
}

/**
 * Status for one shell. A fetched detail that is newer than the thread
 * summary is authoritative; otherwise the live Run wins when available.
 * History pages may carry only a summary, so synthesize the small status view
 * from that durable projection instead of displaying "Status unknown".
 */
export function executionRunState(input: {
  run: Run | null;
  summary: ExecutionSummary | null;
  detail?: ExecutionSnapshot;
}): Pick<Run, "id" | "status" | "waitKind"> | null {
  const { run, summary, detail } = input;
  const freshDetail =
    detail && (summary ? detail.summary.rev > summary.rev : run === null) ? detail.summary : null;
  const source = freshDetail ?? (run ? null : (detail?.summary ?? summary));
  if (source) {
    return { id: source.runId, status: source.status, waitKind: source.waitKind ?? null };
  }
  return run;
}

/**
 * Install a detail response under its rev guard. A response whose rev does
 * not exceed the cached one (out-of-order arrival of an older fetch, or a
 * duplicate of the current version) is dropped WHOLE: snapshot, cursor and
 * loaded older pages all stay exactly as the newer version left them. A
 * newer rev replaces the unit and resets paging to the response's own first
 * page.
 */
export function installExecutionDetail(
  cache: ExecutionDetailCache,
  runId: string,
  snapshot: ExecutionSnapshot,
): ExecutionDetailCache {
  const rev = snapshot.summary.rev;
  const existing = cache[runId];
  if (existing && existing.rev >= rev) return cache;
  return {
    ...cache,
    [runId]: {
      rev,
      snapshot,
      olderCursor: snapshot.activityPage.olderCursor ?? null,
      olderActivity: [],
    },
  };
}

/**
 * Append a load-more page to the entry it was requested against. The page is
 * dropped when the entry is gone or has since moved to another rev — paging
 * state never mixes versions. Items already covered (first page or previously
 * loaded older pages) are filtered by id; the render-side merge dedupes again
 * with the newer status winning.
 */
export function appendExecutionActivityPage(
  cache: ExecutionDetailCache,
  runId: string,
  requestRev: number,
  page: ExecutionActivityPage,
): ExecutionDetailCache {
  const entry = cache[runId];
  if (!entry || entry.rev !== requestRev) return cache;
  const known = new Set(
    [...entry.snapshot.activityPage.items, ...entry.olderActivity].map((item) => item.id),
  );
  return {
    ...cache,
    [runId]: {
      ...entry,
      olderActivity: [...page.items.filter((item) => !known.has(item.id)), ...entry.olderActivity],
      olderCursor: page.olderCursor ?? null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Expansion state (sessionStorage)                                    */
/* ------------------------------------------------------------------ */

const EXPANSION_KEY = "rk:execution-expansion";

export type ExpansionEntry = { threadId: string; runId: string; rev: number; open: boolean };
export type ExpansionMap = Record<string, ExpansionEntry>;

const expansionId = (threadId: string, runId: string) => `${threadId}:${runId}`;

function safeSession(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readExecutionExpansions(): ExpansionMap {
  const store = safeSession();
  if (!store) return {};
  try {
    const raw = store.getItem(EXPANSION_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: ExpansionMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      const entry = value as Partial<ExpansionEntry>;
      if (
        typeof entry.threadId === "string" &&
        typeof entry.runId === "string" &&
        typeof entry.rev === "number" &&
        typeof entry.open === "boolean"
      ) {
        out[key] = {
          threadId: entry.threadId,
          runId: entry.runId,
          rev: entry.rev,
          open: entry.open,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeExpansions(entries: ExpansionMap): ExpansionMap {
  const store = safeSession();
  if (store) {
    try {
      store.setItem(EXPANSION_KEY, JSON.stringify(entries));
    } catch {
      // Quota or private mode: expansion simply does not persist.
    }
  }
  return entries;
}

/**
 * Should this Run's detail start expanded? A stored record only applies when
 * it matches the Run's current rev; a stale rev means the projection moved
 * and the old expansion decision is discarded (default applies).
 */
export function isExpansionOpen(input: {
  entries: ExpansionMap;
  threadId: string;
  runId: string;
  rev: number;
  defaultOpen: boolean;
}): boolean {
  const entry = input.entries[expansionId(input.threadId, input.runId)];
  if (!entry || entry.rev !== input.rev) return input.defaultOpen;
  return entry.open;
}

/**
 * Flip a Run and, on open, close every other Run of the SAME Thread (one
 * detail at a time per conversation). Other Threads' stored decisions are
 * never touched.
 */
export function toggleExpansion(input: {
  entries: ExpansionMap;
  threadId: string;
  runId: string;
  rev: number;
  currentlyOpen: boolean;
}): ExpansionMap {
  const targetKey = expansionId(input.threadId, input.runId);
  const opening = !input.currentlyOpen;
  const next: ExpansionMap = {};
  for (const [key, entry] of Object.entries(input.entries)) {
    next[key] =
      opening && key !== targetKey && entry.open && entry.threadId === input.threadId
        ? { ...entry, open: false }
        : entry;
  }
  next[targetKey] = {
    threadId: input.threadId,
    runId: input.runId,
    rev: input.rev,
    open: opening,
  };
  return writeExpansions(next);
}

/** Only ever the four expansion fields — snapshots, answers, and secrets never enter storage. */
export function expansionLogShape(entries: ExpansionMap): ExpansionEntry[] {
  return Object.values(entries);
}
