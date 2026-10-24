import { t } from "@lingui/core/macro";
import { BotAvatar } from "@rakazo/ui-web";
import type { PublicDelegationGroup, PublicDelegationStatus } from "../../lib/public-collaboration";
import { AgentMention, type MentionIdentity } from "./AgentMentionText";

const FALLBACK_BOT_COLOR = "#85858A";

function statusPresentation(status: PublicDelegationStatus): {
  label: string;
  detail: string;
  className: string;
} {
  switch (status.kind) {
    case "queued":
      return {
        label: t`Queued`,
        detail: t`Waiting to start`,
        className: "bg-foreground/5 text-muted-foreground",
      };
    case "running":
      return {
        label: t`Running`,
        detail: t`Working`,
        className: "bg-foreground/5 text-foreground/75",
      };
    case "completed":
      return {
        label: t`Completed`,
        detail: t`Completed`,
        className: "bg-success/15 text-success",
      };
    case "failed":
      return {
        label: t`Failed`,
        detail: status.detail ?? t`Could not finish`,
        className: "bg-destructive/10 text-destructive",
      };
    case "cancelled":
      return {
        label: t`Cancelled`,
        detail: t`Cancelled`,
        className: "bg-muted text-muted-foreground",
      };
  }
}

function StatusEntry({
  name,
  status,
  targetRunId,
}: {
  name: string;
  status: PublicDelegationStatus;
  targetRunId: string;
}) {
  const presentation = statusPresentation(status);
  return (
    <details className="group/status min-w-0">
      <summary
        data-testid="public-delegation-status"
        data-status={status.kind}
        data-target-run-id={targetRunId}
        aria-label={t`${name}: ${presentation.label}`}
        className={`list-none cursor-pointer rounded-full px-2.5 py-1 text-[12px] font-medium outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden ${presentation.className}`}
      >
        {presentation.label}
      </summary>
      <div
        data-testid="public-delegation-status-detail"
        className="mt-1 max-w-64 wrap-anywhere text-end text-[12px] leading-5 text-muted-foreground"
        role="status"
      >
        {presentation.detail}
      </div>
    </details>
  );
}

/** Natural group-thread rendering for persisted public message_bot deliveries. */
export function PublicDelegationMessage({
  group,
  onOpenMention,
  resolveBot,
}: {
  group: PublicDelegationGroup;
  onOpenMention: (botId: string) => void;
  resolveBot: (botId: string) => MentionIdentity | undefined;
}) {
  const sender = resolveBot(group.senderBotId);
  const senderName = sender?.name?.trim() || group.senderFallbackName;
  const senderColor = sender?.color ?? FALLBACK_BOT_COLOR;

  return (
    <div
      data-testid="public-delegation"
      data-source-run-id={group.sourceRunId}
      data-sender-bot-id={group.senderBotId}
      className="w-full max-w-[min(560px,94%)] min-w-0"
    >
      <div
        className="mb-1.5 flex min-w-0 items-center gap-2 text-[13px] font-semibold tracking-tight text-foreground/75"
        dir="auto"
      >
        <BotAvatar color={senderColor} identity={group.senderBotId} size={22} />
        <span className="min-w-0 truncate">{senderName}</span>
      </div>
      <div className="min-w-0 space-y-2 rounded-[20px] bg-muted px-[18px] py-3 text-[15px] leading-[1.5] text-foreground/90">
        {group.deliveries.map((delivery) => {
          const target = resolveBot(delivery.targetBotId);
          const targetName = target?.name?.trim() || delivery.targetFallbackName;
          return (
            <div
              key={delivery.messageId}
              data-testid="public-delegation-target"
              data-target-bot-id={delivery.targetBotId}
              className="min-w-0 border-t border-border/70 pt-2 first:border-t-0 first:pt-0"
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                <AgentMention
                  botId={delivery.targetBotId}
                  fallbackLabel={delivery.targetFallbackName}
                  identity={target}
                  onOpenMention={onOpenMention}
                />
                <StatusEntry
                  name={targetName}
                  status={delivery.status}
                  targetRunId={delivery.targetRunId}
                />
              </div>
              <div className="mt-1.5 min-w-0 whitespace-pre-wrap wrap-anywhere" dir="auto">
                {delivery.text}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
