import { t } from "@lingui/core/macro";
import type { MessageInline } from "@rakazo/contracts";
import { BotAvatar, resolvePersonaColorDef } from "@rakazo/ui-web";
import type { PublicDelegationGroup, PublicDelegationTrace } from "../../lib/public-collaboration";
import { AgentMentionText, type MentionIdentity } from "./AgentMentionText";

const FALLBACK_BOT_COLOR = "#85858A";

function delegationInlines(delivery: {
  targetBotId: string;
  targetFallbackName: string;
  body: string;
}): MessageInline[] {
  const body = delivery.body.trim();
  return [
    { kind: "bot_mention", botId: delivery.targetBotId, label: delivery.targetFallbackName },
    ...(body ? [{ kind: "text" as const, text: ` ${body}` }] : []),
  ];
}

/** Only a request or a question is a delegation worth a dispatch trace. */
function showsDispatchTrace(trace: PublicDelegationTrace, intent: string): boolean {
  if (trace === "unknown") return false;
  return intent === "request" || intent === "question";
}

function DispatchTrace({ name, trace }: { name: string; trace: "sent" | "failed" }) {
  if (trace === "failed") {
    return (
      <div
        data-testid="public-delegation-trace"
        className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-destructive"
      >
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-destructive" />
        <span className="min-w-0 wrap-anywhere" dir="auto">
          {t`Not sent to ${name}`}
        </span>
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex min-w-0">
      <span
        data-testid="public-delegation-trace"
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 text-[11.5px] leading-5 text-muted-foreground"
      >
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />
        <span className="min-w-0 truncate" dir="auto">
          {t`Assigned to ${name}`}
        </span>
      </span>
    </div>
  );
}

/**
 * Natural group-thread rendering for a persisted public `message_bot`
 * delegation.
 *
 * Every delivery keeps its own target identity and target Run id, so a visual
 * merge never coalesces the underlying Tasks or Runs. The body is the message
 * the sender actually wrote; the target is a structured mention resolved by Bot
 * id. Nothing here renders a Run state, and nothing here opens the private pair
 * view: mentions navigate to the user's long-term chat with that Bot.
 */
export function PublicDelegationMessage({
  group,
  onOpenMention,
  resolveBot,
}: {
  group: PublicDelegationGroup;
  onOpenMention: (botId: string) => void;
  resolveBot: (botId: string) => MentionIdentity | undefined;
}) {
  const sender = group.senderBotId ? resolveBot(group.senderBotId) : undefined;
  const senderName = sender?.name?.trim() || group.senderFallbackName?.trim();
  const senderColor = sender?.color ?? FALLBACK_BOT_COLOR;
  const senderTextColor = resolvePersonaColorDef(group.senderBotId ?? "bot", sender?.color).light;

  return (
    <div
      data-testid="public-delegation"
      data-source-run-id={group.sourceRunId}
      data-sender-bot-id={group.senderBotId}
      className="w-fit max-w-full min-w-0 [@media(hover:none)]:w-full"
    >
      {senderName ? (
        <div
          className="mb-1.5 flex min-w-0 items-center gap-2 text-[13px] font-semibold tracking-tight"
          style={{ color: senderTextColor }}
          dir="auto"
        >
          <BotAvatar color={senderColor} identity={group.senderBotId} size={22} />
          <span className="min-w-0 truncate">{senderName}</span>
        </div>
      ) : null}
      <div
        className="min-w-0 space-y-2.5 rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90"
        dir="auto"
      >
        {group.deliveries.map((delivery, index) => {
          const target = resolveBot(delivery.targetBotId);
          const targetName = target?.name?.trim() || delivery.targetFallbackName;
          return (
            <div
              key={delivery.messageId}
              data-testid="public-delegation-target"
              data-target-bot-id={delivery.targetBotId}
              data-target-run-id={delivery.targetRunId}
              className={
                index === 0
                  ? "min-w-0"
                  : "min-w-0 border-t border-border/70 pt-2.5 [border-top-style:solid]"
              }
            >
              <div className="min-w-0 whitespace-pre-wrap wrap-anywhere">
                <AgentMentionText
                  inlines={delegationInlines({
                    targetBotId: delivery.targetBotId,
                    targetFallbackName: delivery.targetFallbackName,
                    body: delivery.body,
                  })}
                  resolveMention={resolveBot}
                  onOpenMention={onOpenMention}
                />
              </div>
              {showsDispatchTrace(delivery.trace, delivery.intent) ? (
                <DispatchTrace
                  name={targetName}
                  trace={delivery.trace === "failed" ? "failed" : "sent"}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
