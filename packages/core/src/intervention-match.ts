export type InterventionMatchSource = {
  id: string;
  status: string;
  kind: string;
  runId: string;
  messageId: string;
  input?: { mode?: string } | null;
};

export type FreeTextMatch =
  | { action: "answer"; interventionId: string; runId: string; messageId: string }
  | { action: "refuse"; reason: "secret" | "approval" | "choice" | "ambiguous" }
  | { action: "none" };

/**
 * Free-text from the composer, voice, or an inbound chat may answer an
 * Intervention only when the thread has exactly one pending ordinary text
 * input. Approval, secret, and choice never match. More than one text input
 * is left untouched.
 */
export function matchFreeTextIntervention(
  interventions: readonly InterventionMatchSource[],
): FreeTextMatch {
  const pending = interventions.filter((item) => item.status === "pending");
  const text = pending.filter(
    (item) => item.kind === "input" && item.input?.mode === "text",
  );
  if (text.length > 1) return { action: "refuse", reason: "ambiguous" };
  if (text.length === 1) {
    const target = text[0]!;
    return {
      action: "answer",
      interventionId: target.id,
      runId: target.runId,
      messageId: target.messageId,
    };
  }
  if (pending.some((item) => item.kind === "input" && item.input?.mode === "secret")) {
    return { action: "refuse", reason: "secret" };
  }
  if (pending.some((item) => item.kind === "approval")) {
    return { action: "refuse", reason: "approval" };
  }
  if (pending.some((item) => item.kind === "input" && item.input?.mode === "choice")) {
    return { action: "refuse", reason: "choice" };
  }
  return { action: "none" };
}

type SnapshotAsk = {
  interventions?: readonly InterventionMatchSource[] | null;
  messages?: readonly {
    id: string;
    runId?: string | null;
    blocks: readonly {
      kind: string;
      status?: string;
      interventionId?: string;
      approvalEffectId?: string;
      input?: string;
      actions?: readonly unknown[];
    }[];
  }[];
  run?: { id: string; status: string } | null;
  activeRuns?: readonly { id: string; status: string }[];
};

/** Prefer the snapshot projection. Fall back to every pending ask, not the latest one. */
export function matchFreeTextFromSnapshot(snapshot: SnapshotAsk | null | undefined): FreeTextMatch {
  if (!snapshot) return { action: "none" };
  if (snapshot.interventions) return matchFreeTextIntervention(snapshot.interventions);
  const waiting = new Set(
    (snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : []))
      .filter((run) => run.status === "waiting_input")
      .map((run) => run.id),
  );
  const derived: InterventionMatchSource[] = [];
  for (const message of snapshot.messages ?? []) {
    if (!message.runId || !waiting.has(message.runId)) continue;
    for (const block of message.blocks) {
      if (block.kind !== "ask" || block.status === "answered" || block.status === "expired") continue;
      const mode = block.approvalEffectId
        ? undefined
        : block.input === "secret"
          ? "secret"
          : block.actions?.length
            ? "choice"
            : "text";
      derived.push({
        id: block.interventionId ?? `legacy_${message.id}`,
        status: "pending",
        kind: block.approvalEffectId ? "approval" : "input",
        runId: message.runId,
        messageId: message.id,
        input: mode ? { mode } : undefined,
      });
    }
  }
  return matchFreeTextIntervention(derived);
}
