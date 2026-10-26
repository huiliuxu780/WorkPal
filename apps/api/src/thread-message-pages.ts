import type { MessageBlock, ThreadMessage, ThreadMessagePage } from "@rakazo/contracts";
import { callIdFromClientNonce, isPeerReceiptBlocks } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";

type MessageDb = PrismaClient | Prisma.TransactionClient;

export async function loadMessagePage(
  prisma: MessageDb,
  threadId: string,
  before: number | undefined,
  pageSize: number,
  around?: { messageId?: string; seq?: number },
  includePeerRuns = false,
  includePeerReceipts = false,
): Promise<ThreadMessagePage> {
  if (around) {
    let targetSeq = around.seq;
    if (targetSeq === undefined && around.messageId) {
      const row = await prisma.message.findFirst({
        where: { id: around.messageId, threadId },
        select: { seq: true },
      });
      targetSeq = row?.seq;
    }
    if (targetSeq !== undefined) {
      const half = Math.floor(pageSize / 2);
      const minSeq = Math.max(0, targetSeq - half);
      const maxSeq = targetSeq + half;
      const rows = await prisma.message.findMany({
        where: { threadId, seq: { gte: minSeq, lte: maxSeq } },
        orderBy: { seq: "asc" },
        take: pageSize,
      });
      const first = rows[0];
      const hasOlder = first
        ? (await prisma.message.count({ where: { threadId, seq: { lt: first.seq } } })) > 0
        : false;
      // Peer text/activity stays out of the normal transcript (including the
      // around target). Receipts remain via withoutPeerRunMessages; full peer
      // history belongs in the bot-messages overlay (includePeerRuns).
      const messages = includePeerRuns ? rows : await withoutPeerRunMessages(prisma, rows);
      return {
        threadId,
        messages: messages.map(toThreadMessage),
        olderCursor: hasOlder ? (first?.seq ?? null) : null,
      };
    }
  }

  let cursor = before;
  while (true) {
    const rows = await prisma.message.findMany({
      where: {
        threadId,
        ...(cursor === undefined ? {} : { seq: { lt: cursor } }),
      },
      orderBy: { seq: "desc" },
      take: pageSize + 1,
    });
    const hasOlder = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize).reverse();
    const visibleRows = includePeerRuns ? pageRows : await withoutPeerRunMessages(prisma, pageRows);
    // Web hides receipts client-side, so its receipt-only pages keep scanning.
    // Mobile explicitly retains them and must receive each page for pagination.
    const hasSubstantive = visibleRows.some(
      (row) => !isPeerReceiptBlocks(row.blocks as MessageBlock[]),
    );
    if (hasSubstantive || includePeerReceipts || !hasOlder || includePeerRuns) {
      return {
        threadId,
        messages: visibleRows.map(toThreadMessage),
        olderCursor: hasOlder ? (pageRows[0]?.seq ?? null) : null,
      };
    }
    // TODO: only rescan when a raw page is entirely peer output. Consider a run relation if
    // long peer-only histories make this path hot.
    cursor = pageRows[0]?.seq;
  }
}

export async function loadAllMessages(
  prisma: PrismaClient,
  threadId: string,
  pageSize: number,
): Promise<ThreadMessage[]> {
  const pages: ThreadMessage[][] = [];
  let before: number | undefined;
  do {
    const page = await loadMessagePage(prisma, threadId, before, pageSize, undefined, true);
    pages.push(page.messages);
    before = page.olderCursor ?? undefined;
  } while (before !== undefined);
  return pages.reverse().flat();
}

async function withoutPeerRunMessages<
  T extends { runId: string | null; threadId: string; blocks: Prisma.JsonValue },
>(
  prisma: MessageDb,
  rows: T[],
): Promise<T[]> {
  const runIds = [...new Set(rows.flatMap((row) => (row.runId ? [row.runId] : [])))];
  if (runIds.length === 0) return rows;
  const peerRuns = await prisma.run.findMany({
    where: { id: { in: runIds }, trigger: "bot_message" },
    select: { id: true, threadId: true },
  });
  const peerRunIds = new Set(peerRuns.map((run) => run.id));
  // RT-05F: a delegated run executes in a hidden pair Thread; a computer-only
  // row from that run living in ANOTHER Thread is a projected takeover card,
  // so it passes even though computer-only peer messages are otherwise hidden
  // execution noise. Every other peer row keeps the kind filter below.
  const executionThreadByRun = new Map(peerRuns.map((run) => [run.id, run.threadId]));
  const admittedKinds = (block: MessageBlock) =>
    block.kind === "bot_message_sent" ||
    block.kind === "bot_message_received" ||
    (block.kind === "collaboration_receipt" && block.target.kind === "bot") ||
    block.kind === "ask" ||
    block.kind === "text";
  return rows.filter((row) => {
    if (!row.runId || !peerRunIds.has(row.runId)) return true;
    const blocks = row.blocks as MessageBlock[];
    if (executionThreadByRun.get(row.runId) !== row.threadId) {
      return (
        blocks.some(admittedKinds) ||
        blocks.some((block) => block.kind === "computer")
      );
    }
    // Keep peer receipts (chips), ask cards, and the bot's own text reply.
    return blocks.some(admittedKinds);
  });
}

export async function isPeerRun(
  prisma: MessageDb,
  runId: string | undefined,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (!runId) return false;
  let peerRun = cache.get(runId);
  if (!peerRun) {
    peerRun = prisma.run
      .findUnique({ where: { id: runId }, select: { trigger: true } })
      .then((run) => run?.trigger === "bot_message");
    cache.set(runId, peerRun);
  }
  return peerRun;
}

/** Peer-run SSE events that must still reach an open thread (terminals, waits, receipts, asks, text). */
export function shouldForwardPeerThreadEvent(event: {
  type: string;
  payload: { blocks?: unknown };
}): boolean {
  if (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled" ||
    event.type === "run.waiting_input" ||
    event.type === "computer.takeover.requested" ||
    // RT-05F: a projected takeover's release must reach the origin stream so
    // the user's chat stops showing the wait after acting.
    event.type === "computer.takeover.granted" ||
    event.type === "computer.takeover.released" ||
    // Phase 4: collaboration activity belongs to the delegating turn's live
    // view; dropping it here would make live and refreshed snapshots diverge.
    event.type === "thread.collaboration.requested" ||
    event.type === "thread.collaboration.result"
  ) {
    return true;
  }
  if (event.type !== "thread.message.created" && event.type !== "thread.message.updated") {
    return false;
  }
  const blocks = event.payload.blocks;
  // A computer block on a peer-run message in THIS Thread's stream is a
  // projected takeover card (RT-05F): execution-pair noise never reaches the
  // origin's stream, so admitting it here is precisely the projection.
  return (
    Array.isArray(blocks) &&
    blocks.some(
      (block) =>
        !!block &&
        typeof block === "object" &&
        "kind" in block &&
        (block.kind === "bot_message_received" ||
          block.kind === "bot_message_sent" ||
          (block.kind === "collaboration_receipt" && block.target.kind === "bot") ||
          block.kind === "ask" ||
          block.kind === "text" ||
          block.kind === "computer"),
    )
  );
}

function toThreadMessage(row: {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: Prisma.JsonValue;
  botId: string | null;
  replyToMessageId: string | null;
  replyQuote: string | null;
  runId: string | null;
  clientNonce?: string | null;
  createdAt: Date;
}): ThreadMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as ThreadMessage["role"],
    blocks: row.blocks as ThreadMessage["blocks"],
    botId: row.botId ?? undefined,
    replyToMessageId: row.replyToMessageId ?? undefined,
    replyQuote: row.replyQuote ?? undefined,
    runId: row.runId ?? undefined,
    callId: callIdFromClientNonce(row.clientNonce),
    createdAt: row.createdAt.toISOString(),
  };
}
