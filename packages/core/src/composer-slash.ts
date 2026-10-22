export const SLASH_ACTIONS = [
  { id: "chat-settings" as const, label: "Chat Settings" },
  { id: "settings-general" as const, label: "Settings: General" },
  { id: "settings-usage" as const, label: "Settings: Usage" },
] as const;

export type SlashActionId = (typeof SLASH_ACTIONS)[number]["id"];

/** Serialize composer chips + draft into the prompt text sent to the agent. */
export function serializeComposerPrompt(
  draft: string,
  skill: { name: string } | null,
  mentions: Array<{ name: string }>,
): string {
  const body = draft.replace(/^\s+/, "");
  const mentionPrefix = mentions.map((member) => `@${member.name}`).join(" ");
  const afterSkill = [mentionPrefix, body].filter((part) => part.trim().length > 0).join(" ");
  if (!skill) return afterSkill.trimEnd();
  return afterSkill.trim().length > 0 ? `/${skill.name}\n${afterSkill}` : `/${skill.name}`;
}

export function truncateSlashDescription(value: string, max = 72): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export type ComposerMentionSpan = { botId: string; start: number; end: number };

type ComposerMentionToken = { kind: string; id: string; name: string };

/**
 * Locate typed mention chips in the prompt that was actually sent. Chips are
 * serialized as a leading `@name` prefix (after an optional skill line), so
 * this walks that prefix in order and fails closed when anything drifted —
 * bare `@name` text elsewhere is never treated as mention identity.
 */
export function composerMentionSpans(
  text: string,
  mentions: readonly ComposerMentionToken[],
): ComposerMentionSpan[] {
  let cursor = 0;
  if (text.startsWith("/")) {
    const newline = text.indexOf("\n");
    if (newline >= 0) cursor = newline + 1;
  }
  const spans: ComposerMentionSpan[] = [];
  for (const mention of mentions) {
    if (mention.kind === "group" || mention.kind === "routine" || mention.kind === "connector") {
      continue;
    }
    const token = `@${mention.name}`;
    if (!text.startsWith(token, cursor)) return [];
    const start = cursor;
    const end = start + token.length;
    if (text[end] !== undefined && text[end] !== " ") return [];
    if (mention.kind === "bot") spans.push({ botId: mention.id, start, end });
    cursor = text[end] === " " ? end + 1 : end;
  }
  return spans;
}
