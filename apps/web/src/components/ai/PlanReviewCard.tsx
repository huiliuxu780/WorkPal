import { t } from "@lingui/core/macro";
import type { InterventionView, PlanItemStatus } from "@rakazo/contracts";
import { Button, Textarea } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { rpc } from "../../lib/rpc";

/**
 * UX-02 unified plan review card. Renders ONLY backend-projected state: the
 * exact goal/items/version the reviewer is deciding on come from the
 * Intervention's planReview binding — never from Markdown or tool logs. The
 * three actions are fixed ("Go with this plan" / "Request changes" /
 * "Reject"); there is deliberately no "always allow", and approving a plan
 * version never approves any individual tool.
 */

const statusText: Record<PlanItemStatus, () => string> = {
  pending: () => t`Not started`,
  active: () => t`In progress`,
  completed: () => t`Done`,
  skipped: () => t`Skipped`,
  superseded: () => t`Replaced`,
  unresolved: () => t`Unfinished`,
};

const statusMark: Record<PlanItemStatus, string> = {
  pending: "○",
  active: "●",
  completed: "✓",
  skipped: "–",
  superseded: "–",
  unresolved: "!",
};

const VISIBLE_ITEMS = 8;

function decisionLabel(decision: string | undefined, status: string): string {
  if (decision === "approve") return t`Approved`;
  if (decision === "request_changes") return t`Changes requested`;
  if (decision === "reject") return t`Plan rejected`;
  if (status === "cancelled") return t`Cancelled`;
  return t`No longer active`;
}

export function PlanReviewCard({
  view,
  botName,
  target,
  onSettled,
  onRefresh,
}: {
  view: InterventionView;
  botName?: string;
  target: ArtifactTarget;
  onSettled: (view: InterventionView) => void;
  onRefresh?: () => Promise<void>;
}) {
  const review = view.planReview;
  const content = review?.content;
  const submissionId = useRef(crypto.randomUUID());
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [mode, setMode] = useState<"decide" | "changes" | "reject">("decide");
  const [feedback, setFeedback] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const submitting = pendingAction !== null;
  const terminal = view.status !== "pending";

  useEffect(() => {
    if (!announce) return;
    statusRef.current?.focus({ preventScroll: true });
  }, [announce, view.revision, view.status]);

  if (!content) return null;
  const items = showAll ? content.items : content.items.slice(0, VISIBLE_ITEMS);
  const hidden = content.items.length - items.length;

  async function submit(answer: "approve" | "request_changes" | "reject") {
    if (submitting) return;
    const trimmed = feedback.trim();
    // Request-changes requires concrete feedback; the button stays disabled
    // until there is some, and this guard keeps the rule even on stale UI.
    if (answer === "request_changes" && !trimmed) return;
    setPendingAction(answer);
    setError(null);
    setAnnounce(false);
    try {
      const result = await rpc.threads.resolveIntervention({
        ...target,
        interventionId: view.id,
        clientSubmissionId: submissionId.current,
        answer,
        ...(trimmed ? { feedback: trimmed } : {}),
      });
      if (result.outcome === "already_handled") setAnnounce(true);
      onSettled(result.intervention);
      await onRefresh?.().catch(() => undefined);
    } catch (err) {
      // A version-expired or raced decision comes back as a business result:
      // show the honest message and reload so the CURRENT review card appears;
      // the old click never silently applies to new content.
      setError(err instanceof Error ? err.message : t`Could not submit this decision`);
      await onRefresh?.().catch(() => undefined);
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div
      data-testid="plan-review-card"
      data-plan-id={content.planId}
      data-content-version={content.contentVersion}
      data-status={view.status}
      className="max-w-[74%] rounded-2xl border border-border bg-card px-5 py-4"
    >
      <div className="text-[15.5px] leading-[1.5] text-foreground">
        {botName
          ? t`${botName} submitted a plan for your review`
          : t`A plan is waiting for your review`}
        <span
          className="ms-2 align-middle text-xs text-muted-foreground"
          data-testid="plan-review-version"
        >
          {t`Version v${content.contentVersion}`}
        </span>
      </div>
      <p
        dir="auto"
        data-testid="plan-review-goal"
        className="mt-2 text-[13.5px] text-foreground/85"
      >
        {content.goal}
      </p>
      <ol data-testid="plan-review-items" className="mt-2 space-y-1 text-[13px] text-foreground/85">
        {items.map((item) => (
          <li
            key={item.id}
            data-plan-item-id={item.id}
            data-plan-status={item.status}
            className="flex min-w-0 items-start gap-2"
          >
            <span aria-hidden="true" className="w-3 shrink-0 text-center">
              {statusMark[item.status]}
            </span>
            <span dir="auto" className="min-w-0 flex-1">
              {item.title}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {statusText[item.status]()}
            </span>
          </li>
        ))}
      </ol>
      {hidden > 0 || showAll ? (
        <button
          type="button"
          data-testid="plan-review-show-all"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
          className="mt-1.5 min-h-11 text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {showAll ? t`Show less` : t`Show all (${hidden} more)`}
        </button>
      ) : null}
      {terminal ? (
        <p
          ref={announce ? statusRef : undefined}
          tabIndex={-1}
          role="status"
          data-testid="plan-review-authority"
          className="mt-3 text-[13.5px] font-medium text-foreground focus:outline-none"
        >
          {announce && review?.decision === undefined
            ? t`This review was already decided`
            : decisionLabel(review?.decision, view.status)}
          {review?.feedback ? (
            <span dir="auto" className="ms-1 font-normal text-muted-foreground">
              {review.feedback}
            </span>
          ) : null}
        </p>
      ) : mode === "changes" ? (
        <div className="mt-3.5 flex flex-col gap-2">
          <Textarea
            aria-label={t`What should change in this plan?`}
            data-testid="plan-review-feedback"
            value={feedback}
            disabled={submitting}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder={t`Describe the concrete changes you want`}
            rows={3}
          />
          <div className="flex gap-2">
            <Button
              data-testid="plan-review-send-feedback"
              disabled={!feedback.trim() || submitting}
              onClick={() => void submit("request_changes")}
            >
              {submitting && pendingAction === "request_changes" ? t`Sending…` : t`Send feedback`}
            </Button>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setFeedback("");
                setMode("decide");
              }}
            >
              {t`Cancel`}
            </Button>
          </div>
        </div>
      ) : mode === "reject" ? (
        <div className="mt-3.5 flex flex-col gap-2">
          <Textarea
            aria-label={t`Why are you rejecting this plan? (optional)`}
            data-testid="plan-review-reject-reason"
            value={feedback}
            disabled={submitting}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder={t`Reason (optional)`}
            rows={2}
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              data-testid="plan-review-confirm-reject"
              disabled={submitting}
              onClick={() => void submit("reject")}
            >
              {submitting && pendingAction === "reject" ? t`Sending…` : t`Reject plan`}
            </Button>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setFeedback("");
                setMode("decide");
              }}
            >
              {t`Cancel`}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3.5 space-y-1.5">
          <Button
            data-testid="plan-review-approve"
            className="h-auto w-full justify-start whitespace-normal px-3.5 py-3 text-start font-normal"
            disabled={submitting}
            onClick={() => void submit("approve")}
          >
            {submitting && pendingAction === "approve" ? t`Sending…` : t`Go with this plan`}
          </Button>
          <Button
            variant="outline"
            data-testid="plan-review-request-changes"
            className="h-auto w-full justify-start whitespace-normal px-3.5 py-3 text-start font-normal"
            disabled={submitting}
            onClick={() => setMode("changes")}
          >
            {t`Request changes`}
          </Button>
          <Button
            variant="outline"
            data-testid="plan-review-reject"
            className="h-auto w-full justify-start whitespace-normal px-3.5 py-3 text-start font-normal"
            disabled={submitting}
            onClick={() => setMode("reject")}
          >
            {t`Reject`}
          </Button>
        </div>
      )}
      {!terminal && (submitting || error) ? (
        <p
          ref={error ? undefined : statusRef}
          tabIndex={-1}
          role={error ? "alert" : "status"}
          data-testid={error ? "plan-review-error" : "plan-review-submitting"}
          className={`mt-3 text-[13px] focus:outline-none ${error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {error ?? t`Submitting your decision…`}
        </p>
      ) : null}
    </div>
  );
}
