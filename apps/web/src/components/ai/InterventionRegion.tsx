import { t } from "@lingui/core/macro";
import type { InterventionView, ThreadMessage } from "@rakazo/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { AskCard, type AskBlock } from "../AskCard";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { rpc } from "../../lib/rpc";

function authorityLabel(view: InterventionView): string {
  if (view.status === "cancelled") return t`Cancelled`;
  if (view.status === "expired" || view.status === "superseded") return t`No longer active`;
  if (view.kind === "approval" && view.approval?.decision === "denied") return t`Denied`;
  if (view.kind === "approval" && view.approval?.decision === "approved") return t`Approved`;
  if (view.input?.mode === "secret") return t`Saved`;
  return t`Answered`;
}

function presentBlock(block: AskBlock, view: InterventionView, localAnswer: string | null): AskBlock {
  if (view.status === "pending") return { ...block, interventionId: view.id, status: "pending" };
  if (view.status !== "answered") return { ...block, interventionId: view.id, status: "expired" };
  const messageAnswer = block.status === "answered" ? block.answer : undefined;
  const decisionAnswer = view.approval?.decision === "denied" ? "deny" : undefined;
  return {
    ...block,
    interventionId: view.id,
    status: "answered",
    answer: block.input === "secret" ? "" : (messageAnswer ?? localAnswer ?? decisionAnswer),
  };
}

function blockFromView(view: InterventionView): AskBlock {
  const actions = view.approval?.actions ?? view.input?.actions;
  return {
    kind: "ask",
    text: "",
    interventionId: view.id,
    ...(view.approval
      ? { approvalEffectId: view.approval.effectId }
      : {}),
    ...(view.input?.mode === "secret" || view.input?.mode === "text"
      ? { input: view.input.mode }
      : {}),
    ...(view.input?.purpose ? { purpose: view.input.purpose } : {}),
    status: "pending",
    ...(actions ? { actions: actions.map((action) => ({ id: action.id, label: action.label })) } : {}),
  };
}

function InterventionCard({
  view,
  block,
  target,
  onSettled,
  onRefresh,
}: {
  view: InterventionView;
  block: AskBlock;
  target: ArtifactTarget;
  onSettled: (view: InterventionView) => void;
  onRefresh?: () => Promise<void>;
}) {
  const mountId = useId();
  const submissionId = useRef(crypto.randomUUID());
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [localAnswer, setLocalAnswer] = useState<string | null>(null);
  const [announce, setAnnounce] = useState(false);
  const shown = presentBlock(block, view, announce ? null : localAnswer);
  const secret = shown.input === "secret";

  useEffect(() => {
    if (!announce) return;
    statusRef.current?.focus({ preventScroll: true });
  }, [announce, view.revision, view.status]);

  async function onAnswer(text: string, username?: string) {
    const result = await rpc.threads.resolveIntervention({
      ...target,
      interventionId: view.id,
      clientSubmissionId: submissionId.current,
      answer: text,
      ...(username ? { username } : {}),
    });
    if (result.outcome === "accepted") setLocalAnswer(text);
    if (result.outcome === "already_handled") setAnnounce(true);
    onSettled(result.intervention);
    await onRefresh?.().catch(() => undefined);
  }

  return (
    <div data-intervention-id={view.id} data-kind={view.kind} data-mount={mountId}>
      <AskCard
        block={shown}
        canAnswer={view.status === "pending"}
        draftKey={secret || view.status !== "pending" ? undefined : view.id}
        restoreFocus={!announce}
        onAnswer={onAnswer}
      />
      {announce ? (
        <p
          ref={statusRef}
          tabIndex={-1}
          role="status"
          data-testid="intervention-authority"
          className="mt-2 text-[13.5px] font-medium text-foreground focus:outline-none"
        >
          {authorityLabel(view)}
        </p>
      ) : null}
    </div>
  );
}

export function InterventionRegion({
  interventions,
  messages,
  target,
  onSettled,
  onRefresh,
}: {
  interventions: readonly InterventionView[];
  messages: readonly ThreadMessage[];
  target: ArtifactTarget;
  onSettled: (view: InterventionView) => void;
  onRefresh?: () => Promise<void>;
}) {
  const byMessage = new Map(messages.map((message) => [message.id, message]));
  const cards = [...interventions].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "approval" ? -1 : 1;
    return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
  });
  if (cards.length === 0) return null;
  const approvals = cards.filter((view) => view.kind === "approval");
  const inputs = cards.filter((view) => view.kind === "input");
  const renderCard = (view: InterventionView) => {
    const message = byMessage.get(view.messageId);
    const ask = message?.blocks.find((block) => block.kind === "ask");
    const block = ask && ask.kind === "ask" ? ask : blockFromView(view);
    return (
      <InterventionCard
        key={view.id}
        view={view}
        block={block}
        target={target}
        onSettled={onSettled}
        onRefresh={onRefresh}
      />
    );
  };
  return (
    <section role="region" aria-label="需要你处理" data-testid="intervention-region" className="space-y-2 py-1">
      {approvals.length > 0 ? (
        <div data-testid="intervention-approvals" className="space-y-2">
          {approvals.map(renderCard)}
        </div>
      ) : null}
      {inputs.length > 0 ? (
        <div data-testid="intervention-inputs" className="space-y-2">
          {inputs.map(renderCard)}
        </div>
      ) : null}
    </section>
  );
}
