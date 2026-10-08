import type { ActivityItem, ThreadSnapshot } from "@rakazo/contracts";

/**
 * Phase 4 activity selectors. The projection itself lives in @rakazo/core
 * (one reducer for server replay and client live updates); this module only
 * slices it for the thread surfaces.
 */

function activeRunIds(snapshot: ThreadSnapshot | null): Set<string> {
  const ids = new Set<string>();
  if (snapshot?.run) ids.add(snapshot.run.id);
  for (const run of snapshot?.activeRuns ?? []) ids.add(run.id);
  return ids;
}

/** Items belonging to still-active runs — the inline "Working…" strip. */
export function liveActivityItems(snapshot: ThreadSnapshot | null): ActivityItem[] {
  if (!snapshot?.activity?.length) return [];
  const ids = activeRunIds(snapshot);
  return snapshot.activity.filter((item) => item.runId && ids.has(item.runId));
}

/**
 * Background cards outlive their parent run (§14/§38): always surfaced while
 * the snapshot carries them, running or terminal.
 */
export function backgroundActivityItems(snapshot: ThreadSnapshot | null): ActivityItem[] {
  return (snapshot?.activity ?? []).filter((item) => item.kind === "background");
}

/**
 * The inline strip never duplicates existing surfaces (§22/§46): tool rows
 * belong to the ToolActivityDisclosure steps card, a handoff already has its
 * conversation-visible marker block, and inline helpers already render their
 * dedicated subagent card in the message stream. Background cards stay —
 * they have no other home and must outlive the parent run.
 */
export function inlineActivityItems(items: readonly ActivityItem[]): ActivityItem[] {
  return items.filter(
    (item) => item.kind !== "tool" && item.kind !== "handoff" && item.kind !== "research",
  );
}

/** Sidebar line (§27/§28): projected activity first, prompt snippet fallback. */
export function activityLineText(run: {
  activity?: { kind: string; text: string };
  promptSnippet: string;
}): string {
  const text = run.activity?.text.trim();
  return text ? text : run.promptSnippet;
}
