import type { InterventionView } from "@rakazo/contracts";

/**
 * A locally settled receipt only fills the gap between submit and the next
 * snapshot. It outranks the projection while its revision is strictly newer;
 * at an equal revision the server view wins, because the approval's Effect
 * status can advance (`approved` → `completed`) without bumping the
 * Intervention revision, and the receipt would otherwise pin a stale status.
 */
export function mergeInterventionViews(
  server: readonly InterventionView[] | undefined,
  settled: readonly InterventionView[],
): InterventionView[] | undefined {
  if (!server) return undefined;
  const byId = new Map<string, InterventionView>();
  for (const view of server) byId.set(view.id, view);
  for (const view of settled) {
    const current = byId.get(view.id);
    if (!current || view.revision > current.revision) byId.set(view.id, view);
  }
  return [...byId.values()];
}

/**
 * Message ids whose AskCard belongs in the Intervention Region, not the
 * bubble.
 *
 * Without `context` every projected view covers its source ask (the region
 * is the only authoritative surface). With `context` (UX-01B), coverage
 * follows the region's actual existence: a SETTLED view of a Run that no
 * longer renders an Execution surface yields the ask back to its bubble —
 * but only when the bubble's own block already carries a settled status, so
 * a stopped Run's still-pending block never becomes a fake operable card.
 */
export function coveredAskMessageIds(
  interventions: readonly InterventionView[] | undefined,
  context?: {
    /** Runs that currently render an Execution surface (their region owns their asks). */
    eligibleRunIds?: ReadonlySet<string>;
    /** Message ids whose bubble ask block already carries a settled status. */
    settledAskMessageIds?: ReadonlySet<string>;
  },
): ReadonlySet<string> {
  if (!interventions) return new Set();
  const covered = new Set<string>();
  for (const view of interventions) {
    if (context) {
      const regionGone = view.status !== "pending" && !context.eligibleRunIds?.has(view.runId);
      const bubbleSettled = context.settledAskMessageIds?.has(view.messageId) ?? false;
      if (regionGone && bubbleSettled) continue;
    }
    covered.add(view.messageId);
  }
  return covered;
}

/**
 * Header kinds come from server pending rows only. A missing projection keeps
 * the caller on waitKind. An empty list is an inconsistent waiting Run.
 */
export function pendingInterventionKindsForRun(
  interventions: readonly InterventionView[] | undefined,
  runId: string,
): Array<"approval" | "input"> | undefined {
  if (!interventions) return undefined;
  return interventions
    .filter((view) => view.runId === runId && view.status === "pending")
    .map((view) => view.kind);
}
