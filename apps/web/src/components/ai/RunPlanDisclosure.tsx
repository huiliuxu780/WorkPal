import { t } from "@lingui/core/macro";
import type { PlanReviewState, RunPlanRevision, RunStepSnapshot } from "@rakazo/contracts";
import { memo, useState } from "react";
import { StepDetailBody, StepList, stepMarks, stepStatusLabel } from "./RunStepsDisclosure";

/**
 * The structured Plan — the ONLY level-1 list when a Plan exists (UX-01B).
 *
 * - level 1: goal, `v{revision}`, changeReason and the Plan items with their
 *   reported statuses. No a/b fraction here: the card head owns the single
 *   Plan progress.
 * - level 2: each item's semantic Steps matched by `planItemId`, closed
 *   behind the item's Details toggle (auto-open for the failed Step of a
 *   failed Run — the "View reason" target).
 * - Steps that match no item stay reachable under an explicit "Other
 *   execution records" entry; nothing is silently dropped.
 *
 * Displays a backend-published Plan only. Tool-call summaries, Activity and
 * Markdown never enter this component, and the `live` auto-expansion is gone.
 */

const statusText: Record<RunPlanRevision["items"][number]["status"], () => string> = {
  pending: () => t`Not started`,
  active: () => t`In progress`,
  completed: () => t`Done`,
  skipped: () => t`Skipped`,
  superseded: () => t`Replaced`,
  unresolved: () => t`Unfinished`,
};

const statusMark: Record<RunPlanRevision["items"][number]["status"], string> = {
  pending: "○",
  active: "●",
  completed: "✓",
  skipped: "–",
  superseded: "–",
  unresolved: "!",
};

function visibleIndices(plan: RunPlanRevision, expanded: boolean): Set<number> {
  if (expanded || plan.items.length <= 8) return new Set(plan.items.map((_, index) => index));
  const indices = new Set([0, 1]);
  for (const [index, item] of plan.items.entries()) {
    if (item.status === "active" || item.status === "unresolved") {
      indices.add(index);
      if (index + 1 < plan.items.length) indices.add(index + 1);
    }
  }
  return indices;
}

function sortSteps(steps: readonly RunStepSnapshot[]): RunStepSnapshot[] {
  return [...steps].sort(
    (left, right) => left.order - right.order || left.stepId.localeCompare(right.stepId),
  );
}

const PlanItemSteps = memo(function PlanItemSteps({
  steps,
  failed,
}: {
  steps: readonly RunStepSnapshot[];
  failed: boolean;
}) {
  const hasFailedMatch = steps.some((step) => step.status === "failed");
  const [userOpen, setUserOpen] = useState(false);
  // Derived like StepRow: the Run can fail while this list stays mounted.
  const open = userOpen || (failed && hasFailedMatch);
  return (
    <div className="ms-5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
        className="min-h-11 text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      >{t`Details`}</button>
      {open ? (
        <div
          data-testid="plan-item-steps"
          {...(hasFailedMatch ? { "data-failure-target": "", tabIndex: -1 } : {})}
          className="space-y-1.5 pb-1"
        >
          {steps.map((step) => (
            <div
              key={`${step.runId}:${step.stepId}`}
              data-step-id={step.stepId}
              data-step-status={step.status}
              className="min-w-0"
            >
              <div className="flex min-w-0 items-start gap-2">
                <span aria-hidden="true" className="w-3 shrink-0 text-center">
                  {stepMarks(step.status)}
                </span>
                <span
                  dir="auto"
                  className={
                    step.status === "running" ? "min-w-0 flex-1 font-medium" : "min-w-0 flex-1"
                  }
                >
                  {step.title}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {stepStatusLabel(step.status)}
                </span>
              </div>
              <div className="ms-5">
                <StepDetailBody step={step} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
});

/**
 * UX-02 version chip: a reviewed plan shows its CONTENT version — the
 * approval basis — instead of the raw progress revision counter. Legacy plans
 * (no review state) keep the historical `v{revision}` display.
 */
function reviewChip(review: PlanReviewState): string | null {
  if (review.reviewStatus === "pending") return t`Awaiting your review`;
  if (review.reviewStatus === "changes_requested") return t`Changes requested`;
  if (review.reviewStatus === "rejected") return t`Rejected`;
  if (review.reviewStatus === "cancelled") return t`Review cancelled`;
  return null;
}

export const RunPlanDisclosure = memo(function RunPlanDisclosure({
  plan,
  steps,
  failed,
  review,
}: {
  plan: RunPlanRevision;
  /** The Run's semantic Steps; grouped under items by `planItemId`. */
  steps: readonly RunStepSnapshot[];
  /** The Run failed: the failed Step's level 2 opens as the reason target. */
  failed?: boolean;
  /** Unified plan review state; absent for legacy plans. */
  review?: PlanReviewState;
}) {
  const [showAll, setShowAll] = useState(false);
  const [reasonId, setReasonId] = useState<string | null>(null);
  const visible = visibleIndices(plan, showAll);
  const itemIds = new Set(plan.items.map((item) => item.id));
  const matched = new Map<string, RunStepSnapshot[]>();
  const others: RunStepSnapshot[] = [];
  for (const step of sortSteps(steps)) {
    if (step.planItemId && itemIds.has(step.planItemId)) {
      matched.set(step.planItemId, [...(matched.get(step.planItemId) ?? []), step]);
    } else {
      others.push(step);
    }
  }
  return (
    <section
      data-slot="plan"
      data-plan-id={plan.planId}
      className="ms-1 my-2 border-s border-border ps-4 text-[13px] text-foreground/85"
    >
      <h3 className="py-2 text-xs font-medium text-muted-foreground">
        {t`Plan`}
        {review ? (
          <span className="ms-1" data-testid="plan-content-version">
            v{review.contentVersion}
          </span>
        ) : plan.revision > 1 ? (
          <span className="ms-1">v{plan.revision}</span>
        ) : null}
        {review ? (
          (() => {
            const chip = reviewChip(review);
            return chip ? (
              <span className="ms-2" data-testid="plan-review-state">
                {chip}
              </span>
            ) : null;
          })()
        ) : null}
      </h3>
      <div className="pb-2">
        <p dir="auto" className="mb-2 text-foreground/80">
          {plan.goal}
        </p>
        {plan.revision > 1 && plan.changeReason ? (
          <p dir="auto" className="mb-2 text-xs text-muted-foreground">
            {t`Plan updated`}: {plan.changeReason}
          </p>
        ) : null}
        <ol className="space-y-1.5">
          {plan.items.map((item, index) =>
            visible.has(index) ? (
              <li
                key={item.id}
                data-plan-item-id={item.id}
                data-plan-status={item.status}
                className="min-w-0"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <span aria-hidden="true" className="w-3 shrink-0 text-center">
                    {statusMark[item.status]}
                  </span>
                  <span
                    dir="auto"
                    className={
                      item.status === "active" ? "min-w-0 flex-1 font-medium" : "min-w-0 flex-1"
                    }
                  >
                    {item.title}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {statusText[item.status]()}
                  </span>
                </div>
                {item.reason &&
                (item.status === "skipped" ||
                  item.status === "superseded" ||
                  item.status === "unresolved") ? (
                  <div className="ms-5">
                    <button
                      type="button"
                      aria-expanded={reasonId === item.id}
                      onClick={() => setReasonId(reasonId === item.id ? null : item.id)}
                      className="min-h-11 text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >{t`View reason`}</button>
                    {reasonId === item.id ? (
                      <p dir="auto" className="pb-1 text-xs text-muted-foreground">
                        {item.reason}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {(matched.get(item.id) ?? []).length > 0 ? (
                  <PlanItemSteps steps={matched.get(item.id)!} failed={failed === true} />
                ) : null}
              </li>
            ) : null,
          )}
        </ol>
        {plan.items.length > 8 ? (
          <button
            type="button"
            aria-expanded={showAll}
            onClick={() => setShowAll(!showAll)}
            className="ms-5 mt-2 min-h-11 text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {showAll ? t`Show less` : t`Show all (${plan.items.length - visible.size} more)`}
          </button>
        ) : null}
        {others.length > 0 ? (
          <section data-slot="steps" className="mt-2 border-s border-border ps-4">
            <h4 className="py-1 text-xs font-medium text-muted-foreground">
              {t`Other execution records`}
            </h4>
            <StepList steps={others} failed={failed} />
          </section>
        ) : null}
      </div>
    </section>
  );
});
