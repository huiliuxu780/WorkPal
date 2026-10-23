export const SLASH_ACTIONS = [
  { id: "chat-settings" as const, label: "Chat Settings" },
  { id: "settings-general" as const, label: "Settings: General" },
  { id: "settings-usage" as const, label: "Settings: Usage" },
] as const;

export type SlashActionId = (typeof SLASH_ACTIONS)[number]["id"];

/** Serialize the visible draft into the prompt text sent to the agent. */
export function serializeComposerPrompt(
  draft: string,
  skill: { name: string } | null,
  _mentions: Array<{ name: string }>,
): string {
  const body = draft.replace(/^\s+/, "");
  if (!skill) return body.trimEnd();
  return body.trim().length > 0 ? `/${skill.name}\n${body}` : `/${skill.name}`;
}

export function truncateSlashDescription(value: string, max = 72): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export type ComposerMentionSpan = { botId: string; start: number; end: number };

type ComposerMentionToken = { kind: string; id: string; name: string };

/**
 * Locate mention tokens that the composer associated with typed identities.
 * Tokens stay in the visible draft, so their positions preserve segmented
 * instructions such as `@Alpha do X, @Beta do Y`.
 */
export function composerMentionSpans(
  text: string,
  mentions: readonly ComposerMentionToken[],
): ComposerMentionSpan[] {
  const spans: ComposerMentionSpan[] = [];
  const claimedStarts = new Set<number>();
  for (const mention of mentions) {
    if (mention.kind === "group" || mention.kind === "routine" || mention.kind === "connector") {
      continue;
    }
    const token = `@${mention.name}`;
    let start = text.indexOf(token);
    while (start >= 0) {
      const before = text[start - 1];
      const after = text[start + token.length];
      const boundaryBefore = before === undefined || !/[\p{L}\p{N}_-]/u.test(before);
      const boundaryAfter = after === undefined || !/[\p{L}\p{N}_-]/u.test(after);
      if (boundaryBefore && boundaryAfter && !claimedStarts.has(start)) break;
      start = text.indexOf(token, start + 1);
    }
    if (start < 0) continue;
    claimedStarts.add(start);
    const end = start + token.length;
    if (mention.kind === "bot") spans.push({ botId: mention.id, start, end });
  }
  return spans.sort((left, right) => left.start - right.start);
}
