import { t } from "@lingui/core/macro";
import { LinkifiedText } from "@rakazo/chat-ui/web";
import type { MessageInline } from "@rakazo/contracts";
import { BotAvatar } from "@rakazo/ui-web";

const FALLBACK_MENTION_COLOR = "#85858A";

export type MentionIdentity = Readonly<{
  name?: string;
  color?: string;
  available: boolean;
}>;

/**
 * Text-block renderer for user bubbles. Structured inlines opt into mention
 * links; every legacy text block stays on the plain `LinkifiedText` path.
 */
export function MessageText({
  inlines,
  onOpenMention,
  resolveMention,
  text,
}: {
  inlines?: readonly MessageInline[];
  onOpenMention: (botId: string) => void;
  resolveMention: (botId: string) => MentionIdentity | undefined;
  text: string;
}) {
  if (!inlines?.length) return <LinkifiedText>{text}</LinkifiedText>;
  return (
    <AgentMentionText
      inlines={inlines}
      resolveMention={resolveMention}
      onOpenMention={onOpenMention}
    />
  );
}

/**
 * Renders a text block that carries structured Bot mention identity. Link
 * ranges come only from `inlines`; the legacy `text`-only path never guesses
 * a link from an `@name` substring.
 */
export function AgentMentionText({
  inlines,
  resolveMention,
  onOpenMention,
}: {
  inlines: readonly MessageInline[];
  resolveMention: (botId: string) => MentionIdentity | undefined;
  onOpenMention: (botId: string) => void;
}) {
  return (
    <>
      {inlines.map((inline, index) =>
        inline.kind === "text" ? (
          <LinkifiedText key={`text:${index}`}>{inline.text}</LinkifiedText>
        ) : (
          <AgentMention
            key={`mention:${inline.botId}:${index}`}
            botId={inline.botId}
            fallbackLabel={inline.label}
            identity={resolveMention(inline.botId)}
            onOpenMention={onOpenMention}
          />
        ),
      )}
    </>
  );
}

export function AgentMention({
  botId,
  fallbackLabel,
  identity,
  onOpenMention,
}: {
  botId: string;
  fallbackLabel: string;
  identity: MentionIdentity | undefined;
  onOpenMention: (botId: string) => void;
}) {
  const name = identity?.name?.trim() || fallbackLabel;
  const color = identity?.color ?? FALLBACK_MENTION_COLOR;
  const content = (
    <>
      <span aria-hidden="true" className="inline-flex">
        <BotAvatar color={color} identity={botId} size={18} />
      </span>
      <span dir="auto">@{name}</span>
    </>
  );

  if (!identity?.available) {
    return (
      <span
        data-testid="agent-mention"
        data-mention-available="false"
        role="note"
        aria-label={t`${name} is unavailable`}
        title={t`${name} is unavailable`}
        className="mx-0.5 inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-foreground/5 px-1.5 py-0.5 align-middle text-inherit opacity-70"
      >
        {content}
      </span>
    );
  }

  return (
    <a
      href={`/app/${botId}`}
      data-testid="agent-mention"
      data-mention-available="true"
      data-bot-id={botId}
      aria-label={t`Open chat with ${name}`}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        onOpenMention(botId);
      }}
      className="mx-0.5 inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-foreground/5 px-1.5 py-0.5 align-middle font-semibold text-inherit transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {content}
    </a>
  );
}
