import type { BotMessageIntent, ThreadMessage } from "@rakazo/contracts";

/**
 * User-level fate of one public delegation. These are dispatch words, never
 * execution states: a completed or failed target Run is still "sent" here,
 * because the group thread proves the target received the delegation. Progress
 * and outcomes belong to the work projection (RT-20/RT-23), not to chat.
 */
export type PublicDelegationTrace = "sent" | "failed" | "unknown";

export type PublicDelegationDelivery = Readonly<{
  /** The persisted sender-side message that owns this delivery. */
  messageId: string;
  targetBotId: string;
  /** Name stored on the message when the delegation was written. */
  targetFallbackName: string;
  /** Target Run that received the delegation; absent while the pair is unknown. */
  targetRunId?: string;
  body: string;
  intent: BotMessageIntent;
  trace: PublicDelegationTrace;
}>;

export type PublicDelegationGroup = Readonly<{
  sourceRunId?: string;
  senderBotId?: string;
  senderFallbackName?: string;
  firstMessageId: string;
  /** Persisted message ids visually merged into this group. */
  messageIds: readonly string[];
  deliveries: readonly PublicDelegationDelivery[];
}>;

export type PublicDelegationProjection = Readonly<{
  groupsByFirstMessageId: ReadonlyMap<string, PublicDelegationGroup>;
  /** Wake messages, legacy inbound prompts, and merged sender records. */
  hiddenMessageIds: ReadonlySet<string>;
}>;

type OutboundBlock = Extract<ThreadMessage["blocks"][number], { kind: "bot_message_sent" }>;
type InboundBlock = Extract<ThreadMessage["blocks"][number], { kind: "bot_message_received" }>;

type Inbound = Readonly<{
  messageId: string;
  fromBotName?: string;
  targetRunId?: string;
}>;

function outboundBlockOf(message: ThreadMessage): OutboundBlock | undefined {
  return message.blocks.find((block): block is OutboundBlock => block.kind === "bot_message_sent");
}

function inboundBlockOf(message: ThreadMessage): InboundBlock | undefined {
  return message.blocks.find(
    (block): block is InboundBlock => block.kind === "bot_message_received",
  );
}

/**
 * Project public group delegations for display only.
 *
 * The write path stores two rows per delivery in one transaction: the sender's
 * `bot_message_sent` record and the target's `bot_message_received` wake
 * prompt, linked by `returnToMessageId`. Pairing therefore uses that persisted
 * relation only. It never parses `@name` text, matches bodies, or guesses from
 * ordering.
 *
 * The sender row stays visible as a natural group message. The wake prompt is
 * hidden: it repeats the same body and is an internal prompt, not something the
 * user sent. Adjacent deliveries from the same source Run and sender merge into
 * one bubble, but every row keeps its own target identity and target Run id.
 *
 * A sender row without its persisted pair is reported as `failed` once it is no
 * longer the final message of the window: the atomic pair can only be split
 * across a page boundary at the window edge, so an interior orphan means the
 * delivery has no target record. At the edge the fate is `unknown` and no
 * dispatch word is shown. Legacy inbound prompts without a return pointer are
 * hidden too, so a group transcript can never fall back to the private receipt
 * path.
 */
export function projectPublicDelegations(
  messages: readonly ThreadMessage[],
): PublicDelegationProjection {
  const inboundByReturnTo = new Map<string, Inbound>();
  for (const message of messages) {
    const block = inboundBlockOf(message);
    if (block?.returnToMessageId) {
      inboundByReturnTo.set(block.returnToMessageId, {
        messageId: message.id,
        ...(block.fromBotName ? { fromBotName: block.fromBotName } : {}),
        ...(message.runId ? { targetRunId: message.runId } : {}),
      });
    }
  }

  const groupsByFirstMessageId = new Map<string, PublicDelegationGroup>();
  const hiddenMessageIds = new Set<string>();
  let current: {
    sourceRunId?: string;
    senderBotId?: string;
    senderFallbackName?: string;
    firstMessageId: string;
    messageIds: string[];
    deliveries: PublicDelegationDelivery[];
  } | null = null;
  const lastIndex = messages.length - 1;

  messages.forEach((message, index) => {
    if (inboundBlockOf(message)) {
      // The wake prompt is the transport half of the delivery above it; it does
      // not break adjacency and never renders as the user's own message.
      hiddenMessageIds.add(message.id);
      return;
    }

    const outbound = outboundBlockOf(message);
    if (!outbound) {
      current = null;
      return;
    }

    const paired = inboundByReturnTo.get(message.id);
    const trace: PublicDelegationTrace = paired
      ? "sent"
      : index === lastIndex
        ? "unknown"
        : "failed";
    const delivery: PublicDelegationDelivery = {
      messageId: message.id,
      targetBotId: outbound.toBotId,
      targetFallbackName: outbound.toBotName,
      ...(paired?.targetRunId ? { targetRunId: paired.targetRunId } : {}),
      body: outbound.text,
      intent: outbound.intent ?? "request",
      trace,
    };
    const sourceRunId = message.runId;
    const senderBotId = message.botId;
    const mergeable =
      current !== null &&
      Boolean(sourceRunId) &&
      Boolean(senderBotId) &&
      current.sourceRunId === sourceRunId &&
      current.senderBotId === senderBotId;

    if (current && mergeable) {
      current.messageIds.push(message.id);
      if (paired) current.messageIds.push(paired.messageId);
      current.deliveries.push(delivery);
      hiddenMessageIds.add(message.id);
      return;
    }

    current = {
      ...(sourceRunId ? { sourceRunId } : {}),
      ...(senderBotId ? { senderBotId } : {}),
      ...(paired?.fromBotName ? { senderFallbackName: paired.fromBotName } : {}),
      firstMessageId: message.id,
      messageIds: paired ? [message.id, paired.messageId] : [message.id],
      deliveries: [delivery],
    };
    groupsByFirstMessageId.set(message.id, current);
  });

  return { groupsByFirstMessageId, hiddenMessageIds };
}
