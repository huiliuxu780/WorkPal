import type {
  ActivityItem,
  ExecutionSummary,
  InterventionView,
  RunStepSnapshot,
} from "@rakazo/contracts";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { buildExecutionCardModel } from "../../lib/execution-card";
import { deriveExecutionStatus, type ExecutionRunState } from "../../lib/execution-status";
import { ExecutionCard, ExecutionCardContext } from "./ExecutionCard";

/** Enabled interactive controls, in DOM order — the region sorts approvals first. */
const FOCUSABLE_CONTROL =
  'button:not([disabled]):not([aria-disabled="true"]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function ExecutionShell({
  run,
  activity,
  pendingInterventionKinds,
  interventions,
  expansion,
  canExpand,
  summary,
  pendingInterventionViews,
  steps,
  stepsTruncated,
  hasResult,
  resultOnPage,
  confirmedRootBackground,
  children,
}: {
  run: ExecutionRunState | null;
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
  /** Durable per-Run summary (HISTORY-001); null on legacy servers. */
  summary?: ExecutionSummary | null;
  /** Pending Intervention views for this Run, for the card's auxiliary line. */
  pendingInterventionViews?: readonly InterventionView[];
  /** Loaded detail steps — lifecycle rail and failed-step line. */
  steps?: readonly RunStepSnapshot[];
  stepsTruncated?: boolean;
  /** True when the expanded detail renders the Result section. */
  hasResult?: boolean;
  /** The result message bubble is loaded on the current page (canonical result surface). */
  resultOnPage?: boolean;
  /** Trusted root-Run background identity (no production source yet). */
  confirmedRootBackground?: boolean;
  children: ReactNode;
}) {
  const status = deriveExecutionStatus(run, activity, {
    pendingInterventionKinds,
    confirmedRootBackground,
  });
  const live =
    run &&
    ["queued", "leased", "running", "waiting_input", "waiting_takeover"].includes(run.status);
  const [expanded, setExpanded] = useState(Boolean(live) || run?.status === "failed");
  const detailsId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const interventionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (expansion) return;
    if (status.needsAttention) setExpanded(true);
    else if (status.status === "failed") setExpanded(true);
    else if (status.status === "done" || status.status === "cancelled") setExpanded(false);
  }, [status.needsAttention, status.status, expansion]);
  // Server-driven expansion is the single authority when present (one open
  // detail per Thread, waiting Runs included); the legacy local state keeps
  // its attention-forced behavior only for uncontrolled (older-server) shells.
  const open = expansion ? expansion.open : status.needsAttention || expanded;
  const hasDetail =
    Boolean(children) || Boolean(status.detail) || canExpand === true || expansion !== undefined;
  // One derivation feeds the card head and the detail body: same status,
  // same sentence, no second matrix.
  const card = buildExecutionCardModel({
    status,
    summary,
    pendingInterventions: pendingInterventionViews,
    steps,
    stepsTruncated,
    hasResult,
    resultOnPage,
    expanded: open,
    canExpand: hasDetail,
  });
  const focusAttention = () => {
    const control = interventionsRef.current?.querySelector<HTMLElement>(FOCUSABLE_CONTROL);
    if (control) {
      control.focus();
      return;
    }
    // Takeover has no Intervention control: land on the status sentence
    // instead of forcing a scroll jump.
    sectionRef.current?.querySelector<HTMLElement>(".exc-status")?.focus({ preventScroll: true });
  };

  return (
    <section
      ref={sectionRef}
      data-testid="execution-shell"
      data-status={status.status}
      className="min-w-0 px-1 py-1"
    >
      <ExecutionCardContext.Provider value={{ open, auxText: card.aux?.text ?? null }}>
        <ExecutionCard
          card={card}
          open={open}
          hasDetail={hasDetail}
          detailsId={detailsId}
          onToggle={() => {
            if (!hasDetail || status.needsAttention) return;
            if (expansion) expansion.toggle();
            else setExpanded((value) => !value);
          }}
          onAttention={focusAttention}
          interventions={interventions}
          interventionsRef={interventionsRef}
        >
          {children}
        </ExecutionCard>
      </ExecutionCardContext.Provider>
    </section>
  );
}
