import { createContext, type ReactNode, type RefObject, useContext } from "react";
import type { ExecutionCardModel } from "../../lib/execution-card";
import "./execution-card.css";

/**
 * The Execution Card presentation (Task 15.1 v2 design + UX-01B convergence).
 * Pure rendering of an `ExecutionCardModel` built in lib/execution-card.ts —
 * no status derivation, no data fetching, and no identifiers (Run/Thread/Bot
 * /Attempt ids, fences, tool payloads and raw errors never reach this tree).
 *
 * UX-01B: the progress rail renders ONLY when the model carries a structured
 * Plan progress — one accessible bar, one a/b count, both from the same pure
 * result. Without a Plan there is no rail base, no fill and no placeholder.
 */

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

/**
 * Card ↔ detail continuity: the card head owns the status sentence and the
 * current-activity line, so the expanded detail yields its duplicate primary
 * activity line (one object, one sentence). Null when rendered standalone.
 */
export type ExecutionCardYield = {
  open: boolean;
  auxText: string | null;
};
export const ExecutionCardContext = createContext<ExecutionCardYield | null>(null);
export function useExecutionCardYield(): ExecutionCardYield | null {
  return useContext(ExecutionCardContext);
}

export function ExecutionCard({
  card,
  open,
  hasDetail,
  detailsId,
  planUpdated,
  onToggle,
  onAttention,
  onNavigate,
  interventions,
  interventionsRef,
  children,
}: {
  card: ExecutionCardModel;
  open: boolean;
  hasDetail: boolean;
  detailsId: string;
  /** Shell-owned 3s revision flash (UX-01B acceptance 9). */
  planUpdated?: boolean;
  onToggle: () => void;
  onAttention: () => void;
  /** Task Center second entry: the primary action returns to the conversation. */
  onNavigate?: () => void;
  interventions?: ReactNode;
  interventionsRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const breathing =
    !open && !card.background && (card.status === "working" || card.status === "planning");
  const progress = card.planProgress;
  return (
    <article
      data-testid="execution-card"
      data-status={card.status}
      data-open={open ? "1" : "0"}
      data-live={card.live && !open ? "1" : "0"}
      data-background={card.background ? "1" : undefined}
      data-attention={card.needsAttention ? "1" : undefined}
      aria-label={card.title ? `${card.statusLabel} ${card.title}` : card.statusLabel}
      className="exc-card"
    >
      {progress ? (
        <span
          className="exc-rail"
          role="progressbar"
          aria-label={progress.label}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.completed}
        >
          <i style={{ height: `${Math.round(progress.fraction * 100)}%` }} />
        </span>
      ) : null}
      <div className="exc-head">
        <span
          className="exc-glyph"
          data-status={card.status}
          aria-hidden="true"
          {...(breathing ? { "data-breath": "1" } : {})}
        >
          {marks[card.status]}
        </span>
        <p className="exc-status" tabIndex={-1}>
          {card.statusLabel}
        </p>
        {card.when ? <time className="exc-when">{card.when}</time> : null}
      </div>
      {card.title || progress ? (
        <div className="exc-title-row">
          {card.title ? (
            <h3 className="exc-title" dir="auto">
              {card.title}
            </h3>
          ) : null}
          {progress ? (
            <span className="exc-count" data-testid="execution-plan-count">
              {progress.completed}/{progress.total}
            </span>
          ) : null}
        </div>
      ) : null}
      {card.aux ? (
        <p className="exc-line" data-kind={card.aux.kind} dir="auto">
          {card.aux.text}
        </p>
      ) : null}
      {card.artifactsLine ? (
        <p className="exc-line" data-kind="artifacts" dir="auto">
          {card.artifactsLine}
        </p>
      ) : null}
      {card.metaParts.length > 0 ? <p className="exc-meta">{card.metaParts.join(" · ")}</p> : null}
      {planUpdated ? (
        <p
          className="exc-flash"
          role="status"
          aria-live="polite"
          data-testid="execution-plan-updated"
        >
          {card.planUpdatedLabel}
        </p>
      ) : null}
      {card.action || card.secondaryAction ? (
        <div className="exc-actions">
          {card.action ? (
            <button
              type="button"
              className="exc-entry"
              aria-expanded={card.action.act === "toggle" && hasDetail ? open : undefined}
              aria-controls={card.action.act === "toggle" && hasDetail ? detailsId : undefined}
              onClick={() => {
                if (card.action?.act === "attention") onAttention();
                else if (card.action?.act === "navigate") onNavigate?.();
                else onToggle();
              }}
            >
              {card.action.verb}
            </button>
          ) : null}
          {card.secondaryAction ? (
            <button
              type="button"
              className="exc-entry"
              aria-expanded={hasDetail ? open : undefined}
              aria-controls={hasDetail ? detailsId : undefined}
              onClick={onToggle}
            >
              {card.secondaryAction.verb}
            </button>
          ) : null}
        </div>
      ) : null}
      {interventions ? (
        <div
          ref={interventionsRef}
          data-testid="execution-interventions"
          className="exc-interventions"
        >
          {interventions}
        </div>
      ) : null}
      {hasDetail ? (
        <div id={detailsId} hidden={!open} inert={!open} className="exc-details">
          {children}
        </div>
      ) : null}
    </article>
  );
}
