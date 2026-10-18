/**
 * Per-Run detail REQUEST state (UX-01C acceptance 14 + review round P3).
 *
 * Deliberately separate from the rev-versioned `ExecutionDetailCache`: a
 * failed request is a transport fact, never a snapshot version, and mixing
 * it into the cache would pair an error with a rev it does not describe.
 *
 * Every entry is stamped with the summary revision it was requested
 * against. Reading resolves against the CURRENT revision: an entry from a
 * superseded projection reads as idle, so a rev move invalidates an old
 * error, and a late failure from a stale request can never rewrite newer
 * state. Pure transitions only — the hook owns the in-flight dedupe, the
 * RPC call and the stale-response guards; this module owns honest state.
 */

export type DetailRequestStatus = "idle" | "loading" | "error";

export type DetailRequestEntry = {
  status: "loading" | "error";
  /** The summary revision this request was made against. */
  rev: number;
};

export type DetailRequestMap = Readonly<Record<string, DetailRequestEntry>>;

/** The status at the CURRENT revision; entries from older revisions read idle. */
export function detailRequestStatus(
  map: DetailRequestMap,
  runId: string,
  rev: number,
): DetailRequestStatus {
  const entry = map[runId];
  if (!entry || entry.rev !== rev) return "idle";
  return entry.status;
}

/** A request is in flight for this Run at this revision. */
export function beginDetailRequest(
  map: DetailRequestMap,
  runId: string,
  rev: number,
): DetailRequestMap {
  const entry = map[runId];
  if (entry && entry.rev === rev && entry.status === "loading") return map;
  return { ...map, [runId]: { status: "loading", rev } };
}

/** The response landed (installed or dropped by the rev guard): clear any error. */
export function settleDetailRequest(map: DetailRequestMap, runId: string): DetailRequestMap {
  if (!map[runId]) return map;
  const next = { ...map };
  delete next[runId];
  return next;
}

/**
 * The request made at `rev` failed. A failure arriving for a superseded
 * revision (a newer request already owns the entry) is ignored whole — a
 * stale transport fact never rewrites newer state.
 */
export function failDetailRequest(
  map: DetailRequestMap,
  runId: string,
  rev: number,
): DetailRequestMap {
  const entry = map[runId];
  if (entry && entry.rev !== rev) return map;
  if (entry && entry.status === "error") return map;
  return { ...map, [runId]: { status: "error", rev } };
}

/** Drop one Run's request state (e.g. its card left the eligibility set). */
export function clearDetailRequest(map: DetailRequestMap, runId: string): DetailRequestMap {
  if (!(runId in map)) return map;
  const next = { ...map };
  delete next[runId];
  return next;
}
