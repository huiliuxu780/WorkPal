import type { InterventionView } from "@rakazo/contracts";

/** Keep a locally settled card until the transcript remounts. Higher revision wins. */
export function mergeInterventionViews(
  server: readonly InterventionView[] | undefined,
  settled: readonly InterventionView[],
): InterventionView[] | undefined {
  if (!server) return undefined;
  const byId = new Map<string, InterventionView>();
  for (const view of server) byId.set(view.id, view);
  for (const view of settled) {
    const current = byId.get(view.id);
    if (!current || view.revision >= current.revision) byId.set(view.id, view);
  }
  return [...byId.values()];
}

/** Message ids whose AskCard belongs in the Intervention Region, not the bubble. */
export function coveredAskMessageIds(
  interventions: readonly InterventionView[] | undefined,
): ReadonlySet<string> {
  if (!interventions) return new Set();
  return new Set(interventions.map((view) => view.messageId));
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
