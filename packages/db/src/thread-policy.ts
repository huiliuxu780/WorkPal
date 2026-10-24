import {
  type Actor,
  type PairThreadMessage,
  type PairThreadMessagePage,
  PairThreadMessageSchema,
} from "@rakazo/contracts";
import { callIdFromClientNonce } from "@rakazo/core";
import { CHAT_GROUP_KIND_AGENT_PAIR, CHAT_GROUP_KIND_STANDARD } from "./agent-pairs.js";
import { Prisma, type PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

type ThreadDb = PrismaClient | Prisma.TransactionClient;

export type PairOriginLocator = Readonly<{
  sourceReceiptMessageId: string;
  pairThreadId: string;
  messageId: string;
}>;

export type PairThreadReadRequest = Readonly<{
  actor: Pick<Actor, "spaceId" | "userId">;
  originLocator: PairOriginLocator;
  before?: string;
  limit: number;
}>;

export type RecordPairMessageOriginInput = Readonly<{
  messageId: string;
  pairThreadId: string;
  sourceThreadId: string;
  sourceRunId: string;
  sourceReceiptMessageId: string;
}>;

type AuthorizedMessageRow = {
  id: string;
  seq: number;
  role: string;
  blocks: Prisma.JsonValue;
  botId: string | null;
  replyToMessageId: string | null;
  replyQuote: string | null;
  runId: string | null;
  clientNonce: string | null;
  createdAt: Date;
};

type ReadGrant = {
  targetSeq: number;
  visibleIndex: number;
};

function authorizedPairMessages(input: {
  actor: Pick<Actor, "spaceId" | "userId">;
  pairThreadId: string;
}) {
  return Prisma.sql`
    SELECT message.id,
           message.seq,
           message.role,
           message.blocks,
           message."botId",
           message."replyToMessageId",
           message."replyQuote",
           message."runId",
           message."clientNonce",
           message."createdAt"
    FROM agent_pair_message_origins origin
    INNER JOIN messages message
      ON message.id = origin."messageId"
     AND message."threadId" = origin."pairThreadId"
    INNER JOIN threads pair_thread
      ON pair_thread.id = origin."pairThreadId"
    INNER JOIN chat_groups pair_group
      ON pair_group.id = pair_thread."groupId"
     AND pair_group.kind = ${CHAT_GROUP_KIND_AGENT_PAIR}
     AND pair_group."spaceId" = ${input.actor.spaceId}
     AND pair_group."userId" = ${input.actor.userId}
    INNER JOIN threads source_thread
      ON source_thread.id = origin."sourceThreadId"
    LEFT JOIN chat_groups source_group
      ON source_group.id = source_thread."groupId"
    INNER JOIN runs source_run
      ON source_run.id = origin."sourceRunId"
     AND source_run."threadId" = origin."sourceThreadId"
    INNER JOIN messages source_receipt
      ON source_receipt.id = origin."sourceReceiptMessageId"
     AND source_receipt."threadId" = origin."sourceThreadId"
     -- The receipt is either the message that started the source Run, or a
     -- lightweight receipt the source Run itself wrote (RT-05 private-pair
     -- delivery). Anything else is not provenance.
     AND (
       source_run."sourceMessageId" = source_receipt.id
       OR source_receipt."runId" = source_run.id
     )
    WHERE origin."pairThreadId" = ${input.pairThreadId}
      AND pair_thread."spaceId" = ${input.actor.spaceId}
      AND pair_thread."userId" = ${input.actor.userId}
      AND source_thread."spaceId" = ${input.actor.spaceId}
      AND source_thread."userId" = ${input.actor.userId}
      AND (source_group.id IS NULL OR source_group.kind = ${CHAT_GROUP_KIND_STANDARD})
  `;
}

async function authorizePairRead(
  db: ThreadDb,
  input: Pick<PairThreadReadRequest, "actor" | "originLocator">,
): Promise<ReadGrant> {
  const visible = authorizedPairMessages({
    actor: input.actor,
    pairThreadId: input.originLocator.pairThreadId,
  });
  const rows = await db.$queryRaw<ReadGrant[]>(Prisma.sql`
    WITH authorized AS (${visible})
    SELECT target.seq AS "targetSeq",
           (SELECT COUNT(*)::int FROM authorized older WHERE older.seq < target.seq)
             AS "visibleIndex"
    FROM authorized target
    INNER JOIN agent_pair_message_origins origin
      ON origin."messageId" = target.id
     AND origin."pairThreadId" = ${input.originLocator.pairThreadId}
     AND origin."sourceReceiptMessageId" = ${input.originLocator.sourceReceiptMessageId}
    WHERE target.id = ${input.originLocator.messageId}
    LIMIT 1
  `);
  const grant = rows[0];
  if (!grant) throw new IsolationError();
  return grant;
}

function toPairThreadMessage(row: AuthorizedMessageRow): PairThreadMessage {
  const callId = callIdFromClientNonce(row.clientNonce);
  return PairThreadMessageSchema.parse({
    id: row.id,
    role: row.role,
    blocks: row.blocks,
    ...(row.botId ? { botId: row.botId } : {}),
    ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
    ...(row.replyQuote ? { replyQuote: row.replyQuote } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    ...(callId ? { callId } : {}),
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Stores the authorization origin beside one pair message. The private-pair
 * delivery transaction calls this for every message that may enter a human
 * projection. Unmapped messages remain Agent-only.
 */
export async function recordAgentPairMessageOrigin(
  db: ThreadDb,
  input: RecordPairMessageOriginInput,
): Promise<void> {
  // This helper is designed for the caller's delivery transaction. Keep its
  // reads sequential because transaction clients use one PostgreSQL connection.
  const pairMessage = await db.message.findFirst({
    where: {
      id: input.messageId,
      threadId: input.pairThreadId,
      thread: { group: { is: { kind: CHAT_GROUP_KIND_AGENT_PAIR } } },
    },
    select: { id: true },
  });
  const sourceReceipt = await db.message.findFirst({
    where: {
      id: input.sourceReceiptMessageId,
      threadId: input.sourceThreadId,
      thread: {
        OR: [{ groupId: null }, { group: { is: { kind: CHAT_GROUP_KIND_STANDARD } } }],
      },
    },
    select: { id: true, runId: true },
  });
  const sourceRun = await db.run.findFirst({
    where: {
      id: input.sourceRunId,
      threadId: input.sourceThreadId,
    },
    select: { id: true, sourceMessageId: true },
  });
  if (!pairMessage || !sourceReceipt || !sourceRun) throw new IsolationError();
  // Provenance: the receipt either started the source Run, or the source Run
  // wrote it as a lightweight delivery receipt in its own Thread.
  if (sourceRun.sourceMessageId !== sourceReceipt.id && sourceRun.id !== sourceReceipt.runId) {
    throw new IsolationError();
  }

  await db.agentPairMessageOrigin.create({ data: input });
}

export interface ThreadPolicy {
  classify(threadId: string): Promise<"bot" | "group" | "agent_pair">;
  assertHumanCanRead(input: {
    actor: Pick<Actor, "spaceId" | "userId">;
    pairThreadId: string;
    originLocator: PairOriginLocator;
  }): Promise<void>;
  assertHumanCanWrite(input: {
    actor: Pick<Actor, "spaceId" | "userId">;
    threadId: string;
  }): Promise<void>;
  assertResolvedHumanCanWrite(input: {
    actor: Pick<Actor, "spaceId" | "userId">;
    threadId: string;
    classification: "bot" | "group" | "agent_pair";
  }): Promise<void>;
  assertRoutineBindingAllowed(threadId: string): Promise<void>;
  readPairMessages(input: PairThreadReadRequest): Promise<PairThreadMessagePage>;
}

/** Central policy for every human read/write decision involving Agent pairs. */
export function createThreadPolicy(prisma: PrismaClient): ThreadPolicy {
  return {
    async classify(threadId) {
      const thread = await prisma.thread.findUnique({
        where: { id: threadId },
        select: { botId: true, group: { select: { kind: true } } },
      });
      if (!thread) throw new IsolationError();
      if (thread.botId) return "bot";
      if (thread.group?.kind === CHAT_GROUP_KIND_STANDARD) return "group";
      if (thread.group?.kind === CHAT_GROUP_KIND_AGENT_PAIR) return "agent_pair";
      throw new IsolationError();
    },

    async assertHumanCanRead(input) {
      if (input.pairThreadId !== input.originLocator.pairThreadId) throw new IsolationError();
      await authorizePairRead(prisma, {
        actor: input.actor,
        originLocator: input.originLocator,
      });
    },

    async assertHumanCanWrite(input) {
      const thread = await prisma.thread.findFirst({
        where: {
          id: input.threadId,
          spaceId: input.actor.spaceId,
          userId: input.actor.userId,
          OR: [{ groupId: null }, { group: { is: { kind: CHAT_GROUP_KIND_STANDARD } } }],
        },
        select: { id: true },
      });
      if (!thread) throw new IsolationError();
    },

    async assertResolvedHumanCanWrite(input) {
      // The normal target resolver already authorized actor + Thread. This
      // method owns the remaining kind decision without another database read.
      if (input.classification === "agent_pair") throw new IsolationError();
    },

    async assertRoutineBindingAllowed(threadId) {
      const thread = await prisma.thread.findFirst({
        where: {
          id: threadId,
          OR: [{ groupId: null }, { group: { is: { kind: CHAT_GROUP_KIND_STANDARD } } }],
        },
        select: { id: true },
      });
      if (!thread) throw new IsolationError();
    },

    async readPairMessages(input) {
      return prisma.$transaction(
        async (tx) => {
          const grant = await authorizePairRead(tx, input);
          const visible = authorizedPairMessages({
            actor: input.actor,
            pairThreadId: input.originLocator.pairThreadId,
          });

          let boundarySeq = grant.targetSeq;
          let includeBoundary = true;
          if (input.before) {
            const cursors = await tx.$queryRaw<Array<{ seq: number }>>(Prisma.sql`
              WITH authorized AS (${visible})
              SELECT seq FROM authorized WHERE id = ${input.before} LIMIT 1
            `);
            const cursor = cursors[0];
            if (!cursor) throw new IsolationError();
            boundarySeq = cursor.seq;
            includeBoundary = false;
          }

          const countRows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
            WITH authorized AS (${visible})
            SELECT COUNT(*)::int AS count FROM authorized
          `);
          const rows = await tx.$queryRaw<AuthorizedMessageRow[]>(Prisma.sql`
            WITH authorized AS (${visible})
            SELECT current.id,
                   current.seq,
                   current.role,
                   current.blocks,
                   current."botId",
                   CASE WHEN reply.id IS NULL THEN NULL ELSE current."replyToMessageId" END
                     AS "replyToMessageId",
                   CASE WHEN reply.id IS NULL THEN NULL ELSE current."replyQuote" END
                     AS "replyQuote",
                   current."runId",
                   current."clientNonce",
                   current."createdAt"
            FROM authorized current
            LEFT JOIN authorized reply ON reply.id = current."replyToMessageId"
            WHERE current.seq ${includeBoundary ? Prisma.sql`<=` : Prisma.sql`<`} ${boundarySeq}
            ORDER BY current.seq DESC
            LIMIT ${input.limit + 1}
          `);
          const hasMore = rows.length > input.limit;
          const pageRows = rows.slice(0, input.limit).reverse();
          return {
            pairThreadId: input.originLocator.pairThreadId,
            messages: pageRows.map(toPairThreadMessage),
            totalCount: countRows[0]?.count ?? 0,
            hasMore,
            olderCursor: hasMore ? (pageRows[0]?.id ?? null) : null,
            target: input.before
              ? null
              : {
                  messageId: input.originLocator.messageId,
                  visibleIndex: grant.visibleIndex,
                },
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    },
  };
}
