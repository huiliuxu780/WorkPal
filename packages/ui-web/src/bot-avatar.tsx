import { AVATAR_CHARACTERS, type AvatarCharacter, avatarIdHash } from "@rakazo/contracts";
import {
  DEFAULT_GROK_BOT_COLOR,
  GROK_BOT_COLORS,
  GROK_COLOR_LIST,
  resolvePersonaColorDef,
} from "@rakazo/core";
import { memo } from "react";
import { AgentAvatar, type AgentAvatarSize } from "./agent-avatar/agent-avatar.js";
import { useAvatarCatalog } from "./agent-avatar/catalog.js";
import { cn } from "./lib/utils.js";

export { DEFAULT_GROK_BOT_COLOR, GROK_BOT_COLORS, GROK_COLOR_LIST, resolvePersonaColorDef };

/** Legacy color is retained for rollback, but it no longer selects a shape. */
export function parseBotAvatar(rawColor: string, _identity?: string) {
  const isImage = rawColor.startsWith("data:image/");
  return {
    color: /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?/.exec(rawColor)?.[0] ?? "#F97316",
    isImage,
    ...(isImage ? { imageUrl: rawColor } : {}),
  };
}

export interface BotAvatarProps {
  color: string;
  size?: number;
  status?: string;
  identity?: string;
  className?: string;
  /** Kept for compatibility with callers that still pass an old style override. */
  variant?: string;
}

function displaySize(size: number): AgentAvatarSize {
  if (size <= 16) return 16;
  if (size <= 26) return 24;
  if (size <= 48) return 32;
  return 64;
}

/** Compatibility entrypoint while call sites move to the durable avatar catalog. */
export const BotAvatar = memo(function BotAvatar({
  color,
  size = 32,
  identity = "",
  className,
}: BotAvatarProps) {
  const catalog = useAvatarCatalog(identity);
  const parsed = parseBotAvatar(color, identity);
  const botId = identity || "bot";
  if (catalog.bot?.avatarMode !== "character" && parsed.isImage && parsed.imageUrl) {
    const slot = displaySize(size);
    return (
      <span
        className={cn(
          "inline-flex shrink-0 overflow-hidden rounded-full border border-border bg-secondary",
          className,
        )}
        role="img"
        aria-label={catalog.bot?.name ?? "Bot"}
        style={{ width: slot, height: slot }}
      >
        <img
          src={parsed.imageUrl}
          width={slot}
          height={slot}
          alt=""
          className="h-full w-full object-cover"
        />
      </span>
    );
  }
  const character: AvatarCharacter =
    catalog.bot?.avatarMode === "character" && catalog.bot.avatarCharacter
      ? catalog.bot.avatarCharacter
      : AVATAR_CHARACTERS[avatarIdHash(botId) % AVATAR_CHARACTERS.length]!;
  return (
    <AgentAvatar
      botId={botId}
      character={character}
      name={catalog.bot?.name ?? "Bot"}
      size={displaySize(size)}
      activity={catalog.state?.state ?? "idle"}
      current={catalog.current}
      progressToken={catalog.state?.revision ?? null}
      className={className}
    />
  );
});
