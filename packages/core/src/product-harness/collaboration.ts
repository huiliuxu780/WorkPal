import { parseRunOrchestration } from "./orchestration.js";

/**
 * Product Harness Phase 3 — Persistent-bot collaboration lineage.
 *
 * Four frozen concepts:
 *   Response Owner = the persistent bot that may complete this stage for the user
 *   Support Bot    = a persistent bot doing delegated partial work for the owner
 *   message_bot    = delegation/consultation; ownership does NOT move
 *   handoff_to_bot = ownership of the current stage transfers
 *
 * A "stage" is the span of continuous ownership; it is not a table. The
 * lineage below is persisted inside the immutable Run.orchestration snapshot
 * so retries reuse it verbatim and observability can derive handoffDepth,
 * messageHop, supportRuns and ownerChanges without new tables.
 */

/** Hard product limit on ownership transfers within one user turn (§13). */
export const MAX_HANDOFF_DEPTH = 2;

export const HANDOFF_DEPTH_ERROR =
  "Handoff limit reached for this user turn. Complete the current stage yourself or explain the blocker.";

export const HANDOFF_BOUNCE_ERROR =
  "Do not hand this stage back merely to report completion. Complete it here or send a useful result/message instead.";

export type CollaborationRole = "owner" | "support";
export type CollaborationSource = "user" | "bot_message" | "handoff";

export type CollaborationLineageV1 = {
  role: CollaborationRole;
  source: CollaborationSource;
  fromBotId: string | null;
  parentRunId: string | null;
  handoffDepth: number;
  messageHop: number;
};

/** Lineage of a run started by a real user turn: the owner at depth zero. */
export function userTurnCollaboration(): CollaborationLineageV1 {
  return {
    role: "owner",
    source: "user",
    fromBotId: null,
    parentRunId: null,
    handoffDepth: 0,
    messageHop: 0,
  };
}

/** Lineage of a message_bot recipient: support, ownership stays with the sender. */
export function supportCollaboration(input: {
  fromBotId: string;
  parentRunId: string;
  handoffDepth: number;
  messageHop: number;
}): CollaborationLineageV1 {
  return {
    role: "support",
    source: "bot_message",
    fromBotId: input.fromBotId,
    parentRunId: input.parentRunId,
    handoffDepth: input.handoffDepth,
    messageHop: input.messageHop,
  };
}

/** Lineage of a handoff recipient: the new owner of this stage. */
export function handoffCollaboration(input: {
  fromBotId: string;
  parentRunId: string;
  handoffDepth: number;
}): CollaborationLineageV1 {
  return {
    role: "owner",
    source: "handoff",
    fromBotId: input.fromBotId,
    parentRunId: input.parentRunId,
    handoffDepth: input.handoffDepth,
    messageHop: 0,
  };
}

/**
 * §13: `Alice → Bob` is depth 1, `Bob → Charlie` is depth 2, a third transfer
 * in the same user turn is rejected at the product layer (a tool error, not a
 * prompt request).
 */
export function nextHandoffDepth(currentDepth: number): number {
  return currentDepth + 1;
}

export function handoffDepthExceeded(currentDepth: number): boolean {
  return nextHandoffDepth(currentDepth) > MAX_HANDOFF_DEPTH;
}

/**
 * §14: never bounce a stage back to the bot that handed it over merely to
 * report completion. A genuinely new user instruction after the handoff
 * releases the rule.
 */
export function isHandoffBounceBack(input: {
  targetBotId: string;
  fromBotId: string | null;
  hasNewUserInstruction: boolean;
}): boolean {
  return (
    !input.hasNewUserInstruction &&
    input.fromBotId !== null &&
    input.targetBotId === input.fromBotId
  );
}

/**
 * §15: acknowledgement-loop rules for message_bot, evaluated deterministically
 * before any delivery. A run woken by a result/status must fold the outcome
 * into its own answer instead of acking the sender; fyi/status replies to the
 * sender are the ack shapes. Questions and new requests stay allowed.
 */
export function isAcknowledgementLoop(input: {
  /** Intent of the bot message that woke the current run, if any. */
  wokeIntent: string | undefined;
  /** The message being sent targets the bot that woke this run. */
  targetsWaker: boolean;
  /** Intent of the outgoing message. */
  intent: string;
}): boolean {
  if (!input.targetsWaker) return false;
  const woke = input.wokeIntent ?? "request";
  const wokenByOutcome = woke === "result" || woke === "status";
  return wokenByOutcome && (input.intent === "fyi" || input.intent === "status");
}

export const ACK_LOOP_ERROR =
  "Do not acknowledge a result — incorporate it and answer the user. Message this bot only with a substantive question or new information.";

export const DUPLICATE_MESSAGE_ERROR =
  "This exact message was already sent to this bot in the current run. Do not repeat the same information.";

export type CollaborationContextRole = "owner" | "support" | "handoff_owner";

/**
 * The runtime-facing collaboration identity for a run (§21). Derived from the
 * immutable lineage snapshot; the trigger is only the fallback for pre-Phase-3
 * rows. Never guessed from prompt content.
 */
export function collaborationContextRole(
  lineage: CollaborationLineageV1 | null,
  trigger: string,
): CollaborationContextRole {
  if (lineage?.source === "handoff") return "handoff_owner";
  if (lineage?.role === "support") return "support";
  if (!lineage && trigger === "bot_message") return "support";
  return "owner";
}

/** Read the persisted lineage from a run's orchestration snapshot, if any. */
export function collaborationFromOrchestration(orchestration: unknown): CollaborationLineageV1 | null {
  const snapshot = parseRunOrchestration(orchestration);
  return snapshot?.collaboration ?? null;
}
