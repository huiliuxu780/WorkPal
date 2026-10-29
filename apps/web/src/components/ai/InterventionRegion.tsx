import { t } from "@lingui/core/macro";
import type { InteractionView, InterventionView, ThreadMessage } from "@rakazo/contracts";
import { useEffect, useId, useRef, useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { rpc } from "../../lib/rpc";
import { type AskBlock, AskCard } from "../AskCard";
import { InteractionRegion } from "./interactions/InteractionRegion";
import { PlanReviewCard } from "./PlanReviewCard";

function authorityLabel(view: InterventionView): string {
  if (view.status === "cancelled") return t`Cancelled`;
  if (view.status === "expired" || view.status === "superseded") return t`No longer active`;
  if (view.kind === "approval" && view.approval?.decision === "denied") return t`Denied`;
  if (view.kind === "approval" && view.approval?.decision === "approved") return t`Approved`;
  if (view.input?.mode === "secret") return t`Saved`;
  return t`Answered`;
}

/** Approval effect execution reads separately from the user's decision. */
function effectStatusLabel(status: string): string {
  if (status === "completed") return t`Effect completed`;
  if (status === "approved") return t`Effect approved`;
  if (status === "executing") return t`Effect running`;
  if (status === "failed") return t`Effect failed`;
  if (status === "denied") return t`Effect denied`;
  if (status === "expired") return t`Effect expired`;
  if (status === "intended") return t`Effect pending`;
  if (status === "uncertain" || status === "ambiguous") return t`Effect result unknown`;
  if (status === "reconciled") return t`Effect reconciled`;
  return t`Effect status unavailable`;
}

function presentBlock(
  block: AskBlock,
  view: InterventionView,
  localAnswer: string | null,
): AskBlock {
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

/**
 * Build the card entirely from the server projection. `presentation` is the
 * persisted whitelist snapshot, so a card stays complete even when its source
 * message is not in the current page.
 */
function blockFromView(view: InterventionView): AskBlock {
  const actions = view.approval?.actions ?? view.input?.actions;
  const credential = view.presentation?.credential;
  return {
    kind: "ask",
    text: view.presentation?.text ?? "",
    ...(view.presentation?.detail ? { detail: view.presentation.detail } : {}),
    ...(credential
      ? {
          // AskCard reads only `origin` and the login flag from a credential.
          // The header/basic identities never leave the server-side whitelist.
          credential: {
            name: credential.name,
            origin: credential.origin,
            auth:
              credential.authType === "login"
                ? { type: "login" }
                : credential.authType === "basic"
                  ? { type: "basic", username: "" }
                  : credential.authType === "header"
                    ? { type: "header", name: "authorization" }
                    : { type: "bearer" },
          },
        }
      : {}),
    interventionId: view.id,
    ...(view.approval ? { approvalEffectId: view.approval.effectId } : {}),
    ...(view.input?.mode === "secret" || view.input?.mode === "text"
      ? { input: view.input.mode }
      : {}),
    ...(view.input?.purpose ? { purpose: view.input.purpose } : {}),
    status:
      view.status === "answered" ? "answered" : view.status === "pending" ? "pending" : "expired",
    ...(actions
      ? { actions: actions.map((action) => ({ id: action.id, label: action.label })) }
      : {}),
  };
}

function InterventionCard({
  view,
  block,
  sourceless,
  target,
  onSettled,
  onRefresh,
}: {
  view: InterventionView;
  block: AskBlock;
  /** The card is rebuilt from the projection; its source message is not loaded. */
  sourceless: boolean;
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
    const outbound = view.approval?.outbound?.draft;
    const result = await rpc.threads.resolveIntervention({
      ...target,
      interventionId: view.id,
      clientSubmissionId: submissionId.current,
      answer: text,
      ...(username ? { username } : {}),
      ...(outbound && (text === "allow" || text === "always")
        ? { outbound: { revision: outbound.revision, fingerprint: outbound.fingerprint } }
        : {}),
    });
    if (result.outcome === "accepted") setLocalAnswer(text);
    if (result.outcome === "already_handled") setAnnounce(true);
    onSettled(result.intervention);
    await onRefresh?.().catch(() => undefined);
  }

  // A card restored from the server projection has no local answer echo; the
  // authoritative line states the outcome. `announce` keeps the existing
  // already_handled focus behavior.
  const showAuthority = announce || (sourceless && view.status !== "pending");
  const effectTerminal = view.kind === "approval" && view.status !== "pending" && view.approval;
  return (
    <div data-intervention-id={view.id} data-kind={view.kind} data-mount={mountId}>
      <AskCard
        block={shown}
        canAnswer={view.status === "pending"}
        draftKey={secret || view.status !== "pending" ? undefined : view.id}
        restoreFocus={!announce}
        onAnswer={onAnswer}
      />
      {showAuthority ? (
        <p
          ref={announce ? statusRef : undefined}
          tabIndex={-1}
          role="status"
          data-testid="intervention-authority"
          className="mt-2 text-[13.5px] font-medium text-foreground focus:outline-none"
        >
          {authorityLabel(view)}
        </p>
      ) : null}
      {effectTerminal ? (
        <p
          role="status"
          data-testid="intervention-effect"
          className="mt-1 text-[13px] text-muted-foreground"
        >
          {effectStatusLabel(view.approval!.effectStatus)}
        </p>
      ) : null}
    </div>
  );
}

export function InterventionRegion({
  interventions,
  interactions,
  cardsUnifiedV2,
  messages,
  target,
  botNameOf,
  conversationName,
  groupNameOf,
  onOpenComputer,
  onSettled,
  onRefresh,
}: {
  interventions: readonly InterventionView[];
  /** CARD-01A strict projection; present only when the server gate is on. */
  interactions?: readonly InteractionView[];
  cardsUnifiedV2?: boolean;
  messages: readonly ThreadMessage[];
  target: ArtifactTarget;
  /** UX-02: resolves a Bot display name for the plan review card header. */
  botNameOf?: (botId: string) => string | undefined;
  conversationName?: string;
  groupNameOf?: (groupId: string) => string | undefined;
  onOpenComputer?: (botId: string) => void;
  onSettled: (view: InterventionView) => void;
  onRefresh?: () => Promise<void>;
}) {
  if (cardsUnifiedV2 && interactions) {
    return (
      <InteractionRegion
        interactions={interactions}
        target={target}
        botNameOf={botNameOf}
        conversationName={conversationName}
        groupNameOf={groupNameOf}
        onOpenComputer={onOpenComputer}
        onRefresh={onRefresh}
      />
    );
  }
  const byMessage = new Map(messages.map((message) => [message.id, message]));
  // Decision waits lead: a plan review gates the whole Run, then tool
  // approvals, then ordinary inputs; createdAt orders within one class.
  const rank = (kind: InterventionView["kind"]) =>
    kind === "plan_review" ? 0 : kind === "approval" ? 1 : 2;
  const cards = [...interventions].sort((left, right) => {
    if (left.kind !== right.kind) return rank(left.kind) - rank(right.kind);
    return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
  });
  if (cards.length === 0) return null;
  const planReviews = cards.filter((view) => view.kind === "plan_review");
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
        sourceless={!(ask && ask.kind === "ask")}
        target={target}
        onSettled={onSettled}
        onRefresh={onRefresh}
      />
    );
  };
  return (
    <section aria-label="需要你处理" data-testid="intervention-region" className="space-y-2 py-1">
      {planReviews.length > 0 ? (
        <div data-testid="intervention-plan-reviews" className="space-y-2">
          {planReviews.map((view) => (
            <PlanReviewCard
              key={view.id}
              view={view}
              botName={botNameOf?.(view.botId)}
              target={target}
              onSettled={onSettled}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      ) : null}
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
