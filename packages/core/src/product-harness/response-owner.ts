import { hasMentionToken, resolveGroupTargetBotIds, type GroupMemberRef } from "../group-mentions.js";

/**
 * Product Harness Phase 1: who owns and replies to a user turn.
 *
 * This module is pure deterministic policy — no model calls. The only place a
 * small semantic Router may run is the API layer, and only after
 * `resolveExplicitTurnOwner` reports the turn as unresolved.
 */

export type ResponseMode = "single" | "multi";

export type TurnRouteKind =
  /** Single-bot thread: the thread's bot always owns the turn. */
  | "direct"
  /** The message explicitly targets exactly one group bot. */
  | "explicit_mention"
  /** The message intentionally addresses multiple group bots (multi-response). */
  | "explicit_multi"
  /** The message is a reply to a specific bot's message. */
  | "reply_target"
  /** The Group Router selected the owner for an otherwise unaddressed group turn. */
  | "group_router"
  /** Routing fell back to the group lead (no router, or router failure). */
  | "fallback_lead";

export type ResolvedTurnOwner = {
  kind: TurnRouteKind;
  /** Owners in deterministic precedence order. Multi turns carry every owner. */
  ownerBotIds: string[];
  responseMode: ResponseMode;
};

export type UnresolvedTurnOwner = {
  unresolved: true;
};

/**
 * Conservative markers that the user wants separate answers from several
 * agents. Kept short and explicit: an unlisted phrasing resolves to
 * single-owner, which is the product default.
 */
const SEPARATE_ANSWER_MARKERS: readonly RegExp[] = [
  /分别/,
  /各自/,
  /每(?:个|位)(?:人|朋友)?(?:都|分别|说说|讲讲|回答|给)/,
  /都.{0,6}(?:说说|讲讲|回答)/,
  /\beach of you\b/i,
  /\beach (?:bot|agent|one)\b/i,
  /\bboth of you\b/i,
  /\ball of you\b/i,
  /\bseparately\b/i,
  /\bindividually\b/i,
  /\bone by one\b/i,
  /\ball weigh in\b/i,
];

export function requestsSeparateAnswers(text: string): boolean {
  return SEPARATE_ANSWER_MARKERS.some((pattern) => pattern.test(text));
}

/**
 * Deterministic owner resolution for one group user turn.
 *
 * Precedence (Product Harness §2):
 *   1. explicit mentions (@Name chips/tokens; @everyone keeps all-member semantics);
 *   2. reply target (message is a reply to a specific bot's message);
 *   3. otherwise unresolved — the caller may consult the Group Router and then
 *      the group lead. There is no implicit first-member routing anymore.
 */
export function resolveExplicitTurnOwner(input: {
  text: string;
  members: readonly GroupMemberRef[];
  /** Bot ids from typed mention chips. Non-members are ignored for ownership. */
  explicitMentionIds?: readonly string[];
  /** Bot id that authored the message this turn replies to, if any. */
  replyTargetBotId?: string | null;
}): ResolvedTurnOwner | UnresolvedTurnOwner {
  const memberIds = new Set(input.members.map((member) => member.id));
  const targets = resolveGroupTargetBotIds({
    text: input.text,
    members: [...input.members],
    explicitMentions: input.explicitMentionIds ? [...input.explicitMentionIds] : undefined,
  });

  if (targets.length > 0) {
    if (hasMentionToken(input.text, "everyone")) {
      // @everyone is the user intentionally addressing all members: keep the
      // existing all-member wake semantics, expressed as explicit multi.
      return { kind: "explicit_multi", ownerBotIds: [...input.members.map((m) => m.id)], responseMode: "multi" };
    }
    if (targets.length === 1) {
      return { kind: "explicit_mention", ownerBotIds: targets, responseMode: "single" };
    }
    if (requestsSeparateAnswers(input.text)) {
      return { kind: "explicit_multi", ownerBotIds: targets, responseMode: "multi" };
    }
    // Multiple explicit targets without a separate-answers request: default
    // policy is exactly one response owner, in mention precedence order.
    return { kind: "explicit_mention", ownerBotIds: [targets[0]!], responseMode: "single" };
  }

  if (input.replyTargetBotId && memberIds.has(input.replyTargetBotId)) {
    return { kind: "reply_target", ownerBotIds: [input.replyTargetBotId], responseMode: "single" };
  }

  return { unresolved: true };
}

export function resolveDirectTurnOwner(botId: string): ResolvedTurnOwner {
  return { kind: "direct", ownerBotIds: [botId], responseMode: "single" };
}
