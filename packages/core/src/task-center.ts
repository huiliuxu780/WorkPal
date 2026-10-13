import type { RunStatus } from "@rakazo/contracts";
import { base64urlDecode, base64urlEncode } from "./base64url.js";

/**
 * Task Center pure rules (shared by the server loader and the Web list).
 * The Task Center is an index over EXISTING root Runs: no second lifecycle,
 * no new status vocabulary — the sort groups are a presentation order over
 * `Run.status`, and every item carries the existing `ExecutionSummary`.
 */

/**
 * Deterministic group order: waiting-for-user first, then running/leased,
 * queued, and the terminal buckets failed → completed → cancelled.
 */
const TASK_CENTER_PRIORITY: Record<RunStatus, number> = {
  waiting_input: 1,
  waiting_takeover: 1,
  running: 2,
  leased: 2,
  queued: 3,
  failed: 4,
  completed: 5,
  cancelled: 6,
};

export function taskCenterPriority(status: RunStatus): number {
  return TASK_CENTER_PRIORITY[status] ?? Number.MAX_SAFE_INTEGER;
}

export type TaskCenterSortFacts = {
  runId: string;
  status: RunStatus;
  /** Server sort key: the `runs.updatedAt` column (epoch ms). */
  updatedAtMs: number;
};

/**
 * Total deterministic order: group priority, then `updatedAt` descending,
 * then `runId` descending as the stable tie breaker. The tie breaker is a
 * sort fact only — it never renders to the DOM.
 */
export function compareTaskCenterRuns(a: TaskCenterSortFacts, b: TaskCenterSortFacts): number {
  const pa = taskCenterPriority(a.status);
  const pb = taskCenterPriority(b.status);
  if (pa !== pb) return pa - pb;
  if (a.updatedAtMs !== b.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
  return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0;
}

/* ------------------------------------------------------------------ */
/* Opaque actor-bound cursor                                           */
/* ------------------------------------------------------------------ */

export type TaskCenterCursor = {
  /** Cursor layout version. */
  v: 1;
  /** Bound to the issuing Space. */
  sp: string;
  /** Bound to the issuing user. */
  us: string;
  /** Group priority of the last delivered item. */
  p: number;
  /** `runs.updatedAt` epoch ms of the last delivered item. */
  t: number;
  /** runId of the last delivered item (tie-break position, never rendered). */
  r: string;
};

export function encodeTaskCenterCursor(cursor: TaskCenterCursor): string {
  return base64urlEncode(JSON.stringify(cursor));
}

/** Strict decode: any foreign shape, key set or version is rejected (null). */
export function decodeTaskCenterCursor(value: string | undefined): TaskCenterCursor | null {
  if (!value) return null;
  const json = base64urlDecode(value);
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "p,r,sp,t,us,v") return null;
  if (record.v !== 1) return null;
  if (typeof record.sp !== "string" || !record.sp) return null;
  if (typeof record.us !== "string" || !record.us) return null;
  if (typeof record.r !== "string" || !record.r) return null;
  const p = record.p;
  const t = record.t;
  for (const value of [p, t]) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  }
  return { v: 1, sp: record.sp, us: record.us, p: p as number, t: t as number, r: record.r };
}

/**
 * True when `item` sorts strictly AFTER the cursor position in the total
 * order above. The cursor carries its own group priority, so no status
 * re-derivation is needed. Items that moved to an earlier group since the
 * cursor was issued are skipped; the client dedupes by runId with the higher
 * rev winning.
 */
export function taskCenterAfterPosition(
  item: TaskCenterSortFacts,
  cursor: Pick<TaskCenterCursor, "p" | "t" | "r">,
): boolean {
  const p = taskCenterPriority(item.status);
  if (p !== cursor.p) return p > cursor.p;
  if (item.updatedAtMs !== cursor.t) return item.updatedAtMs < cursor.t;
  return item.runId < cursor.r;
}
