import { t } from "@lingui/core/macro";
import type {
  ExecutionResult,
  ExecutionSummary,
  InterventionView,
  RunStepSnapshot,
} from "@rakazo/contracts";
import type { ExecutionDisplayStatus, ExecutionStatusView } from "./execution-status";
import { formatRelativeTime } from "./relative-time";
import { formatToolActivityDuration } from "./tool-activity-view";

/**
 * Execution Card view model (Task 15/15.1 design, production wiring).
 *
 * Pure mapping only: no global state, no RPC, no JSX, and no raw runtime
 * errors. The display status is always the caller's `deriveExecutionStatus`
 * result — the card never maintains a second status matrix. Every line the
 * card shows must come from a trusted production field; unknown values are
 * omitted, never rendered as 0, "--" or a guessed percentage.
 */

export type ExecutionCardAuxKind = "intervention" | "activity" | "outcome" | "failure";

export type ExecutionCardAux = {
  kind: ExecutionCardAuxKind;
  text: string;
};

export type ExecutionCardAction = {
  /** Localized verb, e.g. "View execution" / "Collapse". */
  verb: string;
  /**
   * `toggle` flips the detail expansion; `attention` keeps the pending
   * Intervention discoverable — it focuses the first authoritative control
   * instead of collapsing (a waiting Run is always expanded); `navigate`
   * returns to the original conversation (Task Center second entry — the
   * compact list card carries no detail of its own).
   */
  act: "toggle" | "attention" | "navigate";
};

export type ExecutionCardModel = {
  status: ExecutionDisplayStatus;
  /** Localized status sentence; identical to the shell/detail status text. */
  statusLabel: string;
  needsAttention: boolean;
  /** Foreground non-terminal state: the card may carry a surface tint. */
  live: boolean;
  background: boolean;
  /** Run title from the durable summary; null on legacy servers (omitted). */
  title: string | null;
  /** One auxiliary line, chosen by the frozen priority; null when nothing trustworthy exists. */
  aux: ExecutionCardAux | null;
  /** "Generated <names>" — only when the summary lists real artifacts. */
  artifactsLine: string | null;
  /** Localized metadata fragments; empty fragments are omitted upstream. */
  metaParts: string[];
  /** Terminal-time label for historical cards; null while live. */
  when: string | null;
  /** Lifecycle rail fill 0..1 from real step states; null when unknown. */
  railFill: number | null;
  /** Primary action; null when there is nothing to open and nothing to attend. */
  action: ExecutionCardAction | null;
};

export type ExecutionCardInput = {
  /** The single derived status view shared with the shell detail. */
  status: ExecutionStatusView;
  summary?: ExecutionSummary | null;
  /** Pending Intervention views for this Run (server projection, safe presentation only). */
  pendingInterventions?: readonly InterventionView[];
  /** Loaded detail steps; drives the lifecycle rail and the failed-step line. */
  steps?: readonly RunStepSnapshot[];
  /** A truncated step list cannot back an honest lifecycle fraction. */
  stepsTruncated?: boolean;
  /** True when the expanded detail renders the Result section. */
  hasResult?: boolean;
  /**
   * The Run's result message bubble is loaded on the current page and is the
   * canonical result surface there: the card then never repeats its text as
   * an outcome line. When the bubble is paged out, the card outcome (and the
   * expanded Result section) keep the result reachable.
   */
  resultOnPage?: boolean;
  expanded: boolean;
  /** There is a detail body to open (summary exists or children were provided). */
  canExpand: boolean;
  /**
   * Trusted root-Run background identity. Production has no trusted source
   * yet, so callers never pass this; the flag exists so the mapping (and its
   * tests) covers the background presentation without inventing a signal.
   */
  background?: boolean;
  /**
   * Caller-owned primary action (Task Center navigation verbs). When present
   * it REPLACES the computed toggle/attention action — the display status
   * still comes from the one shared derivation, so this is a verb mapping,
   * never a second status matrix. `null` renders no action.
   */
  actionOverride?: ExecutionCardAction | null;
};

const TERMINAL_STATUSES: readonly ExecutionDisplayStatus[] = ["done", "failed", "cancelled"];

/** Region order: approvals first, then by creation time (mirrors InterventionRegion). */
function sortedPending(pending: readonly InterventionView[]): InterventionView[] {
  return [...pending].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "approval" ? -1 : 1;
    return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
  });
}

/**
 * The sanitized question of the first pending Intervention. `presentation` is
 * the persisted server-side whitelist — never the raw ask payload, secrets or
 * credentials. No presentation text means no auxiliary line (never fabricated).
 */
function interventionAux(pending: readonly InterventionView[]): ExecutionCardAux | null {
  for (const view of sortedPending(pending)) {
    if (view.status !== "pending") continue;
    const text = view.presentation?.text?.trim();
    if (text) return { kind: "intervention", text };
  }
  return null;
}

function countLabel(count: number, one: string, many: (n: number) => string): string {
  return count === 1 ? one : many(count);
}

function metaParts(summary: ExecutionSummary | null | undefined): string[] {
  if (!summary) return [];
  const parts: string[] = [];
  const counts = summary.counts;
  if (counts?.steps != null && counts.steps > 0) {
    parts.push(countLabel(counts.steps, t`1 step`, (n) => t`${n} steps`));
  }
  if (counts?.actions != null && counts.actions > 0) {
    parts.push(countLabel(counts.actions, t`1 action`, (n) => t`${n} actions`));
  }
  if (counts?.agents != null && counts.agents > 0) {
    parts.push(countLabel(counts.agents, t`1 collaborator`, (n) => t`${n} collaborators`));
  }
  if (counts?.artifacts != null && counts.artifacts > 0) {
    parts.push(countLabel(counts.artifacts, t`1 artifact`, (n) => t`${n} artifacts`));
  }
  const duration = formatToolActivityDuration(summary.durationMs);
  if (duration) parts.push(duration);
  return parts;
}

function artifactsLine(summary: ExecutionSummary | null | undefined): string | null {
  const names = (summary?.artifacts ?? []).map((artifact) => artifact.name.trim()).filter(Boolean);
  if (names.length === 0) return null;
  return t`Generated ${names.join(", ")}`;
}

/** "Step N · <title>" from real loaded step rows; null when no step failed. */
function failedStepLabel(steps: readonly RunStepSnapshot[]): string | null {
  const ordered = [...steps].sort((left, right) => left.order - right.order);
  const index = ordered.findIndex((step) => step.status === "failed");
  if (index < 0) return null;
  const title = ordered[index]?.title?.trim();
  const label = t`Step ${index + 1}`;
  return title ? `${label} · ${title}` : label;
}

/**
 * Lifecycle rail fill: done = full; failed = up to the failed step; otherwise
 * completed steps over total. Null (base rail only) when there are no steps,
 * the step list is truncated, or a failed Run carries no failed step — an
 * unknown failure position is never drawn as a complete lifecycle.
 */
export function lifecycleRailFill(
  status: ExecutionDisplayStatus,
  steps: readonly RunStepSnapshot[] | undefined,
  stepsTruncated: boolean | undefined,
): number | null {
  if (!steps || steps.length === 0 || stepsTruncated) return null;
  if (status === "done") return 1;
  if (status === "failed") {
    const ordered = [...steps].sort((left, right) => left.order - right.order);
    const index = ordered.findIndex((step) => step.status === "failed");
    return index >= 0 ? (index + 1) / ordered.length : null;
  }
  const completed = steps.filter((step) => step.status === "completed").length;
  return completed / steps.length;
}

/** Whether the Result section will render any real text (shared by card and detail). */
export function resultHasText(result: ExecutionResult | null | undefined): boolean {
  if (!result) return false;
  return result.blocks.some((block) => block.kind === "text" && block.text.trim().length > 0);
}

export function buildExecutionCardModel(input: ExecutionCardInput): ExecutionCardModel {
  const { status, summary, expanded, canExpand } = input;
  const background = input.background === true || status.status === "background";
  const terminal = TERMINAL_STATUSES.includes(status.status);
  const live = !terminal && !background;

  // Auxiliary line, frozen priority: pending Intervention > current safe
  // activity > terminal outcome > safe failure summary > omitted.
  let aux: ExecutionCardAux | null = null;
  if (status.needsAttention || status.status === "approval" || status.status === "need_input") {
    aux = interventionAux(input.pendingInterventions ?? []);
  }
  if (!aux && !terminal) {
    const detail = status.detail?.trim();
    if (detail) aux = { kind: "activity", text: detail };
  }
  if (!aux && status.status === "done") {
    // The adjacent result bubble is the canonical surface while it is loaded;
    // repeating its text on the card would double the same sentence.
    const outcome = input.resultOnPage ? null : summary?.outcome?.trim();
    if (outcome) aux = { kind: "outcome", text: outcome };
  }
  if (!aux && status.status === "failed") {
    const step = failedStepLabel(input.steps ?? []);
    const failure = summary?.failure?.trim();
    const text = [step, failure].filter(Boolean).join(" · ");
    if (text) aux = { kind: "failure", text };
  }
  // The expanded detail owns the full Result message; the card's outcome
  // excerpt yields while that section is on screen (no doubled result line).
  if (aux?.kind === "outcome" && expanded && input.hasResult) aux = null;

  const when =
    terminal && summary
      ? formatRelativeTime(summary.completedAt ?? summary.updatedAt) || null
      : null;

  let action: ExecutionCardAction | null = null;
  if (input.actionOverride !== undefined) {
    action = input.actionOverride;
  } else if (status.needsAttention) {
    action = { verb: t`Needs your attention`, act: "attention" };
  } else if (canExpand) {
    action = expanded
      ? { verb: t`Collapse`, act: "toggle" }
      : status.status === "done"
        ? { verb: t`View result`, act: "toggle" }
        : { verb: t`View execution`, act: "toggle" };
  }

  return {
    status: status.status,
    statusLabel: status.label,
    needsAttention: status.needsAttention,
    live,
    background,
    title: summary?.title?.trim() ? summary.title.trim() : null,
    aux,
    artifactsLine: artifactsLine(summary),
    metaParts: metaParts(summary),
    when,
    railFill: lifecycleRailFill(status.status, input.steps, input.stepsTruncated),
    action,
  };
}
