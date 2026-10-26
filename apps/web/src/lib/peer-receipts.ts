import type {
  CollaborationReceiptBlock,
  DestinationLocator,
  MessageBlock,
  ThreadMessage,
} from "@rakazo/contracts";

export type PairDestination = Extract<DestinationLocator, { kind: "pair_message" }>;

export interface PeerReceiptTarget {
  key: string;
  botId: string;
  botName: string | null;
  state: CollaborationReceiptBlock["state"];
  destination: PairDestination | null;
  sourceReceiptMessageId: string;
  direction: "sent" | "received";
}

export interface PeerReceiptGroup {
  id: string;
  anchorMessageId: string;
  messageIds: string[];
  targets: PeerReceiptTarget[];
}

type BotCollaborationReceipt = Extract<MessageBlock, { kind: "collaboration_receipt" }> & {
  target: Extract<CollaborationReceiptBlock["target"], { kind: "bot" }>;
};

type ReceiptBlock =
  | Extract<MessageBlock, { kind: "bot_message_sent" | "bot_message_received" }>
  | BotCollaborationReceipt;

function isReceiptBlock(block: MessageBlock): block is ReceiptBlock {
  if (block.kind === "collaboration_receipt") return block.target.kind === "bot";
  // Legacy private sends live in the sender's own Thread and carry the body.
  // Group Threads never reach this helper (their sent blocks are public
  // delegations), and pair-side bodies are read through the pair overlay, so a
  // nonempty source-thread send is still a receipt — rendered without its text.
  if (block.kind === "bot_message_sent") return true;
  return block.kind === "bot_message_received";
}

function receiptBlocks(message: ThreadMessage): ReceiptBlock[] {
  const blocks = message.blocks.filter(isReceiptBlock);
  if (blocks.length === 0 || blocks.length !== message.blocks.length) return [];
  return blocks;
}

function targetFromBlock(
  message: ThreadMessage,
  block: ReceiptBlock,
  index: number,
): PeerReceiptTarget {
  if (block.kind === "collaboration_receipt") {
    const destination = block.destination?.kind === "pair_message" ? block.destination : null;
    return {
      key: `${message.id}:${index}:${block.target.botId}`,
      botId: block.target.botId,
      botName: null,
      state: block.state,
      destination,
      sourceReceiptMessageId: message.id,
      direction: "sent",
    };
  }
  if (block.kind === "bot_message_sent") {
    return {
      key: `${message.id}:${index}:${block.toBotId}`,
      botId: block.toBotId,
      botName: block.toBotName,
      state: "sent",
      destination: null,
      sourceReceiptMessageId: message.id,
      direction: "sent",
    };
  }
  return {
    key: `${message.id}:${index}:${block.fromBotId}`,
    botId: block.fromBotId,
    botName: block.fromBotName,
    state: "completed",
    destination: null,
    sourceReceiptMessageId: message.id,
    direction: "received",
  };
}

function dedupeTargets(targets: PeerReceiptTarget[]): PeerReceiptTarget[] {
  const byBot = new Map<string, PeerReceiptTarget>();
  for (const target of targets) {
    const existing = byBot.get(target.botId);
    if (!existing) {
      byBot.set(target.botId, target);
      continue;
    }
    // The latest delivery wins, but an earlier receipt with a locator is still
    // the only openable history when a later retry failed without a message.
    byBot.set(target.botId, {
      ...target,
      destination: target.destination ?? existing.destination,
      botName: target.botName ?? existing.botName,
    });
  }
  return [...byBot.values()];
}

/**
 * Group adjacent private-pair receipts from one source Run. The adapter writes
 * one receipt message per target; the transcript shows one lightweight row for
 * the batch and expands the roster on demand. Legacy receipts have no locator
 * and therefore group into a non-openable row.
 */
export function groupPeerReceipts(messages: readonly ThreadMessage[]): {
  groups: PeerReceiptGroup[];
  groupByMessageId: Map<string, PeerReceiptGroup>;
} {
  const groups: PeerReceiptGroup[] = [];
  const groupByMessageId = new Map<string, PeerReceiptGroup>();
  let previousKey: string | null = null;
  let open: PeerReceiptGroup | null = null;

  for (const message of messages) {
    const blocks = receiptBlocks(message);
    if (blocks.length === 0) {
      previousKey = null;
      open = null;
      continue;
    }
    const key = message.runId ?? `message:${message.id}`;
    const targets = blocks.map((block, index) => targetFromBlock(message, block, index));
    if (open && previousKey === key) {
      open.messageIds.push(message.id);
      open.targets = dedupeTargets([...open.targets, ...targets]);
    } else {
      open = {
        id: `peer-receipt:${message.id}`,
        anchorMessageId: message.id,
        messageIds: [message.id],
        targets: dedupeTargets(targets),
      };
      groups.push(open);
    }
    groupByMessageId.set(message.id, open);
    previousKey = key;
  }
  return { groups, groupByMessageId };
}

/** One message's own receipt targets, for rows that also carry other blocks. */
export function peerReceiptTargetsForMessage(message: ThreadMessage): PeerReceiptTarget[] {
  return dedupeTargets(
    receiptBlocks(message).map((block, index) => targetFromBlock(message, block, index)),
  );
}
