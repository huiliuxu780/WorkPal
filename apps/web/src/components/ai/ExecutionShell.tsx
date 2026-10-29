import type {
  ActivityItem,
  ExecutionSummary,
  InteractionView,
  InterventionView,
  RunPlanRevision,
  RunStepSnapshot,
} from "@rakazo/contracts";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { buildExecutionCardModel } from "../../lib/execution-card";
import { deriveExecutionStatus, type ExecutionRunState } from "../../lib/execution-status";
import { ExecutionCard, ExecutionCardContext } from "./ExecutionCard";

/** Enabled interactive controls, in DOM order — the region sorts approvals first. */
export const FOCUSABLE_CONTROL =
  'button:not([disabled]):not([aria-disabled="true"]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** The revision flash is short-lived by design; timers are always cleaned up. */
export const PLAN_UPDATED_FLASH_MS = 3_000;

export function ExecutionShell({
  run,
  activity,
  pendingInterventionKinds,
  interventions,
  expansion,
  canExpand,
  summary,
  pendingInterventionViews,
  pendingInteractionViews,
  plan,
  steps,
  now,
  hasResult,
  resultOnPage,
  confirmedRootBackground,
  retrying,
  retryError,
  onRetry,
  onViewSuccessor,
  children,
}: {
  run: ExecutionRunState | null;
  activity: readonly ActivityItem[];
  /** Present only when the thread snapshot carries an Intervention projection. */
  pendingInterventionKinds?: readonly ("approval" | "input" | "plan_review")[];
  /**
   * The Intervention Region for this Run. It renders OUTSIDE the collapsible
   * detail body: a pending card stays visible and operable while the detail
   * is collapsed (UX-01B acceptance 7), and a settled card of an eligible
   * Run keeps its 「需要你处理」 surface.
   */
  interventions?: ReactNode;
  /**
   * Server-driven expansion (HISTORY-001): the caller owns the open decision
   * (rev-checked sessionStorage, one Run open at a time). Without it the shell
   * keeps its legacy local behavior. Either way the DEFAULT is collapsed —
   * running and failed Runs never auto-expand (UX-01B acceptance 4).
   */
  expansion?: { open: boolean; toggle: () => void };
  /** A summary exists, so opening lazily loads the Run's detail. */
  canExpand?: boolean;
  /** Durable per-Run summary (HISTORY-001); null on legacy servers. */
  summary?: ExecutionSummary | null;
  /** Pending Intervention views for this Run, for the card's auxiliary line. */
  pendingInterventionViews?: readonly InterventionView[];
  /** CARD-01B pending views; preferred for the headline when present. */
  pendingInteractionViews?: readonly InteractionView[];
  /** The backend-published structured Plan — the only progress source. */
  plan?: RunPlanRevision | null;
  /** Loaded semantic steps — failed-step line and current-item elapsed. */
  steps?: readonly RunStepSnapshot[];
  /** Evaluation time for the current-item elapsed; injected by tests. */
  now?: number;
  /** True when the expanded detail renders the Result section. */
  hasResult?: boolean;
  /** The result message bubble is loaded on the current page (canonical result surface). */
  resultOnPage?: boolean;
  /** Trusted root-Run background identity (no production source yet). */
  confirmedRootBackground?: boolean;
  retrying?: boolean;
  retryError?: string | null;
  onRetry?: () => void;
  onViewSuccessor?: () => void;
  children: ReactNode;
}) {
  const status = deriveExecutionStatus(run, activity, {
    pendingInterventionKinds,
    confirmedRootBackground,
  });
  // UX-01B: no auto-expansion. Uncontrolled shells start collapsed and only
  // collapse further when the Run reaches a terminal state; every open is an
  // explicit user action (or the execution-nav / sidebar return intent).
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const interventionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (expansion) return;
    if (status.status === "done" || status.status === "cancelled") setExpanded(false);
  }, [status.status, expansion]);
  // Server-driven expansion is the single authority when present (one open
  // detail per Thread); the legacy local state stays for uncontrolled shells.
  const open = expansion ? expansion.open : expanded;
  const hasDetail =
    Boolean(children) || Boolean(status.detail) || canExpand === true || expansion !== undefined;
  // One derivation feeds the card head and the detail body: same status,
  // same sentence, no second matrix.
  const card = buildExecutionCardModel({
    status,
    summary,
    pendingInterventions: pendingInterventionViews,
    pendingInteractions: pendingInteractionViews,
    ...(plan ? { plan } : {}),
    steps,
    ...(now !== undefined ? { now } : {}),
    hasResult,
    resultOnPage,
    expanded: open,
    canExpand: hasDetail,
    retrying,
  });

  // Plan revision flash (acceptance 9): only a GROWING revision on the same
  // mounted Run flashes — first mount, the first Plan sighting, a repeated or
  // stale revision never do. The timer is cleaned up on unmount and re-flash.
  const planRevision = plan?.revision ?? null;
  const seenPlanRevision = useRef<number | null>(null);
  const [planUpdated, setPlanUpdated] = useState(false);
  useEffect(() => {
    if (planRevision === null) {
      seenPlanRevision.current = null;
      return;
    }
    const previous = seenPlanRevision.current;
    if (previous === null) {
      seenPlanRevision.current = planRevision;
      return;
    }
    if (planRevision <= previous) return;
    seenPlanRevision.current = planRevision;
    setPlanUpdated(true);
    const timer = window.setTimeout(() => setPlanUpdated(false), PLAN_UPDATED_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [planRevision]);

  // "View reason" landing (acceptance 8 + review round P2): when a failed
  // card is open, land on its failure target — the failed Step's level-2
  // detail when one exists, the Run-level safe reason otherwise (both carry
  // data-failure-target). The detail can arrive ASYNC after the card opened,
  // so the effect re-runs whenever the failed Step identity changes and moves
  // focus to a newly-appeared target (it never steals focus once that exact
  // target is already the one it landed on).
  const failedStepId = steps?.find((step) => step.status === "failed")?.stepId ?? null;
  const focusedFailureTarget = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open || status.status !== "failed") {
      focusedFailureTarget.current = null;
      return;
    }
    const target = sectionRef.current?.querySelector<HTMLElement>("[data-failure-target]");
    if (!target || target === focusedFailureTarget.current) return;
    focusedFailureTarget.current = target;
    target.focus({ preventScroll: true });
  }, [open, status.status, failedStepId]);

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
          planUpdated={planUpdated}
          onToggle={() => {
            if (!hasDetail) return;
            if (expansion) expansion.toggle();
            else setExpanded((value) => !value);
          }}
          onAttention={focusAttention}
          onRetry={onRetry}
          onViewSuccessor={onViewSuccessor}
          retrying={retrying}
          retryError={retryError}
          interventions={interventions}
          interventionsRef={interventionsRef}
        >
          {children}
        </ExecutionCard>
      </ExecutionCardContext.Provider>
    </section>
  );
}
