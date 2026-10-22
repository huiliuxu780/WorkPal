import type { MessageInline } from "@rakazo/contracts";

export type MentionSpan = Readonly<{ botId: string; start: number; end: number }>;

/**
 * Split a user text block around typed Bot mention spans. Only authorized
 * Bot ids become links; every other range stays plain text, and a message
 * without any surviving Bot mention keeps its legacy text-only shape.
 */
export function buildMentionInlines(input: {
  text: string;
  spans: readonly MentionSpan[];
  linkableBotIds: ReadonlySet<string>;
}): MessageInline[] | undefined {
  const text = input.text.trim();
  if (!text || input.spans.length === 0) return undefined;
  const leading = input.text.length - input.text.trimStart().length;
  const candidates = input.spans
    .filter((span) => input.linkableBotIds.has(span.botId))
    .map((span) => ({ ...span, start: span.start - leading, end: span.end - leading }))
    .filter(
      (span) =>
        span.start >= 0 &&
        span.end > span.start + 1 &&
        span.end <= text.length &&
        text[span.start] === "@",
    )
    .sort((left, right) => left.start - right.start);

  const inlines: MessageInline[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  for (const span of candidates) {
    if (seen.has(span.botId) || span.start < cursor) continue;
    const label = text.slice(span.start + 1, span.end);
    if (!label || label.length > 200) continue;
    seen.add(span.botId);
    if (span.start > cursor) inlines.push({ kind: "text", text: text.slice(cursor, span.start) });
    inlines.push({ kind: "bot_mention", botId: span.botId, label });
    cursor = span.end;
  }
  if (cursor === 0) return undefined;
  if (cursor < text.length) inlines.push({ kind: "text", text: text.slice(cursor) });
  return inlines;
}
