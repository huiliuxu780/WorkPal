import type { GroupMemberRef } from "./group-mentions.js";

/** Stable client-facing codes for group mention dispatch outcomes. */
export const GROUP_MENTION_CLARIFICATION_CODE = "GROUP_MENTION_CLARIFICATION_REQUIRED";
export const GROUP_MULTI_TARGET_BUSY_CODE = "GROUP_MULTI_TARGET_BUSY";

/** UTF-16 range of one typed Bot mention chip inside `text`. */
export type GroupMentionSpan = Readonly<{ botId: string; start: number; end: number }>;

export type GroupTaskClarificationReason =
  | "invalid_span"
  | "span_not_typed_mention"
  | "target_not_authorized"
  | "empty_instruction"
  | "ambiguous_attribution"
  | "duplicate_target_conflict"
  | "attachments_not_attributable";

export type GroupTaskSegment = Readonly<{
  botId: string;
  instruction: string;
  /** UTF-16 range of `instruction` in the original message text. */
  start: number;
  end: number;
}>;

/**
 * Deterministic plan for the typed Bot mentions of one group message.
 *
 * `ordinary_mention` means the message contains typed mentions but none of them
 * is used as a task target (for example "I discussed this with @A"). Callers
 * must fall back to their normal owner routing; the mentions themselves never
 * create an extra Run.
 */
export type GroupTaskSegmentation =
  | Readonly<{
      kind: "single_owner";
      ownerBotId: string;
      instruction: string;
      mentionBotIds: readonly string[];
    }>
  | Readonly<{
      kind: "shared_multi";
      ownerBotIds: readonly string[];
      instruction: string;
      /** Leading slash-skill line shared by every target, when present. */
      prefix?: string;
      mentionBotIds: readonly string[];
    }>
  | Readonly<{
      kind: "segmented_multi";
      segments: readonly GroupTaskSegment[];
      /** Leading slash-skill line shared by every target, when present. */
      prefix?: string;
      mentionBotIds: readonly string[];
    }>
  | Readonly<{
      kind: "ordinary_mention";
      mentionBotIds: readonly string[];
      replyTargetBotId: string | null;
    }>
  | Readonly<{
      kind: "clarification_required";
      reasonCode: GroupTaskClarificationReason;
      mentionBotIds: readonly string[];
    }>;

export type SegmentGroupMentionTasksInput = Readonly<{
  text: string;
  spans: readonly GroupMentionSpan[];
  /** Bot ids that came from typed mention chips; span identities must match. */
  typedBotIds: readonly string[];
  /** Current, authorized group members. Non-members are never dispatch targets. */
  members: readonly GroupMemberRef[];
  replyTargetBotId?: string | null;
  /** Presence only; attachment contents are never inspected for intent. */
  hasAttachments?: boolean;
}>;

type MentionOccurrence = Readonly<{
  botId: string;
  start: number;
  end: number;
}>;

type Clause = Readonly<{
  start: number;
  end: number;
  mentions: readonly MentionOccurrence[];
}>;

type InstructionRange = Readonly<{ start: number; end: number; instruction: string }>;

type ClassifiedClause =
  | Readonly<{ kind: "plain" }>
  | Readonly<{ kind: "reference"; botIds: readonly string[] }>
  | Readonly<{ kind: "interleaved"; botIds: readonly string[] }>
  | Readonly<{
      kind: "addressed";
      botIds: readonly string[];
      instruction: InstructionRange | null;
    }>;

const CLAUSE_PUNCTUATION = new Set(["\n", "，", "；", "。", "！", "？", ",", ";", "!", "?", "."]);
const ALWAYS_BOUNDARY = new Set(["\n", "，", "；", "。", "！", "？"]);
const TRIVIA = /^[\s\p{P}\p{S}]*$/u;
const REFERENCE_CONNECTOR_SUFFIX =
  /(?:和|与|跟|同|及|以及)\s*$|(?:^|[\s，,、])(?:with|and|&)\s*$/iu;
const LIST_MARKER = /^(?:[-*•]|\d+[.)])\s+/u;
const CONNECTOR_GAP = /^[\t \u00a0，,、]*(?:(?:和|与|跟|同|及|以及|and|&|\+)[\t \u00a0，,、]*)*$/iu;
const ADDRESS_PREFIXES: readonly RegExp[] = [
  /^(?:please|could you|can you|would you|will you)\b[,，]?[\t ]*/iu,
  /^(?:ask|tell|have|help)\b[,，]?[\t ]*/iu,
  /^(?:请|麻烦|劳驾)[\s，,]*/u,
  /^(?:帮我|帮忙|帮|让|叫)[\s，,]*/u,
];

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function clarification(
  reasonCode: GroupTaskClarificationReason,
  mentionBotIds: readonly string[],
): GroupTaskSegmentation {
  return {
    kind: "clarification_required",
    reasonCode,
    mentionBotIds: unique(mentionBotIds),
  };
}

function hasVisibleContent(value: string): boolean {
  return !TRIVIA.test(value);
}

function isTriviaOnly(value: string): boolean {
  return TRIVIA.test(value);
}

function stripAddressPrefix(value: string): string {
  let current = value;
  for (let round = 0; round < 2; round += 1) {
    let changed = false;
    for (const pattern of ADDRESS_PREFIXES) {
      const next = current.replace(pattern, "");
      if (next !== current) {
        current = next;
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return current;
}

function isConnectorGap(value: string): boolean {
  return CONNECTOR_GAP.test(value);
}

function trimInitialInstruction(start: number, end: number, text: string): InstructionRange | null {
  let left = start;
  let right = end;
  while (left < right && /[\s:：,，、\-–—]/u.test(text[left]!)) left += 1;
  while (right > left && /[\s"'“”‘’)\]}）】》]/u.test(text[right - 1]!)) right -= 1;
  const instruction = text.slice(left, right).trim();
  if (!instruction) return null;
  return { start: left, end: right, instruction };
}

function trimTrailingInstruction(
  start: number,
  end: number,
  text: string,
): InstructionRange | null {
  let left = start;
  let right = end;
  while (left < right && /[\s"'“”‘’([{（【《]/u.test(text[left]!)) left += 1;
  for (;;) {
    while (right > left && /\s/u.test(text[right - 1]!)) right -= 1;
    const slice = text.slice(left, right);
    const connector =
      /(?:^|[\t \u00a0，,、]+)(?:和|与|跟|同|及|以及|and|&|\+)[\t \u00a0，,、]*$/iu.exec(slice);
    if (connector) {
      right = left + connector.index;
      continue;
    }
    if (right > left && /[，,、:：\-–—"'“”‘’)\]}）】》]/u.test(text[right - 1]!)) {
      right -= 1;
      continue;
    }
    break;
  }
  const instruction = text.slice(left, right).trim();
  if (!instruction) return null;
  return { start: left, end: right, instruction };
}

function validateSpans(
  input: SegmentGroupMentionTasksInput,
):
  | Readonly<{ ok: true; spans: readonly GroupMentionSpan[] }>
  | Readonly<{ ok: false; outcome: GroupTaskSegmentation }> {
  const mentionBotIds = input.spans.map((span) => span.botId);
  if (input.spans.length === 0) return { ok: true, spans: [] };
  if (!input.text) return { ok: false, outcome: clarification("invalid_span", mentionBotIds) };

  const typedBotIds = new Set(input.typedBotIds);
  let previousEnd = 0;
  for (const span of input.spans) {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) {
      return { ok: false, outcome: clarification("invalid_span", mentionBotIds) };
    }
    if (span.start < 0 || span.end <= span.start || span.end > input.text.length) {
      return { ok: false, outcome: clarification("invalid_span", mentionBotIds) };
    }
    if (span.start < previousEnd) {
      return { ok: false, outcome: clarification("invalid_span", mentionBotIds) };
    }
    if (input.text[span.start] !== "@") {
      return { ok: false, outcome: clarification("invalid_span", mentionBotIds) };
    }
    const lastUnit = input.text.charCodeAt(span.end - 1);
    const nextUnit = input.text.charCodeAt(span.end);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff && nextUnit >= 0xdc00 && nextUnit <= 0xdfff) {
      return { ok: false, outcome: clarification("invalid_span", mentionBotIds) };
    }
    if (!span.botId || !typedBotIds.has(span.botId)) {
      return {
        ok: false,
        outcome: clarification("span_not_typed_mention", mentionBotIds),
      };
    }
    previousEnd = span.end;
  }
  return { ok: true, spans: input.spans.map((span) => ({ ...span })) };
}

/**
 * Split typed mention spans into a task plan without any natural-language model.
 *
 * Identity comes only from spans crossed with `typedBotIds`; bare `@name` text
 * is never parsed for identity. Structure is limited to clause punctuation,
 * mention lists, and a small addressing prefix vocabulary. Anything that cannot
 * be attributed exactly one way becomes `clarification_required`.
 *
 * This is execution planning only. `buildMentionInlines` remains the separate
 * display projection, so its link dedupe never changes dispatch.
 */
export function segmentGroupMentionTasks(
  input: SegmentGroupMentionTasksInput,
): GroupTaskSegmentation {
  const validated = validateSpans(input);
  if (!validated.ok) return validated.outcome;
  const spans = validated.spans;
  const mentionBotIds = unique(spans.map((span) => span.botId));
  const memberIds = new Set(input.members.map((member) => member.id));
  const replyTargetBotId =
    input.replyTargetBotId && memberIds.has(input.replyTargetBotId) ? input.replyTargetBotId : null;

  if (spans.length === 0) {
    return { kind: "ordinary_mention", mentionBotIds: [], replyTargetBotId };
  }

  const text = input.text;
  const firstSpanStart = spans[0]!.start;

  // A leading slash-skill line belongs to every target; keep it out of clause
  // attribution so it cannot make a valid shared command look ambiguous.
  let analysisStart = 0;
  let prefix: string | undefined;
  if (text.startsWith("/")) {
    const newline = text.indexOf("\n");
    if (newline >= 0 && newline < firstSpanStart) {
      prefix = text.slice(0, newline).trimEnd() || undefined;
      analysisStart = newline + 1;
    }
  }

  const protectedGaps: Array<readonly [number, number]> = [];
  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1]!;
    const current = spans[index]!;
    if (isConnectorGap(text.slice(previous.end, current.start))) {
      protectedGaps.push([previous.end, current.start]);
    }
  }

  const protectsBoundary = (index: number): boolean => {
    if (spans.some((span) => index > span.start && index < span.end)) return true;
    return protectedGaps.some(([start, end]) => index >= start && index < end);
  };

  const boundaryFollows = (index: number): boolean => {
    let next = text[index + 1];
    if (next === undefined) return true;
    if (/["'”’)\]]/u.test(next)) {
      next = text[index + 2];
      if (next === undefined) return true;
    }
    return /\s/u.test(next) || next === "@";
  };

  const isBoundary = (index: number): boolean => {
    const char = text[index]!;
    if (!CLAUSE_PUNCTUATION.has(char)) return false;
    if (protectsBoundary(index)) return false;
    if (ALWAYS_BOUNDARY.has(char) || char === "，") return true;
    return boundaryFollows(index);
  };

  const clauses: Clause[] = [];
  const pushClause = (rawStart: number, rawEnd: number) => {
    let start = rawStart;
    let end = rawEnd;
    while (start < end && /\s/u.test(text[start]!)) start += 1;
    while (end > start && /\s/u.test(text[end - 1]!)) end -= 1;
    if (start >= end) return;
    const leading = text.slice(start, end);
    const marker = LIST_MARKER.exec(leading);
    if (marker) {
      start += marker[0].length;
      while (start < end && /\s/u.test(text[start]!)) start += 1;
    }
    if (start >= end) return;
    const mentions = spans
      .filter((span) => span.start >= start && span.end <= end)
      .map((span) => ({ botId: span.botId, start: span.start, end: span.end }));
    clauses.push({ start, end, mentions });
  };

  let clauseStart = analysisStart;
  for (let index = analysisStart; index < text.length; index += 1) {
    if (isBoundary(index)) {
      pushClause(clauseStart, index);
      clauseStart = index + 1;
    }
  }
  pushClause(clauseStart, text.length);

  const classify = (clause: Clause): ClassifiedClause => {
    if (clause.mentions.length === 0) return { kind: "plain" };
    const first = clause.mentions[0]!;
    const last = clause.mentions[clause.mentions.length - 1]!;
    const botIds = unique(clause.mentions.map((mention) => mention.botId));
    const beforeFirst = text.slice(clause.start, first.start);
    const afterLast = text.slice(last.end, clause.end);
    const connectorList = clause.mentions.every(
      (mention, index) =>
        index === 0 || isConnectorGap(text.slice(clause.mentions[index - 1]!.end, mention.start)),
    );

    if (isTriviaOnly(stripAddressPrefix(beforeFirst))) {
      if (!connectorList) return { kind: "interleaved", botIds };
      return {
        kind: "addressed",
        botIds,
        instruction: trimInitialInstruction(last.end, clause.end, text),
      };
    }

    if (
      isTriviaOnly(afterLast) &&
      connectorList &&
      !REFERENCE_CONNECTOR_SUFFIX.test(beforeFirst.trim())
    ) {
      return {
        kind: "addressed",
        botIds,
        instruction: trimTrailingInstruction(clause.start, first.start, text),
      };
    }

    return { kind: "reference", botIds };
  };

  const classified = clauses.map(classify);
  const addressed = classified.filter(
    (clause): clause is Extract<ClassifiedClause, { kind: "addressed" }> =>
      clause.kind === "addressed",
  );
  const interleaved = classified.filter(
    (clause): clause is Extract<ClassifiedClause, { kind: "interleaved" }> =>
      clause.kind === "interleaved",
  );
  const references = classified.filter(
    (clause): clause is Extract<ClassifiedClause, { kind: "reference" }> =>
      clause.kind === "reference",
  );
  const plains = classified.filter((clause) => clause.kind === "plain");

  if (interleaved.length > 0) {
    return clarification(
      "ambiguous_attribution",
      unique(interleaved.flatMap((clause) => clause.botIds)),
    );
  }

  if (addressed.length === 0) {
    return { kind: "ordinary_mention", mentionBotIds, replyTargetBotId };
  }

  // Only actual dispatch targets need authorization. A non-member referenced in
  // background text stays plain text, but an addressed non-member fails the
  // whole dispatch instead of silently dropping one target.
  const unauthorized = unique(
    addressed.flatMap((clause) => clause.botIds).filter((botId) => !memberIds.has(botId)),
  );
  if (unauthorized.length > 0) {
    return clarification("target_not_authorized", unauthorized);
  }

  const hasUnconsumedClauses = references.length > 0 || plains.length > 0;
  const hasNonMentionContent = (): boolean => {
    if (prefix) return true;
    let cursor = analysisStart;
    for (const span of spans) {
      if (hasVisibleContent(text.slice(cursor, span.start))) return true;
      cursor = span.end;
    }
    return hasVisibleContent(text.slice(cursor));
  };

  if (addressed.length === 1) {
    const clause = addressed[0]!;
    if (clause.botIds.length === 1) {
      if (!clause.instruction && !hasNonMentionContent()) {
        return clarification("empty_instruction", clause.botIds);
      }
      return {
        kind: "single_owner",
        ownerBotId: clause.botIds[0]!,
        instruction: text.trim(),
        mentionBotIds,
      };
    }

    if (hasUnconsumedClauses) {
      return clarification("ambiguous_attribution", mentionBotIds);
    }
    if (!clause.instruction) {
      return clarification("empty_instruction", clause.botIds);
    }
    return {
      kind: "shared_multi",
      ownerBotIds: clause.botIds,
      instruction: clause.instruction.instruction,
      ...(prefix ? { prefix } : {}),
      mentionBotIds,
    };
  }

  if (hasUnconsumedClauses) {
    return clarification("ambiguous_attribution", mentionBotIds);
  }
  if (addressed.some((clause) => clause.botIds.length !== 1)) {
    return clarification("ambiguous_attribution", mentionBotIds);
  }
  if (addressed.some((clause) => !clause.instruction)) {
    return clarification("empty_instruction", mentionBotIds);
  }

  const segments: GroupTaskSegment[] = [];
  const instructionByBotId = new Map<string, string>();
  for (const clause of addressed) {
    const botId = clause.botIds[0]!;
    const instruction = clause.instruction!;
    const prior = instructionByBotId.get(botId);
    if (prior !== undefined) {
      if (prior !== instruction.instruction) {
        return clarification("duplicate_target_conflict", [botId]);
      }
      continue;
    }
    instructionByBotId.set(botId, instruction.instruction);
    segments.push({
      botId,
      instruction: instruction.instruction,
      start: instruction.start,
      end: instruction.end,
    });
  }

  if (segments.length === 1) {
    return {
      kind: "single_owner",
      ownerBotId: segments[0]!.botId,
      instruction: text.trim(),
      mentionBotIds,
    };
  }
  const hasAttachments = input.hasAttachments === true;
  if (hasAttachments) {
    return clarification(
      "attachments_not_attributable",
      segments.map((segment) => segment.botId),
    );
  }
  return {
    kind: "segmented_multi",
    segments,
    ...(prefix ? { prefix } : {}),
    mentionBotIds,
  };
}
