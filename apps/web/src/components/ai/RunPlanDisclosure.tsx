import { t } from "@lingui/core/macro";
import type { RunPlanRevision } from "@rakazo/contracts";
import { memo, useState } from "react";

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

/** Displays a backend-published Plan only. Tool-call summaries and Markdown never enter this component. */
export const RunPlanDisclosure = memo(function RunPlanDisclosure({ plan, live }: { plan: RunPlanRevision; live: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const [reasonId, setReasonId] = useState<string | null>(null);
  const visible = visibleIndices(plan, showAll);
  const effective = plan.items.filter(
    (item) => item.status !== "skipped" && item.status !== "superseded",
  );
  const completed = effective.filter((item) => item.status === "completed").length;
  const current = plan.items.find(
    (item) => item.status === "active" || item.status === "unresolved",
  );
  return (
    <section
      data-slot="plan"
      data-plan-id={plan.planId}
      className="ms-1 my-2 border-s border-border ps-4 text-[13px] text-foreground/85"
    >
      <details key={live ? "live" : "finished"} open={live} className="group">
        <summary className="min-h-11 w-fit cursor-pointer list-none rounded-md py-2 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t`Plan`}
          {plan.revision > 1 ? <span className="ms-1">v{plan.revision}</span> : null}
          {effective.length > 0 ? (
            <>
              {" "}
              · {completed}/{effective.length} {t`done`}
            </>
          ) : null}
          {current ? <span className="ms-2 text-foreground/75">{current.title}</span> : null}
        </summary>
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
        </div>
      </details>
    </section>
  );
});
