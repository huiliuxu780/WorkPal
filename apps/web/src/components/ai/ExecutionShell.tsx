import type { ActivityItem, Run } from "@rakazo/contracts";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { deriveExecutionStatus } from "../../lib/execution-status";

const marks = {
  planning: "◇",
  working: "◔",
  background: "◔",
  approval: "!",
  need_input: "?",
  blocked: "!",
  takeover: "·",
  done: "✓",
  failed: "×",
  cancelled: "–",
  unknown: "·",
} as const;

const tones = {
  planning: "text-foreground",
  working: "text-foreground",
  background: "text-foreground",
  approval: "text-warning",
  need_input: "text-warning",
  blocked: "text-warning",
  takeover: "text-warning",
  done: "text-success",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
  unknown: "text-muted-foreground",
} as const;

export function ExecutionShell({
  run,
  activity,
  pendingInterventionKinds,
  interventions,
  expansion,
  canExpand,
  children,
}: {
  run: Run | null;
  activity: readonly ActivityItem[];
  /** Present only when the thread snapshot carries an Intervention projection. */
  pendingInterventionKinds?: readonly ("approval" | "input")[];
  /**
   * The Intervention Region for this Run. It renders OUTSIDE the collapsible
   * detail body: a settled card must stay visible in the 「需要你处理」 region
   * after the Run completes, instead of hiding inside a collapsed shell.
   */
  interventions?: ReactNode;
  /**
   * Server-driven expansion (HISTORY-001): the caller owns the open decision
   * (rev-checked sessionStorage, one Run open at a time). Without it the shell
   * keeps its legacy local behavior.
   */
  expansion?: { open: boolean; toggle: () => void };
  /** A summary exists, so opening lazily loads the Run's detail. */
  canExpand?: boolean;
  children: ReactNode;
}) {
  const status = deriveExecutionStatus(run, activity, { pendingInterventionKinds });
  const live = run && ["queued", "leased", "running", "waiting_input", "waiting_takeover"].includes(run.status);
  const [expanded, setExpanded] = useState(Boolean(live) || run?.status === "failed");
  const detailsId = useId();
  useEffect(() => {
    if (expansion) return;
    if (status.needsAttention) setExpanded(true);
    else if (status.status === "failed") setExpanded(true);
    else if (status.status === "done" || status.status === "cancelled") setExpanded(false);
  }, [status.needsAttention, status.status, expansion]);
  const open = status.needsAttention || (expansion ? expansion.open : expanded);
  const hasDetail = Boolean(children) || Boolean(status.detail) || canExpand === true || expansion !== undefined;

  return (
    <section data-testid="execution-shell" data-status={status.status} data-run-id={run?.id} className="min-w-0 px-1 py-1">
      <button
        type="button"
        aria-expanded={hasDetail ? open : undefined}
        aria-controls={hasDetail ? detailsId : undefined}
        aria-disabled={!hasDetail || status.needsAttention || undefined}
        onClick={() => {
          if (!hasDetail || status.needsAttention) return;
          if (expansion) expansion.toggle();
          else setExpanded((value) => !value);
        }}
        className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md text-start text-[14px] leading-5 outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-default"
      >
        <span aria-hidden="true" className={`w-4 shrink-0 text-center font-medium motion-safe:transition-colors motion-safe:duration-200 ${tones[status.status]}`}>
          {marks[status.status]}
        </span>
        <span className={`shrink-0 font-medium motion-safe:transition-colors motion-safe:duration-200 ${tones[status.status]}`}>{status.label}</span>
        {status.detail ? <span dir="auto" className="min-w-0 truncate text-muted-foreground">· {status.detail}</span> : null}
        {hasDetail && !status.needsAttention ? (
          <ChevronDown aria-hidden="true" size={14} className={`ms-auto shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-200 ${open ? "rotate-180" : ""}`} />
        ) : null}
      </button>
      {interventions ? (
        <div data-testid="execution-interventions" className="ms-[7px] ps-3">
          {interventions}
        </div>
      ) : null}
      {hasDetail ? (
        <div
          id={detailsId}
          hidden={!open}
          inert={!open}
          className="ms-[7px] border-s border-border ps-3"
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}
