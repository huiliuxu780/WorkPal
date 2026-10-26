import type { MessageBlock, PairThreadMessage } from "@rakazo/contracts";
import { rpc } from "./rpc";

export type PairMessageInput = {
  sourceReceiptMessageId: string;
  locator: { kind: "pair_message"; pairThreadId: string; messageId: string };
  before?: string;
  limit?: number;
};

/**
 * The only pair-history read used by the Web. It always carries the source
 * receipt and the message locator so the server can authorize the reader again;
 * there is deliberately no generic messages query here.
 */
export function loadPairPage(input: PairMessageInput, options?: { signal?: AbortSignal }) {
  return rpc.threads.pairMessages(
    {
      sourceReceiptMessageId: input.sourceReceiptMessageId,
      locator: input.locator,
      ...(input.before ? { before: input.before } : {}),
      limit: input.limit ?? 50,
    },
    options,
  );
}

export type PairTranscriptEntry = {
  id: string;
  direction: "sent" | "received";
  text: string;
  createdAt: string;
};

function messageBody(message: PairThreadMessage): PairTranscriptEntry | null {
  for (const block of message.blocks) {
    if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
      return {
        id: message.id,
        direction: block.kind === "bot_message_sent" ? "sent" : "received",
        text: block.text,
        createdAt: message.createdAt,
      };
    }
    if (block.kind === "text") {
      return {
        id: message.id,
        direction: message.role === "user" ? "received" : "sent",
        text: block.text,
        createdAt: message.createdAt,
      };
    }
  }
  return null;
}

function returnToMessageId(blocks: readonly MessageBlock[]): string | null {
  for (const block of blocks) {
    if (block.kind === "bot_message_received" && block.returnToMessageId) {
      return block.returnToMessageId;
    }
  }
  return null;
}

/**
 * The pair Thread stores both the sender's outbound and the recipient's wake
 * copy for one delivery. Render the outbound and skip the wake duplicate when
 * both are in the loaded window; a legacy-only wake still renders once.
 */
export function pairTranscript(messages: readonly PairThreadMessage[]): PairTranscriptEntry[] {
  const ids = new Set(messages.map((message) => message.id));
  const duplicateWakeIds = new Set(
    messages
      .filter((message) => {
        const returnTo = returnToMessageId(message.blocks);
        return returnTo !== null && ids.has(returnTo);
      })
      .map((message) => message.id),
  );
  const entries: PairTranscriptEntry[] = [];
  for (const message of messages) {
    if (duplicateWakeIds.has(message.id)) continue;
    const entry = messageBody(message);
    if (entry?.text.trim()) entries.push(entry);
  }
  return entries;
}
