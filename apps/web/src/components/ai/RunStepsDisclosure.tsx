import { t } from "@lingui/core/macro";
import type { RunStepSnapshot } from "@rakazo/contracts";
import { memo, useState } from "react";

/**
 * Semantic Steps without a structured Plan — the level-1 fallback list of
 * the execution detail (UX-01B three-level structure):
 *
 * - level 1: Step titles with their status marks/labels and the plain-text
 *   trouble sentence (no "x/y done" fraction anywhere);
 * - level 2: per-Step duration, resultSummary, batch, attempt number and
 *   evidence reference count, closed behind an explicit toggle — except the
 *   failed Step of a failed Run, which opens as the "View reason" target.
 *
 * The `live` auto-expansion is gone: the card owns expansion, and this list
 * never carried a second progress number.
 */

const marks: Record<RunStepSnapshot["status"], string> = {
  pending: "○",
  queued: "○",
  running: "●",
  completed: "✓",
  failed: "!",
  retrying: "●",
  skipped: "–",
  cancelled: "□",
  blocked: "!",
  unknown: "·",
};

const labels: Record<RunStepSnapshot["status"], () => string> = {
  pending: () => t`Pending`,
  queued: () => t`Queued`,
  running: () => t`In progress`,
  completed: () => t`Done`,
  failed: () => t`Failed`,
  retrying: () => t`Retrying`,
  skipped: () => t`Skipped`,
  cancelled: () => t`Cancelled`,
  blocked: () => t`Blocked`,
  unknown: () => t`Status unconfirmed`,
};

export function stepMarks(status: RunStepSnapshot["status"]): string {
  return marks[status];
}

export function stepStatusLabel(status: RunStepSnapshot["status"]): string {
  return labels[status]();
}

function duration(step: RunStepSnapshot): string | null {
  if (!step.startedAt || !step.completedAt) return null;
  const ms = Date.parse(step.completedAt) - Date.parse(step.startedAt);
  if (!Number.isFinite(ms) || ms < 1_000) return null;
  const seconds = Math.round(ms / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function sortSteps(steps: readonly RunStepSnapshot[]): RunStepSnapshot[] {
  return [...steps].sort(
    (left, right) => left.order - right.order || left.stepId.localeCompare(right.stepId),
  );
}

function visibleIndices(steps: readonly RunStepSnapshot[], all: boolean): Set<number> {
  if (all || steps.length <= 8) return new Set(steps.map((_, index) => index));
  const indices = new Set([0, 1]);
  for (const [index, step] of steps.entries()) {
    if (["running", "retrying", "failed", "blocked", "unknown"].includes(step.status)) {
      indices.add(index);
      if (index + 1 < steps.length) indices.add(index + 1);
    }
  }
  return indices;
}

/** Level-2 content of one Step: everything the summary line must not carry. */
export const StepDetailBody = memo(function StepDetailBody({ step }: { step: RunStepSnapshot }) {
  const time = duration(step);
  const attempt = step.attemptNumber ? t`Attempt ${step.attemptNumber}` : null;
  const evidence = step.evidence.length
    ? step.evidence.length === 1
      ? t`1 evidence reference`
      : t`${step.evidence.length} evidence references`
    : null;
  return (
    <div
      data-testid="step-detail"
      {...(step.status === "failed" ? { "data-failure-target": "", tabIndex: -1 } : {})}
      className="border-s border-border ps-2 text-xs text-muted-foreground"
    >
      {time ? <p className="tabular-nums">{time}</p> : null}
      {step.resultSummary ? (
        <p dir="auto" className="text-xs text-muted-foreground">
          {step.resultSummary}
        </p>
      ) : null}
      {step.batch ? (
        <p className="text-xs tabular-nums text-muted-foreground">
          {step.batch.processed}
          {step.batch.total === undefined ? "" : ` / ${step.batch.total}`} {step.batch.unit}
        </p>
      ) : null}
      {attempt || evidence ? (
        <p className="text-xs text-muted-foreground">
          {[attempt, evidence].filter(Boolean).join(" · ")}
        </p>
      ) : null}
    </div>
  );
});

function stepHasDetail(step: RunStepSnapshot): boolean {
  return (
    duration(step) !== null ||
    Boolean(step.resultSummary) ||
    step.batch !== null ||
    step.attemptNumber !== null ||
    step.evidence.length > 0 ||
    // A failed Step is always expandable: it is the failure-reason target.
    step.status === "failed"
  );
}

export const StepRow = memo(function StepRow({
  step,
  failed,
}: {
  step: RunStepSnapshot;
  /** The Run failed: the failed Step's level 2 opens as the reason target. */
  failed: boolean;
}) {
  const [userOpen, setUserOpen] = useState(false);
  // Derived, not initial-state-only: the Run can fail while this list stays
  // mounted, and the failed Step's level 2 must become the visible reason.
  const open = userOpen || (failed && step.status === "failed");
  const hasDetail = stepHasDetail(step);
  return (
    <li data-step-id={step.stepId} data-step-status={step.status} className="min-w-0">
      <div className="flex min-w-0 items-start gap-2">
        <span aria-hidden="true" className="w-3 shrink-0 text-center">
          {marks[step.status]}
        </span>
        <span
          dir="auto"
          className={step.status === "running" ? "min-w-0 flex-1 font-medium" : "min-w-0 flex-1"}
        >
          {step.title}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{labels[step.status]()}</span>
      </div>
      {hasDetail ? (
        <div className="ms-5">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setUserOpen(!open)}
            className="min-h-11 text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >{t`Details`}</button>
          {open ? <StepDetailBody step={step} /> : null}
        </div>
      ) : null}
    </li>
  );
});

/** The ordered Step list with the >8 fold; shared by the standalone section. */
export const StepList = memo(function StepList({
  steps,
  failed,
}: {
  steps: readonly RunStepSnapshot[];
  failed?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const ordered = sortSteps(steps);
  const visible = visibleIndices(ordered, showAll);
  return (
    <>
      <ol className="space-y-1.5">
        {ordered.map((step, index) =>
          visible.has(index) ? (
            <StepRow key={`${step.runId}:${step.stepId}`} step={step} failed={failed === true} />
          ) : null,
        )}
      </ol>
      {ordered.length > 8 ? (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
          className="ms-5 mt-2 min-h-11 text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {showAll ? t`Show less` : t`Show all (${ordered.length - visible.size} more)`}
        </button>
      ) : null}
    </>
  );
});

export const RunStepsDisclosure = memo(function RunStepsDisclosure({
  steps,
  failed,
}: {
  steps: readonly RunStepSnapshot[];
  failed?: boolean;
}) {
  if (steps.length === 0) return null;
  const trouble = steps.filter(
    (step) => step.status === "failed" || step.status === "blocked",
  ).length;
  return (
    <section
      data-slot="steps"
      className="ms-1 my-2 border-s border-border ps-4 text-[13px] text-foreground/85"
    >
      <h3 className="py-2 text-xs font-medium text-muted-foreground">
        {t`Execution progress`}
        {trouble ? (
          <span className="ms-2 font-normal">{t`${trouble} blocked or failed`}</span>
        ) : null}
      </h3>
      <div className="pb-2">
        <StepList steps={steps} failed={failed} />
      </div>
    </section>
  );
});
