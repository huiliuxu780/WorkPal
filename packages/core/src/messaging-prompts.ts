import type { MessageBlock } from "@rakazo/contracts";
import { promptSegment } from "./prompt-segments.js";

/** Instruction-stack note for bots whose owner has a messaging identity. Text: prompts/messaging/dm-surface-note.md (P12). */
export function messagingDmSurfaceNote(): string {
  return promptSegment("messaging/dm-surface-note");
}

/** Hard privacy rules for bots posting into shared group channels. Text: prompts/messaging/channel-privacy.md (P12). */
export function messagingChannelPrivacyBlock(): string {
  return promptSegment("messaging/channel-privacy");
}

export function messagingChannelId(sourceBlocks: MessageBlock[] | undefined): string | undefined {
  return sourceBlocks?.find((block) => block.kind === "channel_message")?.channelId;
}

/** Channel runs are messaging runs whose waking message came from a channel. */
export function isMessagingChannelRun(
  trigger: string,
  sourceBlocks: MessageBlock[] | undefined,
): boolean {
  return trigger === "messaging" && Boolean(messagingChannelId(sourceBlocks));
}

/**
 * Group names and owner names are attacker-controlled text interpolated
 * into prompts and DMs; strip framing characters before they get near one.
 */
export function sanitizeMessagingLabel(value: string): string {
  return value
    .replace(/[\r\n"[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}
