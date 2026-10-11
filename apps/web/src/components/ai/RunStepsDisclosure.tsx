import { t } from "@lingui/core/macro";
import type { RunStepSnapshot } from "@rakazo/contracts";
import { memo, useState } from "react";

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

function duration(step: RunStepSnapshot): string | null {
  if (!step.startedAt || !step.completedAt) return null;
  const ms = Date.parse(step.completedAt) - Date.parse(step.startedAt);
  if (!Number.isFinite(ms) || ms < 1_000) return null;
  const seconds = Math.round(ms / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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

export const RunStepsDisclosure = memo(function RunStepsDisclosure({
  steps,
  live,
}: {
  steps: readonly RunStepSnapshot[];
  live: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  if (steps.length === 0) return null;
  const ordered = [...steps].sort(
    (left, right) => left.order - right.order || left.stepId.localeCompare(right.stepId),
  );
  const visible = visibleIndices(ordered, showAll);
  const done = ordered.filter((step) => step.status === "completed").length;
  const unknown = ordered.some((step) => step.status === "unknown");
  const eligible = ordered.filter(
    (step) => step.status !== "skipped" && step.status !== "cancelled",
  ).length;
  const current = ordered.filter((step) => step.status === "running" || step.status === "retrying");
  const trouble = ordered.filter(
    (step) => step.status === "failed" || step.status === "blocked",
  ).length;
  const headline =
    current.length === 1
      ? current[0]?.title
      : current.length > 1
        ? t`${current.length} items in progress`
        : null;
  return (
    <section
      data-slot="steps"
      className="ms-1 my-2 border-s border-border ps-4 text-[13px] text-foreground/85"
    >
      <details key={live ? "live" : "finished"} open={live}>
        <summary className="min-h-11 w-fit cursor-pointer list-none rounded-md py-2 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t`Execution progress`} ·{" "}
          {unknown ? t`${done} done · some statuses unconfirmed` : t`${done}/${eligible} done`}
          {headline ? <span className="ms-2 text-foreground/75">{headline}</span> : null}
          {trouble ? <span className="ms-2">{t`${trouble} blocked or failed`}</span> : null}
        </summary>
        <div className="pb-2">
          <ol className="space-y-1.5">
            {ordered.map((step, index) =>
              visible.has(index) ? (
                <li
                  key={`${step.runId}:${step.stepId}`}
                  data-step-id={step.stepId}
                  data-step-status={step.status}
                  className="min-w-0"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <span aria-hidden="true" className="w-3 shrink-0 text-center">
                      {marks[step.status]}
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
                      {labels[step.status]()}
                      {duration(step) ? ` · ${duration(step)}` : ""}
                    </span>
                  </div>
                  {step.resultSummary ? (
                    <p dir="auto" className="ms-5 text-xs text-muted-foreground">
                      {step.resultSummary}
                    </p>
                  ) : null}
                  {step.batch ? (
                    <p className="ms-5 text-xs tabular-nums text-muted-foreground">
                      {step.batch.processed}
                      {step.batch.total === undefined ? "" : ` / ${step.batch.total}`}{" "}
                      {step.batch.unit}
                    </p>
                  ) : null}
                  {step.attemptNumber || step.evidence.length ? (
                    <div className="ms-5">
                      <button
                        type="button"
                        aria-expanded={detailId === step.stepId}
                        onClick={() => setDetailId(detailId === step.stepId ? null : step.stepId)}
                        className="min-h-11 text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      >{t`Details`}</button>
                      {detailId === step.stepId ? (
                        <p className="border-s border-border ps-2 text-xs text-muted-foreground">
                          {step.attemptNumber ? t`Attempt ${step.attemptNumber}` : null}
                          {step.evidence.length
                            ? ` · ${step.evidence.length} ${t`evidence references`}`
                            : ""}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
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
        </div>
      </details>
    </section>
  );
});
