import { t } from "@lingui/core/macro";
import type { ActionApprovalView } from "@rakazo/contracts";
import { abortableDelay } from "@rakazo/core";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ArtifactTarget } from "../../../lib/artifact-open";
import { connectMcpOauth } from "../../../lib/mcp-connect";
import { rpc } from "../../../lib/rpc";
import {
  InteractionAction,
  InteractionCardShell,
  InteractionKeyValue,
  InteractionNote,
  InteractionSourceLine,
  InteractionStatusBadge,
  interactionStatusLabel,
  interactionTone,
} from "./InteractionCardShell";

type Approval = ActionApprovalView["approval"];
type ToolApproval = Extract<Approval, { kind: "tool" }>;
type PaymentApproval = Extract<Approval, { kind: "payment" }>;
type OutboundApproval = Extract<Approval, { kind: "outbound" }>;
type RoutineApproval = Extract<Approval, { kind: "routine" }>;
type InstallApproval = Extract<Approval, { kind: "install" }>;
type SkillSaveApproval = Extract<Approval, { kind: "skill_save" }>;
type AppAuthorizationApproval = Extract<Approval, { kind: "connect.app_authorization" }>;
type McpAssignmentApproval = Extract<Approval, { kind: "connect.mcp_assignment" }>;
type GroupMembershipApproval = Extract<Approval, { kind: "group_membership" }>;

function effectLabel(status: string): string {
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

function actionLabel(id: string, fallback: string, toolActions: boolean): string {
  if (!toolActions && fallback) return fallback;
  if (id === "allow" || id === "approve") return t`Allow once`;
  if (id === "always") return t`Always allow this tool`;
  if (id === "deny" || id === "reject") return t`Deny`;
  return fallback;
}

function useDecision({
  view,
  target,
  onRefresh,
}: {
  view: ActionApprovalView;
  target: ArtifactTarget;
  onRefresh?: () => Promise<void>;
}) {
  const submissionId = useRef(crypto.randomUUID());
  const [busyAnswer, setBusyAnswer] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (answer: string) => {
    if (busyAnswer || view.status !== "pending") return;
    setBusyAnswer(answer);
    setError(null);
    try {
      const result = await rpc.threads.resolveIntervention({
        ...target,
        interventionId: view.interactionId,
        clientSubmissionId: submissionId.current,
        answer,
      });
      setSubmitted(true);
      if (result.outcome === "already_handled") setError(t`This request was already handled.`);
      await onRefresh?.().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not submit this decision`);
    } finally {
      setBusyAnswer(null);
    }
  };
  return { busyAnswer, submitted, error, decide };
}

function DecisionButtons({
  view,
  actions,
  busyAnswer,
  onDecide,
  toolActions = false,
}: {
  view: ActionApprovalView;
  actions: Array<{ id: string; label: string }>;
  busyAnswer: string | null;
  onDecide: (answer: string) => void;
  toolActions?: boolean;
}) {
  const [showMore, setShowMore] = useState(false);
  if (view.status !== "pending") return null;
  if (actions.length === 0) {
    return (
      <InteractionAction
        kind="primary"
        disabled
        onClick={() => undefined}
        testId="approval-unavailable"
      >
        {t`Not available yet`}
      </InteractionAction>
    );
  }
  const primary =
    actions.find((action) => action.id === "allow" || action.id === "approve") ?? actions[0]!;
  const secondary =
    actions.find((action) => action.id === "deny" || action.id === "reject") ??
    actions.find((action) => action.id !== primary.id);
  const extra = actions.filter((action) => action.id !== primary.id && action.id !== secondary?.id);
  return (
    <>
      {secondary ? (
        <InteractionAction
          disabled={Boolean(busyAnswer)}
          loading={busyAnswer === secondary.id}
          onClick={() => onDecide(secondary.id)}
          testId="approval-secondary"
        >
          {actionLabel(secondary.id, secondary.label, toolActions)}
        </InteractionAction>
      ) : null}
      {extra.length > 0 ? (
        <InteractionAction kind="text" onClick={() => setShowMore(true)} testId="approval-more">
          {t`More options`}
        </InteractionAction>
      ) : null}
      <InteractionAction
        kind={primary.id === "deny" || primary.id === "reject" ? "danger" : "primary"}
        disabled={Boolean(busyAnswer)}
        loading={busyAnswer === primary.id}
        onClick={() => onDecide(primary.id)}
        testId="approval-primary"
      >
        {actionLabel(primary.id, primary.label, toolActions)}
      </InteractionAction>
      {showMore ? (
        <Dialog open onOpenChange={setShowMore}>
          <DialogContent showCloseButton={false} className="max-w-sm">
            <DialogTitle>{t`More options`}</DialogTitle>
            <div className="flex flex-col gap-2">
              {extra.map((action) => (
                <Button
                  key={action.id}
                  variant="outline"
                  disabled={Boolean(busyAnswer)}
                  onClick={() => {
                    setShowMore(false);
                    onDecide(action.id);
                  }}
                >
                  {actionLabel(action.id, action.label, toolActions)}
                </Button>
              ))}
              <DialogClose render={<Button variant="ghost" />}>{t`Cancel`}</DialogClose>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function TerminalNote({ view, effectStatus }: { view: ActionApprovalView; effectStatus?: string }) {
  if (view.status !== "pending") {
    return (
      <div className="flex flex-col gap-1" role="status">
        <InteractionNote>{interactionStatusLabel(view)}</InteractionNote>
        {effectStatus ? (
          <p data-testid="approval-effect" className="text-[12px] text-muted-foreground">
            {effectLabel(effectStatus)}
          </p>
        ) : null}
      </div>
    );
  }
  return null;
}

function ToolApprovalCard({
  view,
  approval,
  target,
  botName,
  conversationName,
  onRefresh,
}: {
  view: ActionApprovalView;
  approval: ToolApproval;
  target: ArtifactTarget;
  botName?: string;
  conversationName?: string;
  onRefresh?: () => Promise<void>;
}) {
  const { busyAnswer, submitted, error, decide } = useDecision({ view, target, onRefresh });
  return (
    <InteractionCardShell
      kind="action_approval"
      icon="⌘"
      title={view.presentation.text || t`Approval needed`}
      status={interactionStatusLabel(view)}
      tone={interactionTone(view)}
      subtitle={view.presentation.detail}
      source={
        <InteractionSourceLine
          botName={botName}
          conversationName={conversationName}
          createdAt={view.createdAt}
          revision={view.revision}
        />
      }
      actions={
        <DecisionButtons
          view={view}
          actions={approval.actions}
          busyAnswer={busyAnswer}
          onDecide={(answer) => void decide(answer)}
          toolActions
        />
      }
    >
      <InteractionNote>
        {t`This decision allows the action once; completing the tool activity does not prove the external result.`}
      </InteractionNote>
      {submitted && view.status === "pending" ? (
        <InteractionNote>{t`Submitted. Waiting for the current state…`}</InteractionNote>
      ) : null}
      <TerminalNote view={view} effectStatus={approval.effectStatus} />
      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </InteractionCardShell>
  );
}

function PaymentApprovalCard({
  view,
  approval,
  target,
  botName,
  conversationName,
  onRefresh,
}: {
  view: ActionApprovalView;
  approval: PaymentApproval;
  target: ArtifactTarget;
  botName?: string;
  conversationName?: string;
  onRefresh?: () => Promise<void>;
}) {
  const { busyAnswer, submitted, error, decide } = useDecision({ view, target, onRefresh });
  return (
    <InteractionCardShell
      kind="action_approval"
      icon="¥"
      title={view.presentation.text || t`Payment approval`}
      status={interactionStatusLabel(view)}
      tone={interactionTone(view)}
      source={
        <InteractionSourceLine
          botName={botName}
          conversationName={conversationName}
          createdAt={view.createdAt}
          revision={view.revision}
        />
      }
      actions={
        <DecisionButtons
          view={view}
          actions={[
            { id: "deny", label: t`Decline payment` },
            { id: "approve", label: t`Confirm payment` },
          ]}
          busyAnswer={busyAnswer}
          onDecide={(answer) => void decide(answer)}
        />
      }
    >
      <InteractionKeyValue
        rows={[
          { label: t`Merchant`, value: approval.merchant },
          { label: t`Amount`, value: `${approval.currency} ${approval.amount}` },
          { label: t`Card`, value: `•••• ${approval.cardLast4}`, mono: true },
        ]}
      />
      <InteractionNote>{t`The payment result comes from the payment transaction, not from tool activity.`}</InteractionNote>
      {submitted && view.status === "pending" ? (
        <InteractionNote>{t`Submitted. Waiting for the current state…`}</InteractionNote>
      ) : null}
      <TerminalNote view={view} effectStatus={approval.effectStatus} />
      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </InteractionCardShell>
  );
}

function OutboundApprovalCard({
  view,
  approval,
  target,
  botName,
  conversationName,
  onRefresh,
}: {
  view: ActionApprovalView;
  approval: OutboundApproval;
  target: ArtifactTarget;
  botName?: string;
  conversationName?: string;
  onRefresh?: () => Promise<void>;
}) {
  const { busyAnswer, submitted, error, decide } = useDecision({ view, target, onRefresh });
  const [open, setOpen] = useState(false);
  const channelLabel =
    approval.channel === "email" ? t`Email` : approval.channel === "message" ? t`Message` : t`Post`;
  return (
    <>
      <InteractionCardShell
        kind="action_approval"
        icon="✉"
        title={t`Outbound draft · r${view.revision}`}
        status={interactionStatusLabel(view)}
        tone={interactionTone(view)}
        subtitle={t`${channelLabel} · ${approval.recipientCount} recipients`}
        source={
          <InteractionSourceLine
            botName={botName}
            conversationName={conversationName}
            createdAt={view.createdAt}
            revision={view.revision}
          />
        }
        actions={
          <>
            <DecisionButtons
              view={view}
              actions={[
                { id: "deny", label: t`Do not send` },
                { id: "approve", label: t`Confirm send` },
              ]}
              busyAnswer={busyAnswer}
              onDecide={(answer) => void decide(answer)}
            />
            <InteractionAction kind="text" onClick={() => setOpen(true)} testId="outbound-open">
              {t`View draft`}
            </InteractionAction>
          </>
        }
      >
        <div className="rounded-xl bg-background px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--border)]">
          <div className="text-[13px] font-medium" dir="auto">
            {approval.subject || t`No subject`}
          </div>
          {view.presentation.detail ? (
            <p className="mt-1 line-clamp-2 text-[12.5px] text-muted-foreground" dir="auto">
              {view.presentation.detail}
            </p>
          ) : null}
        </div>
        <InteractionNote>
          {t`Sending binds this decision to the current revision and fingerprint.`}
        </InteractionNote>
        {submitted && view.status === "pending" ? (
          <InteractionNote>{t`Submitted. Waiting for the current state…`}</InteractionNote>
        ) : null}
        <TerminalNote view={view} effectStatus={approval.effectStatus} />
        {error ? (
          <p role="alert" className="text-[12px] text-destructive">
            {error}
          </p>
        ) : null}
      </InteractionCardShell>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          data-testid="outbound-draft-dialog"
          className="max-h-[90dvh] w-[min(640px,calc(100vw-24px))] overflow-auto sm:max-w-[640px]"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogTitle className="text-[15px]">
                {t`Outbound draft · r${view.revision}`}
              </DialogTitle>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {t`${channelLabel} · ${approval.recipientCount} recipients`}
              </p>
            </div>
            <DialogClose render={<Button variant="ghost" size="sm" />}>{t`Close`}</DialogClose>
          </div>
          <InteractionKeyValue
            rows={[
              { label: t`Subject`, value: approval.subject || t`No subject` },
              {
                label: t`Fingerprint`,
                value: approval.fingerprint,
                mono: true,
              },
            ]}
          />
          <div>
            <div className="mb-1 text-[12px] text-muted-foreground">{t`Draft body`}</div>
            <pre
              data-testid="outbound-draft-body"
              className="max-h-[45dvh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted px-3 py-2.5 font-sans text-[13px] leading-5 text-foreground"
              dir="auto"
            >
              {view.presentation.detail || t`No draft preview was provided.`}
            </pre>
          </div>
          <InteractionNote>
            {t`Closing this view does not reject, cancel, or send the draft.`}
          </InteractionNote>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RoutineApprovalCard({
  view,
  approval,
  target,
  botName,
  conversationName,
  onRefresh,
}: {
  view: ActionApprovalView;
  approval: RoutineApproval;
  target: ArtifactTarget;
  botName?: string;
  conversationName?: string;
  onRefresh?: () => Promise<void>;
}) {
  const { busyAnswer, submitted, error, decide } = useDecision({ view, target, onRefresh });
  const actionLabel =
    approval.action === "pause"
      ? t`Pause routine`
      : approval.action === "resume"
        ? t`Resume routine`
        : approval.action === "delete"
          ? t`Delete routine`
          : t`Update routine`;
  return (
    <InteractionCardShell
      kind="action_approval"
      icon="↻"
      title={view.presentation.text || actionLabel}
      status={interactionStatusLabel(view)}
      tone={interactionTone(view)}
      subtitle={actionLabel}
      source={
        <InteractionSourceLine
          botName={botName}
          conversationName={conversationName}
          createdAt={view.createdAt}
          revision={view.revision}
        />
      }
      actions={
        <DecisionButtons
          view={view}
          actions={[
            { id: "deny", label: t`Keep the current setting` },
            { id: "approve", label: t`Confirm change` },
          ]}
          busyAnswer={busyAnswer}
          onDecide={(answer) => void decide(answer)}
        />
      }
    >
      {view.presentation.detail ? (
        <p className="text-[13px] leading-[18px] text-foreground/85" dir="auto">
          {view.presentation.detail}
        </p>
      ) : null}
      <InteractionKeyValue
        rows={[
          ...(approval.timezone ? [{ label: t`Time zone`, value: approval.timezone }] : []),
          ...(approval.cron ? [{ label: t`Schedule`, value: approval.cron, mono: true }] : []),
        ]}
      />
      {!approval.timezone && !approval.cron && !view.presentation.detail ? (
        <InteractionNote>{t`No readable schedule was provided.`}</InteractionNote>
      ) : null}
      <InteractionNote>{t`The result comes from the Routine transaction.`}</InteractionNote>
      {submitted && view.status === "pending" ? (
        <InteractionNote>{t`Submitted. Waiting for the current state…`}</InteractionNote>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </InteractionCardShell>
  );
}

function InstallStep({
  label,
  state,
}: {
  label: string;
  state: "pending" | "done" | "failed" | "not_started";
}) {
  const mark = state === "done" ? "✓" : state === "failed" ? "!" : state === "pending" ? "●" : "○";
  const tone =
    state === "done"
      ? "text-success"
      : state === "failed"
        ? "text-destructive"
        : state === "pending"
          ? "text-link"
          : "text-muted-foreground";
  return (
    <div
      data-testid="install-step"
      data-state={state}
      className={`flex items-center gap-2 rounded-[10px] bg-background px-2.5 py-1.5 text-[12.5px] ${tone}`}
    >
      <span aria-hidden="true">{mark}</span>
      <span>{label}</span>
    </div>
  );
}

function InstallApprovalCard({
  view,
  approval,
  target,
  botName,
  conversationName,
  onRefresh,
}: {
  view: ActionApprovalView;
  approval: InstallApproval;
  target: ArtifactTarget;
  botName?: string;
  conversationName?: string;
  onRefresh?: () => Promise<void>;
}) {
  const { busyAnswer, submitted, error, decide } = useDecision({ view, target, onRefresh });
  const installState =
    view.status === "answered"
      ? "done"
      : view.status === "cancelled" || view.status === "expired"
        ? "not_started"
        : "pending";
  const authorizationState = view.status === "answered" ? "pending" : "not_started";
  return (
    <InteractionCardShell
      kind="action_approval"
      icon="⬡"
      title={view.presentation.text || t`Install ${approval.name}`}
      status={interactionStatusLabel(view)}
      tone={interactionTone(view)}
      subtitle={`${approval.capabilityKind} · ${approval.version ? `v${approval.version}` : t`current version`}`}
      source={
        <InteractionSourceLine
          botName={botName}
          conversationName={conversationName}
          createdAt={view.createdAt}
          revision={view.revision}
        />
      }
      actions={
        <DecisionButtons
          view={view}
          actions={[
            { id: "deny", label: t`Do not install` },
            { id: "approve", label: t`Install` },
          ]}
          busyAnswer={busyAnswer}
          onDecide={(answer) => void decide(answer)}
        />
      }
    >
      <div className="flex flex-col gap-1.5">
        <InstallStep
          label={t`Install: ${installState === "done" ? "done" : installState === "pending" ? "waiting" : "not started"}`}
          state={installState}
        />
        <InstallStep
          label={t`Authorization: ${authorizationState === "pending" ? "separate step" : "not started"}`}
          state={authorizationState}
        />
      </div>
      <InteractionNote>
        {t`Installation and authorization are separate back-end actions. Authorization is requested in its own card.`}
      </InteractionNote>
      {submitted && view.status === "pending" ? (
        <InteractionNote>{t`Submitted. Waiting for the current state…`}</InteractionNote>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </InteractionCardShell>
  );
}

function PlaybookRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 border-t border-border/60 py-2 first:border-0 first:pt-0">
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className="min-w-0 whitespace-pre-wrap text-[13px] leading-5" dir="auto">
        {children || "—"}
      </div>
    </div>
  );
}

function SkillSaveCard({
  view,
  approval,
  botName,
  conversationName,
  onRefresh,
}: {
  view: ActionApprovalView;
  approval: SkillSaveApproval;
  target: ArtifactTarget;
  botName?: string;
  conversationName?: string;
  onRefresh?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"save" | "discard" | null>(null);
  // Transient echo only: the authoritative terminal state comes from the
  // refreshed InteractionView, so a reload restores the same discarded card.
  const [settled, setSettled] = useState<"saved" | "discarded" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const title = t`Save skill “${approval.name || approval.goal.slice(0, 40)}”`;
  const terminal = view.status !== "pending" || settled !== null;
  const terminalLabel =
    view.status === "cancelled"
      ? t`Discarded`
      : view.status === "answered"
        ? t`Saved`
        : settled === "discarded"
          ? t`Discarded`
          : settled === "saved"
            ? t`Saved`
            : interactionStatusLabel(view);

  const save = async () => {
    if (busy || terminal) return;
    setBusy("save");
    setError(null);
    try {
      await rpc.skills.updateDraft({
        skillId: approval.skillId,
        name: approval.name,
        playbook: approval.playbook,
      });
      await rpc.skills.save({ skillId: approval.skillId, name: approval.name });
      setSettled("saved");
      await onRefresh?.().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not save this skill`);
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    if (busy || terminal) return;
    setBusy("discard");
    setError(null);
    try {
      await rpc.skills.remove({ skillId: approval.skillId });
      setSettled("discarded");
      await onRefresh?.().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not discard this skill`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <InteractionCardShell
        kind="action_approval"
        icon="S"
        title={title}
        status={terminal ? terminalLabel : interactionStatusLabel(view)}
        tone={interactionTone(view)}
        subtitle={t`Goal: ${approval.goal}`}
        source={
          <InteractionSourceLine
            botName={botName}
            conversationName={conversationName}
            createdAt={view.createdAt}
            revision={view.revision}
          />
        }
        actions={
          terminal ? undefined : (
            <>
              <InteractionAction
                kind="secondary"
                disabled={Boolean(busy)}
                loading={busy === "discard"}
                onClick={() => void discard()}
                testId="skill-save-discard"
              >
                {t`Discard`}
              </InteractionAction>
              <InteractionAction
                kind="primary"
                disabled={Boolean(busy)}
                loading={busy === "save"}
                onClick={() => void save()}
                testId="skill-save-save"
              >
                {t`Save`}
              </InteractionAction>
            </>
          )
        }
      >
        <InteractionNote>{t`Saving binds the current content snapshot. The authority is the skill save transaction, not a tool run.`}</InteractionNote>
        <InteractionAction kind="text" onClick={() => setOpen(true)} testId="skill-save-open">
          {t`View playbook →`}
        </InteractionAction>
        {terminal ? <InteractionNote>{terminalLabel}</InteractionNote> : null}
        {error ? (
          <p role="alert" className="text-[12px] text-destructive">
            {error}
          </p>
        ) : null}
      </InteractionCardShell>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          data-testid="skill-playbook-dialog"
          className="max-h-[90dvh] w-[min(620px,calc(100vw-24px))] overflow-auto sm:max-w-[620px]"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogTitle className="text-[15px]">{t`Skill playbook`}</DialogTitle>
              <p className="mt-1 text-[12px] text-muted-foreground">{title}</p>
            </div>
            <DialogClose render={<Button variant="ghost" size="sm" />}>{t`Close`}</DialogClose>
          </div>
          <div className="rounded-xl bg-muted/60 px-3 py-2">
            <PlaybookRow label={t`Name`}>{approval.name}</PlaybookRow>
            <PlaybookRow label={t`Goal`}>{approval.goal}</PlaybookRow>
            <PlaybookRow label={t`When to use`}>{approval.playbook.whenToUse}</PlaybookRow>
            <PlaybookRow label={t`Inputs`}>{approval.playbook.inputs.join("\n")}</PlaybookRow>
            <PlaybookRow label={t`Steps`}>{approval.playbook.steps.join("\n")}</PlaybookRow>
            <PlaybookRow label={t`How to check`}>{approval.playbook.howToCheck}</PlaybookRow>
            <PlaybookRow label={t`What to return`}>{approval.playbook.whatToReturn}</PlaybookRow>
            <PlaybookRow label={t`Approval boundaries`}>
              {approval.playbook.approvalBoundaries}
            </PlaybookRow>
            <PlaybookRow label={t`Failure handling`}>
              {approval.playbook.failureHandling}
            </PlaybookRow>
          </div>
          <InteractionNote>{t`Viewing this playbook does not change the skill or its save request.`}</InteractionNote>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AppAuthorizationCard({
  view,
  approval,
  botName,
  conversationName,
  onRefresh,
}: {
  view: ActionApprovalView;
  approval: AppAuthorizationApproval;
  botName?: string;
  conversationName?: string;
  onRefresh?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(view.status === "answered");
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<AbortController | null>(null);
  useEffect(() => () => attempt.current?.abort(), []);

  const authorize = async () => {
    if (!view.source.botId || busy) {
      if (!view.source.botId) setError(t`This connection is not bound to a Bot.`);
      return;
    }
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(true);
    setError(null);
    try {
      const started = await rpc.connections.begin({
        connectorId: approval.connectorId ?? undefined,
        provider: approval.provider,
        displayName: approval.name,
      });
      if (started.authorizationUrl) {
        window.open(started.authorizationUrl, "rakazo-app-connect", "popup,width=560,height=720");
      }
      for (let index = 0; index < 60; index += 1) {
        if (controller.signal.aborted) return;
        const row = await rpc.connections
          .complete({ connectionId: started.connectionId })
          .catch(() => undefined);
        if (row?.status === "connected") {
          if (controller.signal.aborted) return;
          await rpc.onboarding
            .appConnected({
              botId: view.source.botId,
              provider: approval.provider,
              connectorId: approval.connectorId ?? undefined,
            })
            .catch(() => undefined);
          setConnected(true);
          await onRefresh?.().catch(() => undefined);
          return;
        }
        await abortableDelay(2_000, controller.signal);
      }
      if (!controller.signal.aborted) setError(t`Authorization timed out. Please try again.`);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : t`Could not authorize this app`);
      }
    } finally {
      if (attempt.current === controller) {
        attempt.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <InteractionCardShell
      kind="action_approval"
      icon="⬡"
      title={view.presentation.text || t`Authorize ${approval.name}`}
      status={connected ? t`Authorized` : interactionStatusLabel(view)}
      tone={connected || view.status === "answered" ? "ok" : interactionTone(view)}
      subtitle={`${approval.provider}${approval.description ? ` · ${approval.description}` : ""}`}
      source={
        <InteractionSourceLine
          botName={botName}
          conversationName={conversationName}
          createdAt={view.createdAt}
          revision={view.revision}
        />
      }
      actions={
        connected || view.status !== "pending" ? undefined : (
          <InteractionAction
            kind="primary"
            disabled={busy}
            loading={busy}
            onClick={() => void authorize()}
            testId="app-authorization-approve"
          >
            {t`Authorize`}
          </InteractionAction>
        )
      }
    >
      <InteractionNote>
        {t`This authorizes the app connection; it does not install a connector or approve individual tools.`}
      </InteractionNote>
      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </InteractionCardShell>
  );
}

function McpAssignmentCard({
  view,
  approval,
  botName,
  conversationName,
  onRefresh,
}: {
  view: ActionApprovalView;
  approval: McpAssignmentApproval;
  target: ArtifactTarget;
  botName?: string;
  conversationName?: string;
  onRefresh?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"approve" | "dismiss" | null>(null);
  const [done, setDone] = useState<"connected" | "dismissed" | null>(
    view.status === "answered" ? "connected" : null,
  );
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    if (!view.source.botId || busy) {
      if (!view.source.botId) setError(t`This server cannot be assigned without a Bot.`);
      return;
    }
    setBusy("approve");
    setError(null);
    try {
      if (approval.needsOAuth) {
        const result = await connectMcpOauth(approval.serverId);
        if (result === "cancelled") return;
      }
      await rpc.mcp.assignments.approve({
        botId: view.source.botId,
        serverId: approval.serverId,
        threadId: view.source.threadId,
      });
      setDone("connected");
      await onRefresh?.().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not approve this server`);
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async () => {
    if (!view.source.botId || busy) return;
    setBusy("dismiss");
    setError(null);
    try {
      await rpc.mcp.assignments.dismiss({
        botId: view.source.botId,
        serverId: approval.serverId,
        threadId: view.source.threadId,
      });
      setDone("dismissed");
      await onRefresh?.().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not dismiss this server`);
    } finally {
      setBusy(null);
    }
  };

  const terminal = done !== null || view.status !== "pending";
  return (
    <InteractionCardShell
      kind="action_approval"
      icon="M"
      title={t`MCP assignment · allow all tools`}
      status={
        done === "connected"
          ? t`Allowed`
          : done === "dismissed"
            ? t`Dismissed`
            : interactionStatusLabel(view)
      }
      tone={done === "connected" ? "ok" : done === "dismissed" ? "neutral" : interactionTone(view)}
      subtitle={approval.name}
      source={
        <InteractionSourceLine
          botName={botName}
          conversationName={conversationName}
          createdAt={view.createdAt}
          revision={view.revision}
        />
      }
      actions={
        terminal ? undefined : (
          <>
            <InteractionAction
              disabled={Boolean(busy)}
              loading={busy === "dismiss"}
              onClick={() => void dismiss()}
              testId="mcp-assignment-dismiss"
            >
              {t`Deny`}
            </InteractionAction>
            <InteractionAction
              kind="primary"
              disabled={Boolean(busy)}
              loading={busy === "approve"}
              onClick={() => void approve()}
              testId="mcp-assignment-approve"
            >
              {t`Allow all tools`}
            </InteractionAction>
          </>
        )
      }
    >
      <InteractionKeyValue
        rows={[
          { label: t`Server`, value: approval.name },
          {
            label: t`Scope`,
            value: approval.endpoint ?? `stdio · ${approval.transport}`,
            mono: true,
          },
          { label: t`Tool access`, value: t`All tools on this server` },
        ]}
      />
      <div
        role="note"
        data-testid="mcp-allow-all-tools"
        className="rounded-[10px] bg-destructive/10 px-2.5 py-2 text-[12px] leading-[17px] text-destructive"
      >
        <b>{t`High risk`}</b>
        {`: `}
        {t`allowAllTools: true. This Bot can use every tool on this server.`}
      </div>
      {done === "connected" ? (
        <InteractionNote>{t`Connected. The server's tools are available from the next message.`}</InteractionNote>
      ) : null}
      {done === "dismissed" ? (
        <InteractionNote>{t`Dismissed. You can reconnect from MCP settings.`}</InteractionNote>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </InteractionCardShell>
  );
}

export function GroupMembershipApprovalCard({
  view,
  approval,
  botName,
  groupName,
  onDecision,
}: {
  view: ActionApprovalView;
  approval: GroupMembershipApproval;
  botName: string;
  groupName?: string;
  onDecision?: (answer: "approve" | "deny") => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [done, setDone] = useState<"approved" | "denied" | null>(
    view.status === "answered" ? (view.decision === "denied" ? "denied" : "approved") : null,
  );
  const targetGroup = groupName ?? t`this room`;
  const terminal = done !== null || view.status !== "pending";
  const decide = async (answer: "approve" | "deny") => {
    if (!onDecision || busy || terminal) return;
    setBusy(answer);
    try {
      await onDecision(answer);
      setDone(answer === "approve" ? "approved" : "denied");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div
      data-testid="group-membership-approval"
      data-kind="group_membership"
      className="w-full max-w-[420px] rounded-[14px] bg-muted/70 px-3.5 py-3"
    >
      <div className="text-[14px] font-medium leading-5" dir="auto">
        {t`Add ${botName} to “${targetGroup}”?`}
      </div>
      <p className="mt-1.5 text-[12.5px] leading-[18px] text-muted-foreground" dir="auto">
        {approval.presentation.detail ||
          t`${botName} can read the discussion, speak in the room, and continue this work.`}
      </p>
      <p className="mt-1.5 text-[11.5px] leading-4 text-muted-foreground/80" dir="auto">
        {t`Joining only allows this Bot into the standard room and continues the bound message request.`}
      </p>
      {terminal ? (
        <p role="status" className="mt-2 text-[12.5px] font-medium text-foreground">
          {done === "approved"
            ? t`Joined`
            : done === "denied"
              ? t`Not joined`
              : interactionStatusLabel(view)}
        </p>
      ) : (
        <div className="mt-2.5 flex flex-wrap justify-end gap-2">
          <InteractionAction
            disabled={!onDecision || Boolean(busy)}
            loading={busy === "deny"}
            onClick={() => void decide("deny")}
            testId="group-membership-deny"
          >
            {t`Not now`}
          </InteractionAction>
          <InteractionAction
            kind="primary"
            disabled={!onDecision || Boolean(busy)}
            loading={busy === "approve"}
            onClick={() => void decide("approve")}
            testId="group-membership-approve"
          >
            {t`Join and continue`}
          </InteractionAction>
        </div>
      )}
      {!onDecision && !terminal ? (
        <p className="mt-2 text-[11.5px] text-muted-foreground">
          {t`Joining from this card is not available yet.`}
        </p>
      ) : null}
    </div>
  );
}

export function GroupMembershipFailureCard({
  botName,
  groupName,
}: {
  botName: string;
  groupName?: string;
}) {
  return (
    <div
      data-testid="group-membership-failure"
      className="w-full max-w-[420px] rounded-[14px] bg-muted/70 px-3.5 py-3"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="grid size-6 place-items-center rounded-lg bg-destructive/10 text-[12px] text-destructive"
        >
          !
        </span>
        <div className="min-w-0 flex-1 text-[14px] font-medium leading-5" dir="auto">
          {t`Could not add ${botName} to “${groupName ?? t`this room`}”`}
        </div>
        <InteractionStatusBadge label={t`No member permission`} tone="fail" />
      </div>
      <p className="mt-2 text-[12.5px] leading-[18px] text-muted-foreground" dir="auto">
        {t`Adding this Bot needs member-management permission, which you do not have. The work has not started. Ask the room owner or an admin to continue.`}
      </p>
    </div>
  );
}

export function ActionApprovalCard({
  view,
  target,
  botName,
  conversationName,
  groupNameOf,
  onRefresh,
  onGroupDecision,
}: {
  view: ActionApprovalView;
  target: ArtifactTarget;
  botName?: string;
  conversationName?: string;
  groupNameOf?: (groupId: string) => string | undefined;
  onRefresh?: () => Promise<void>;
  onGroupDecision?: (view: ActionApprovalView, answer: "approve" | "deny") => Promise<void> | void;
}) {
  const approval = view.approval;
  switch (approval.kind) {
    case "tool":
      return (
        <ToolApprovalCard
          view={view}
          approval={approval}
          target={target}
          botName={botName}
          conversationName={conversationName}
          onRefresh={onRefresh}
        />
      );
    case "payment":
      return (
        <PaymentApprovalCard
          view={view}
          approval={approval}
          target={target}
          botName={botName}
          conversationName={conversationName}
          onRefresh={onRefresh}
        />
      );
    case "outbound":
      return (
        <OutboundApprovalCard
          view={view}
          approval={approval}
          target={target}
          botName={botName}
          conversationName={conversationName}
          onRefresh={onRefresh}
        />
      );
    case "routine":
      return (
        <RoutineApprovalCard
          view={view}
          approval={approval}
          target={target}
          botName={botName}
          conversationName={conversationName}
          onRefresh={onRefresh}
        />
      );
    case "install":
      return (
        <InstallApprovalCard
          view={view}
          approval={approval}
          target={target}
          botName={botName}
          conversationName={conversationName}
          onRefresh={onRefresh}
        />
      );
    case "skill_save":
      return (
        <SkillSaveCard
          view={view}
          approval={approval}
          target={target}
          botName={botName}
          conversationName={conversationName}
          onRefresh={onRefresh}
        />
      );
    case "connect.app_authorization":
      return (
        <AppAuthorizationCard
          view={view}
          approval={approval}
          botName={botName}
          conversationName={conversationName}
          onRefresh={onRefresh}
        />
      );
    case "connect.mcp_assignment":
      return (
        <McpAssignmentCard
          view={view}
          approval={approval}
          target={target}
          botName={botName}
          conversationName={conversationName}
          onRefresh={onRefresh}
        />
      );
    case "group_membership":
      return (
        <GroupMembershipApprovalCard
          view={view}
          approval={approval}
          botName={botName ?? t`Bot`}
          groupName={groupNameOf?.(approval.groupId)}
          onDecision={onGroupDecision ? (answer) => onGroupDecision(view, answer) : undefined}
        />
      );
  }
}

export { GroupMembershipFailureCard as GroupMembershipFailedCard };
