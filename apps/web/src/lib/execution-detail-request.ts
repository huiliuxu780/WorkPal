/**
 * Per-Run detail REQUEST state (UX-01C acceptance 14).
 *
 * Deliberately separate from the rev-versioned `ExecutionDetailCache`: a
 * failed request is a transport fact, never a snapshot version, and mixing
 * it into the cache would pair an error with a rev it does not describe.
 * Pure transitions only — the hook owns the in-flight dedupe ref, the RPC
 * call and the stale-response guards; this module owns honest state.
 */

export type DetailRequestStatus = "idle" | "loading" | "error";
export type DetailRequestMap = Readonly<Record<string, DetailRequestStatus>>;

export function detailRequestStatus(map: DetailRequestMap, runId: string): DetailRequestStatus {
  return map[runId] ?? "idle";
}

/** A request is in flight for this Run. */
export function beginDetailRequest(map: DetailRequestMap, runId: string): DetailRequestMap {
  if (map[runId] === "loading") return map;
  return { ...map, [runId]: "loading" };
}

/** The response landed (installed or dropped by the rev guard): clear any error. */
export function settleDetailRequest(map: DetailRequestMap, runId: string): DetailRequestMap {
  if (!map[runId]) return map;
  const next = { ...map };
  delete next[runId];
  return next;
}

/** The request failed: surface the safe retry state. */
export function failDetailRequest(map: DetailRequestMap, runId: string): DetailRequestMap {
  if (map[runId] === "error") return map;
  return { ...map, [runId]: "error" };
}

/** Drop one Run's request state (e.g. its card left the eligibility set). */
export function clearDetailRequest(map: DetailRequestMap, runId: string): DetailRequestMap {
  if (!(runId in map)) return map;
  const next = { ...map };
  delete next[runId];
  return next;
}
