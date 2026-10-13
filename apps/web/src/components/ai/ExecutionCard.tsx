import { createContext, type ReactNode, type RefObject, useContext } from "react";
import type { ExecutionCardModel } from "../../lib/execution-card";
import "./execution-card.css";

/**
 * The Execution Card presentation (Task 15.1 v2 design). Pure rendering of an
 * `ExecutionCardModel` built in lib/execution-card.ts — no status derivation,
 * no data fetching, and no identifiers (Run/Thread/Bot/Attempt ids, fences,
 * tool payloads and raw errors never reach this tree).
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
  onToggle,
  onAttention,
  interventions,
  interventionsRef,
  children,
}: {
  card: ExecutionCardModel;
  open: boolean;
  hasDetail: boolean;
  detailsId: string;
  onToggle: () => void;
  onAttention: () => void;
  interventions?: ReactNode;
  interventionsRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const breathing =
    !open && !card.background && (card.status === "working" || card.status === "planning");
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
      <span className="exc-rail" aria-hidden="true">
        <i
          style={
            card.railFill != null ? { height: `${Math.round(card.railFill * 100)}%` } : undefined
          }
        />
      </span>
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
      {card.title ? (
        <h3 className="exc-title" dir="auto">
          {card.title}
        </h3>
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
      {card.action ? (
        <div className="exc-actions">
          <button
            type="button"
            className="exc-entry"
            aria-expanded={hasDetail ? open : undefined}
            aria-controls={hasDetail ? detailsId : undefined}
            onClick={() => {
              if (card.action?.act === "attention") onAttention();
              else onToggle();
            }}
          >
            {card.action.verb}
          </button>
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
