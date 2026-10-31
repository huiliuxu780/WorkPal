import { t } from "@lingui/core/macro";
import { ClipboardText } from "@phosphor-icons/react";
import type { PlanItemStatus, PlanReviewView } from "@rakazo/contracts";
import { Textarea } from "@rakazo/ui-web";
import { useRef, useState } from "react";
import type { ArtifactTarget } from "../../../lib/artifact-open";
import { rpc } from "../../../lib/rpc";
import {
  InteractionAction,
  InteractionCardShell,
  InteractionNote,
  InteractionSourceLine,
  interactionStatusLabel,
  interactionTone,
} from "./InteractionCardShell";

const statusMark: Record<PlanItemStatus, string> = {
  pending: "○",
  active: "●",
  completed: "✓",
  skipped: "–",
  superseded: "–",
  unresolved: "!",
};

const statusText: Record<PlanItemStatus, () => string> = {
  pending: () => t`Not started`,
  active: () => t`In progress`,
  completed: () => t`Done`,
  skipped: () => t`Skipped`,
  superseded: () => t`Replaced`,
  unresolved: () => t`Unfinished`,
};

function decisionLabel(view: PlanReviewView): string {
  if (view.decision === "approve") return t`Plan approved`;
  if (view.decision === "request_changes") return t`Changes requested`;
  if (view.decision === "reject") return t`Plan rejected`;
  return interactionStatusLabel(view);
}

export function PlanReviewInteractionCard({
  view,
  target,
  botName,
  conversationName,
  onRefresh,
}: {
  view: PlanReviewView;
  target: ArtifactTarget;
  botName?: string;
  conversationName?: string;
  onRefresh?: () => Promise<void>;
}) {
  const submissionId = useRef(crypto.randomUUID());
  const [mode, setMode] = useState<"decide" | "changes" | "reject">("decide");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<"approve" | "request_changes" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const terminal = view.status !== "pending";
  const content = view.plan;

  const submit = async (answer: "approve" | "request_changes" | "reject") => {
    if (busy || terminal) return;
    const trimmed = feedback.trim();
    if (answer === "request_changes" && !trimmed) return;
    setBusy(answer);
    setError(null);
    try {
      const result = await rpc.threads.resolveIntervention({
        ...target,
        interventionId: view.interactionId,
        clientSubmissionId: submissionId.current,
        answer,
        ...(trimmed ? { feedback: trimmed } : {}),
      });
      setSubmitted(true);
      if (result.outcome === "already_handled") setError(t`This review was already decided.`);
      await onRefresh?.().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not submit this decision`);
      await onRefresh?.().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const title = t`Review plan · v${content.contentVersion}`;
  return (
    <InteractionCardShell
      kind="plan_review"
      icon={ClipboardText}
      title={title}
      status={terminal ? decisionLabel(view) : t`Waiting for your review`}
      tone={interactionTone(view)}
      subtitle={content.goal}
      source={
        <InteractionSourceLine
          botName={botName}
          conversationName={conversationName}
          createdAt={view.createdAt}
        />
      }
      actions={
        terminal ? undefined : mode === "decide" ? (
          <>
            <InteractionAction
              disabled={Boolean(busy)}
              onClick={() => setMode("reject")}
              testId="plan-review-reject"
            >
              {t`Reject`}
            </InteractionAction>
            <InteractionAction
              kind="text"
              onClick={() => setMode("changes")}
              testId="plan-review-request-changes"
            >
              {t`Request changes`}
            </InteractionAction>
            <InteractionAction
              kind="primary"
              loading={busy === "approve"}
              onClick={() => void submit("approve")}
              testId="plan-review-approve"
            >
              {t`Approve plan`}
            </InteractionAction>
          </>
        ) : mode === "changes" ? (
          <>
            <InteractionAction
              disabled={Boolean(busy)}
              onClick={() => {
                setFeedback("");
                setMode("decide");
              }}
            >
              {t`Cancel`}
            </InteractionAction>
            <InteractionAction
              kind="primary"
              disabled={!feedback.trim()}
              loading={busy === "request_changes"}
              onClick={() => void submit("request_changes")}
              testId="plan-review-send-feedback"
            >
              {t`Send feedback`}
            </InteractionAction>
          </>
        ) : (
          <>
            <InteractionAction
              disabled={Boolean(busy)}
              onClick={() => {
                setFeedback("");
                setMode("decide");
              }}
            >
              {t`Cancel`}
            </InteractionAction>
            <InteractionAction
              kind="danger"
              loading={busy === "reject"}
              onClick={() => void submit("reject")}
              testId="plan-review-confirm-reject"
            >
              {t`Reject plan`}
            </InteractionAction>
          </>
        )
      }
    >
      <div
        data-testid="plan-review-items"
        className="max-h-52 overflow-auto rounded-xl bg-background px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]"
      >
        <ol className="flex flex-col gap-1.5 text-[13px] leading-[18px]">
          {content.items.map((item) => (
            <li
              key={item.id}
              data-plan-item-id={item.id}
              data-plan-status={item.status}
              className="flex min-w-0 items-start gap-2"
            >
              <span aria-hidden="true" className="w-3 shrink-0 text-center">
                {statusMark[item.status]}
              </span>
              <span className="min-w-0 flex-1 wrap-anywhere" dir="auto">
                {item.title}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {statusText[item.status]()}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <InteractionNote>
        {t`Approving this plan version does not approve any tool, connector, payment, or credential.`}
      </InteractionNote>
      {mode === "changes" ? (
        <Textarea
          aria-label={t`What should change in this plan?`}
          data-testid="plan-review-feedback"
          value={feedback}
          disabled={Boolean(busy)}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder={t`Describe the concrete changes you want`}
          rows={3}
        />
      ) : mode === "reject" ? (
        <Textarea
          aria-label={t`Why are you rejecting this plan? (optional)`}
          data-testid="plan-review-reject-reason"
          value={feedback}
          disabled={Boolean(busy)}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder={t`Reason (optional)`}
          rows={2}
        />
      ) : null}
      {terminal ? (
        <InteractionNote>
          {decisionLabel(view)}
          {view.feedback ? ` · ${view.feedback}` : ""}
        </InteractionNote>
      ) : null}
      {submitted && !terminal ? (
        <InteractionNote>{t`Submitted. Waiting for the current state…`}</InteractionNote>
      ) : null}
      {error ? (
        <p role="alert" data-testid="plan-review-error" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </InteractionCardShell>
  );
}
