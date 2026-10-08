import type { ActivityGroup, ActivityItem } from "./types.js";

/**
 * Product Harness Phase 4 — activity grouping and folding (§11, §24, §35–§38).
 * Presentation-adjacent but pure: shared by every surface so the thread,
 * the sidebar and any future page group identically.
 */

/** Group items under the run that owns them; collaboration and background
 *  items already carry their requester/parent runId, so a support hop or a
 *  background helper stays inside the delegating turn (§36/§38). */
export function groupActivity(items: readonly ActivityItem[]): ActivityGroup[] {
  const groups = new Map<string, ActivityGroup>();
  for (const item of items) {
    const key = item.runId ?? `bot:${item.botId}`;
    const existing = groups.get(key);
    if (existing) existing.items.push(item);
    else groups.set(key, { rootRunId: key, botId: item.botId, items: [item] });
  }
  return [...groups.values()];
}

/**
 * Fold adjacent tool rows with the same label into one row with a count
 * ("Read file ×4"), mirroring the durable `steps` folding semantics without
 * rewriting it (§11).
 */
export function foldAdjacentTools(items: readonly ActivityItem[]): ActivityItem[] {
  const folded: ActivityItem[] = [];
  for (const item of items) {
    const last = folded[folded.length - 1];
    if (
      item.kind === "tool" &&
      last &&
      last.kind === "tool" &&
      last.title === item.title &&
      last.runId === item.runId &&
      last.status === "completed" &&
      item.status === "completed"
    ) {
      folded[folded.length - 1] = {
        ...last,
        count: (last.count ?? 1) + 1,
        durationMs:
          last.durationMs !== undefined && item.durationMs !== undefined
            ? last.durationMs + item.durationMs
            : last.durationMs ?? item.durationMs,
        completedAt: item.completedAt ?? last.completedAt,
      };
      continue;
    }
    folded.push(item);
  }
  return folded;
}

/**
 * Live-run windowing (§24): keep the most recent `limit` items and report how
 * many earlier ones are hidden. Waiting/approval items are always kept — a
 * state the user must act on never scrolls out of view.
 */
export function windowActivity(
  items: readonly ActivityItem[],
  limit: number,
): { visible: ActivityItem[]; hiddenCount: number } {
  const actionable = items.filter(
    (item) => item.status === "waiting" || item.status === "running",
  );
  if (items.length <= limit) return { visible: [...items], hiddenCount: 0 };
  const tail = items.slice(items.length - limit);
  const seen = new Set(tail);
  const kept = [...actionable.filter((item) => !seen.has(item)), ...tail];
  return { visible: kept, hiddenCount: items.length - kept.length };
}

/** "Done · 7 actions" style summary for a finished run (§22/§24). */
export function summarizeRunActivity(items: readonly ActivityItem[]): {
  actions: number;
  hasBackground: boolean;
  hasFailure: boolean;
} {
  let actions = 0;
  let hasBackground = false;
  let hasFailure = false;
  for (const item of items) {
    if (item.kind === "tool") actions += item.count ?? 1;
    if (item.kind === "research" || item.kind === "delegation") actions += 1;
    if (item.kind === "background") hasBackground = true;
    if (item.status === "failed") hasFailure = true;
  }
  return { actions, hasBackground, hasFailure };
}
