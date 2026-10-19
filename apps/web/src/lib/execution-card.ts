import { t } from "@lingui/core/macro";
import type {
  ExecutionResult,
  ExecutionSummary,
  InterventionView,
  RunPlanRevision,
  RunStepSnapshot,
} from "@rakazo/contracts";
import type { ExecutionDisplayStatus, ExecutionStatusView } from "./execution-status";
import { formatRelativeTime } from "./relative-time";
import { formatToolActivityDuration } from "./tool-activity-view";

/**
 * Execution Card view model (Task 15/15.1 design + UX-01B convergence).
 *
 * Pure mapping only: no global state, no RPC, no JSX, and no raw runtime
 * errors. The display status is always the caller's `deriveExecutionStatus`
 * result — the card never maintains a second status matrix. Every line the
 * card shows must come from a trusted production field; unknown values are
 * omitted, never rendered as 0, "--" or a guessed percentage.
 *
 * UX-01B core rule 2: progress numbers and the progress bar come ONLY from
 * the structured Plan. Semantic Steps never fabricate a fraction, and a card
 * without a Plan renders no progress DOM at all.
 */

export type ExecutionCardAuxKind = "intervention" | "activity" | "current" | "outcome" | "failure";

export type ExecutionCardAux = {
  kind: ExecutionCardAuxKind;
  text: string;
};

export type ExecutionCardAction = {
  /** Localized verb, e.g. "View progress" / "View reason" / "Collapse". */
  verb: string;
  /**
   * `toggle` flips the detail expansion; `attention` keeps the pending
   * Intervention discoverable — it focuses the first authoritative control
   * instead of collapsing; `navigate` returns to the original conversation
   * (Task Center second entry — the compact list card carries no detail of
   * its own); `retry` requests a manual retry; `view_successor` opens the
   * already-created retry Run.
   */
  act: "toggle" | "attention" | "navigate" | "retry" | "view_successor";
};

/**
 * The single Plan-derived progress of one card. `completed` counts effective
 * items done, `total` counts effective items (skipped/superseded excluded,
 * unresolved in the denominator only), and `fraction` is the bar width.
 */
export type PlanProgress = {
  completed: number;
  total: number;
  fraction: number;
  /** Localized accessible name for the progress bar. */
  label: string;
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
  /** Localized metadata fragments; empty fragments are omitted upstream. Never a step count. */
  metaParts: string[];
  /** Terminal-time label for historical cards; null while live. */
  when: string | null;
  /** The one Plan progress; null without a structured Plan (never 0, never a guess). */
  planProgress: PlanProgress | null;
  /** Localized "Plan updated" copy for the shell's revision flash. */
  planUpdatedLabel: string;
  /** Primary action; null when there is nothing to open and nothing to attend. */
  action: ExecutionCardAction | null;
  /**
   * Independent disclosure entry beside an attention/navigate primary action
   * (review round P1): a waiting card stays collapsed by default, so without
   * its own toggle the Plan/Steps/evidence inside would be unreachable.
   * Null for every card whose primary action already toggles.
   */
  secondaryAction: ExecutionCardAction | null;
  /** Manual retry or "View retry" — independent of the UX-01 primary/secondary matrix. */
  retryAction: ExecutionCardAction | null;
  alreadyRetriedLabel: string | null;
};

export type ExecutionCardInput = {
  /** The single derived status view shared with the shell detail. */
  status: ExecutionStatusView;
  summary?: ExecutionSummary | null;
  /** The backend-published structured Plan; the only progress source. */
  plan?: RunPlanRevision | null;
  /** Pending Intervention views for this Run (server projection, safe presentation only). */
  pendingInterventions?: readonly InterventionView[];
  /** Loaded semantic steps; only used for the failed-step line and the current-item elapsed. */
  steps?: readonly RunStepSnapshot[];
  /**
   * Evaluation time for the current Plan item's elapsed minutes. Injected by
   * tests; production renders pass nothing and use the render moment.
   */
  now?: number;
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
  /** True while a manual retry mutation is in flight for this Run. */
  retrying?: boolean;
};

const TERMINAL_STATUSES: readonly ExecutionDisplayStatus[] = ["done", "failed", "cancelled"];

/** Region order: approvals first, then by creation time (mirrors InterventionRegion). */
function sortedPending(pending: readonly InterventionView[]): InterventionView[] {
  return [...pending].sort((left, right) => {
    if (left.kind !== right.kind) {
      const rank = (kind: string) =>
        kind === "approval" || kind === "plan_review" ? 0 : 1;
      const delta = rank(left.kind) - rank(right.kind);
      if (delta !== 0) return delta;
    }
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

/**
 * Non-step summary metadata. UX-01B acceptance 5: `counts.steps` is trusted
 * server data but never rendered as "N steps" — a card carries at most one
 * number pair and it is the Plan's a/b.
 */
function metaParts(summary: ExecutionSummary | null | undefined): string[] {
  if (!summary) return [];
  const parts: string[] = [];
  const counts = summary.counts;
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

/* ------------------------------------------------------------------ */
/* Plan-only progress (UX-01B core rule 2)                             */
/* ------------------------------------------------------------------ */

export type PlanItem = RunPlanRevision["items"][number];

/** Effective items: skipped and superseded never count; unresolved stays in. */
export function effectivePlanItems(plan: RunPlanRevision): PlanItem[] {
  return plan.items.filter((item) => item.status !== "skipped" && item.status !== "superseded");
}

/**
 * The single progress of one card: completed over effective total. A Plan
 * without effective items has no honest fraction and yields null — never 0.
 * Revisions may regress the fraction (3/4 → 3/6); that is truthful.
 */
export function planProgress(plan: RunPlanRevision | null | undefined): PlanProgress | null {
  if (!plan) return null;
  const effective = effectivePlanItems(plan);
  if (effective.length === 0) return null;
  const completed = effective.filter((item) => item.status === "completed").length;
  return {
    completed,
    total: effective.length,
    fraction: completed / effective.length,
    label: t`Plan progress`,
  };
}

/** The item the "当前：…" line names: the active one, else the first unresolved. */
export function currentPlanItem(plan: RunPlanRevision | null | undefined): PlanItem | null {
  if (!plan) return null;
  return (
    plan.items.find((item) => item.status === "active") ??
    plan.items.find((item) => item.status === "unresolved") ??
    null
  );
}

/**
 * Elapsed whole minutes of the current Plan item — ONLY from a semantic Step
 * whose `planItemId` matches the item and whose `startedAt` parses. Plan
 * items have no time fields of their own; Run/summary/plan creation times
 * never impersonate item elapsed. Null means "show no time", 0 means "under
 * one minute" (honest, never rounded up).
 */
export function currentItemElapsedMinutes(input: {
  item: PlanItem | null;
  steps: readonly RunStepSnapshot[];
  now: number;
}): number | null {
  const { item, steps, now } = input;
  if (!item) return null;
  let latest: { startedAt: number; completedAt: number | null } | null = null;
  for (const step of steps) {
    if (step.planItemId !== item.id || !step.startedAt) continue;
    const startedAt = Date.parse(step.startedAt);
    if (!Number.isFinite(startedAt)) continue;
    if (!latest || startedAt > latest.startedAt) {
      const completedAt = step.completedAt ? Date.parse(step.completedAt) : null;
      latest = {
        startedAt,
        completedAt: completedAt !== null && Number.isFinite(completedAt) ? completedAt : null,
      };
    }
  }
  if (!latest) return null;
  const end = latest.completedAt ?? now;
  const ms = end - latest.startedAt;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 60_000);
}

/** The level-0 current-item line; null when the Plan has no current item. */
function currentAux(
  plan: RunPlanRevision,
  steps: readonly RunStepSnapshot[],
  now: number,
): ExecutionCardAux | null {
  const item = currentPlanItem(plan);
  if (!item) return null;
  const minutes = currentItemElapsedMinutes({ item, steps, now });
  if (minutes === null) return { kind: "current", text: t`Current: ${item.title}` };
  if (minutes < 1) {
    return { kind: "current", text: t`Current: ${item.title} · under 1 min elapsed` };
  }
  return { kind: "current", text: t`Current: ${item.title} · ${minutes} min elapsed` };
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
  const progress = planProgress(input.plan);

  // Auxiliary line, frozen priority: pending Intervention > safe failure >
  // (Plan current item | current safe activity) > terminal outcome > omitted.
  let aux: ExecutionCardAux | null = null;
  if (status.needsAttention || status.status === "approval" || status.status === "need_input") {
    aux = interventionAux(input.pendingInterventions ?? []);
  }
  if (!aux && status.status === "failed") {
    const step = failedStepLabel(input.steps ?? []);
    const failure = summary?.failure?.trim();
    const text = [step, failure].filter(Boolean).join(" · ");
    if (text) aux = { kind: "failure", text };
  }
  if (!aux && !terminal) {
    const current = input.plan
      ? currentAux(input.plan, input.steps ?? [], input.now ?? Date.now())
      : null;
    if (current) {
      aux = current;
    } else {
      const detail = status.detail?.trim();
      if (detail) aux = { kind: "activity", text: detail };
    }
  }
  if (!aux && status.status === "done") {
    // The adjacent result bubble is the canonical surface while it is loaded;
    // repeating its text on the card would double the same sentence.
    const outcome = input.resultOnPage ? null : summary?.outcome?.trim();
    if (outcome) aux = { kind: "outcome", text: outcome };
  }
  // The expanded detail owns the full Result message; the card's outcome
  // excerpt yields while that section is on screen (no doubled result line).
  if (aux?.kind === "outcome" && expanded && input.hasResult) aux = null;

  const when =
    terminal && summary
      ? formatRelativeTime(summary.completedAt ?? summary.updatedAt) || null
      : null;

  const toggleVerb = expanded
    ? t`Collapse`
    : status.status === "failed"
      ? t`View reason`
      : status.status === "done"
        ? t`View result`
        : t`View progress`;
  let action: ExecutionCardAction | null = null;
  let secondaryAction: ExecutionCardAction | null = null;
  if (input.actionOverride !== undefined) {
    action = input.actionOverride;
  } else if (status.needsAttention) {
    action = { verb: t`Needs your attention`, act: "attention" };
    // Review round P1: the attention verb focuses the Intervention control;
    // the detail body keeps its OWN toggle so a waiting Run's Plan/Steps and
    // evidence stay reachable while the approval card lives outside.
    if (canExpand) secondaryAction = { verb: toggleVerb, act: "toggle" };
  } else if (canExpand) {
    action = { verb: toggleVerb, act: "toggle" };
  }

  let retryAction: ExecutionCardAction | null = null;
  let alreadyRetriedLabel: string | null = null;
  if (summary?.retrySuccessorRunId) {
    retryAction = { verb: t`View retry`, act: "view_successor" };
    alreadyRetriedLabel = t`Already retried`;
  } else if (summary?.manualRetry?.allowed) {
    retryAction = { verb: input.retrying ? t`Retrying…` : t`Retry`, act: "retry" };
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
    planProgress: progress,
    planUpdatedLabel: t`Plan updated`,
    action,
    secondaryAction,
    retryAction,
    alreadyRetriedLabel,
  };
}
