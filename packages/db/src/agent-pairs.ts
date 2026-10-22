import { createHash } from "node:crypto";
import {
  assertRoundtableFeatureEnabled,
  type BotId,
  type GroupId,
  type RoundtableFeatureGates,
  type SpaceId,
  type ThreadId,
  type UserId,
} from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";
import { lockSpaceForContentCreation } from "./spaces.js";
import { withTransactionRetry } from "./transaction-retry.js";

export const CHAT_GROUP_KIND_STANDARD = "standard";
export const CHAT_GROUP_KIND_AGENT_PAIR = "agent_pair";

export type ChatGroupKind = typeof CHAT_GROUP_KIND_STANDARD | typeof CHAT_GROUP_KIND_AGENT_PAIR;

/**
 * Hidden from every user-facing surface, so the name deliberately carries no
 * Bot identity: pair headers are rendered from the member Bots at read time and
 * a rename must not be able to change what a pair is.
 */
export const AGENT_PAIR_GROUP_NAME = "Agent pair";

/** Bot ids in canonical order; both members of a pair resolve to one identity. */
export type AgentPair = Readonly<{
  groupId: GroupId;
  threadId: ThreadId;
  botAId: BotId;
  botBId: BotId;
}>;

export type AgentPairRequest = Readonly<{
  spaceId: SpaceId;
  userId: UserId;
  botAId: BotId;
  botBId: BotId;
}>;

export interface AgentPairRepository {
  getOrCreate(input: AgentPairRequest): Promise<AgentPair>;
}

/**
 * Canonical unordered pair key: the two Bot ids in code-unit order, then hashed
 * to a fixed width. Ordering is what makes A→B and B→A collide on purpose;
 * hashing keeps the raw ids out of the index. Never exposed to UI or tool
 * contracts.
 */
export function agentPairKey(botAId: string, botBId: string): string {
  const first = botAId <= botBId ? botAId : botBId;
  const second = botAId <= botBId ? botBId : botAId;
  // Length prefixes, not a separator: a separator alone is not injective when an
  // id may contain it, and two distinct pairs sharing a key would share a Thread.
  return createHash("sha256")
    .update(`${first.length}:${first}${second.length}:${second}`)
    .digest("hex");
}

function canonicalOrder(botAId: BotId, botBId: BotId): [BotId, BotId] {
  return botAId <= botBId ? [botAId, botBId] : [botBId, botAId];
}

/** Unique-violation shape differs between the query engine and driver adapters. */
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  if (candidate.code === "P2002") return true;
  return candidate.meta?.driverAdapterError?.cause?.originalCode === "23505";
}

type PairRow = { id: string; thread: { id: string } | null };

const pairSelect = { id: true, thread: { select: { id: true } } } as const;

function pairWhere(spaceId: string, pairKey: string) {
  return { spaceId, pairKey, kind: CHAT_GROUP_KIND_AGENT_PAIR } as const;
}

function toAgentPair(row: PairRow, botAId: BotId, botBId: BotId): AgentPair {
  if (!row.thread) throw new IsolationError("Agent pair group is missing its thread");
  return {
    groupId: row.id as GroupId,
    threadId: row.thread.id as ThreadId,
    botAId,
    botBId,
  };
}

export function createAgentPairRepository(
  prisma: PrismaClient,
  gates: RoundtableFeatureGates,
): AgentPairRepository {
  return {
    async getOrCreate(input: AgentPairRequest): Promise<AgentPair> {
      assertRoundtableFeatureEnabled(gates, "private_pair");
      const [botAId, botBId] = canonicalOrder(input.botAId, input.botBId);
      if (botAId === botBId) {
        throw new IsolationError("An Agent pair requires two distinct Bots");
      }
      const { spaceId, userId } = input;
      const pairKey = agentPairKey(botAId, botBId);

      const bots = await prisma.bot.findMany({
        where: { id: { in: [botAId, botBId] }, spaceId, userId, archivedAt: null },
        select: { id: true },
      });
      if (bots.length !== 2) throw new IsolationError();

      const existing = await prisma.chatGroup.findFirst({
        where: pairWhere(spaceId, pairKey),
        select: pairSelect,
      });
      if (existing) return toAgentPair(existing, botAId, botBId);

      return withTransactionRetry(async () => {
        try {
          return await prisma.$transaction(async (tx) => {
            await lockSpaceForContentCreation(tx, { spaceId, userId });
            // The Space lock serialises same-Space creators, so the loser of a
            // concurrent first contact normally finds the winner's row here
            // instead of colliding on the unique index below.
            const locked = await tx.chatGroup.findFirst({
              where: pairWhere(spaceId, pairKey),
              select: pairSelect,
            });
            if (locked) return toAgentPair(locked, botAId, botBId);

            const group = await tx.chatGroup.create({
              data: {
                spaceId,
                userId,
                name: AGENT_PAIR_GROUP_NAME,
                kind: CHAT_GROUP_KIND_AGENT_PAIR,
                pairKey,
                leadBotId: botAId,
              },
              select: { id: true },
            });
            await tx.chatGroupMember.createMany({
              data: [botAId, botBId].map((memberBotId) => ({
                groupId: group.id,
                botId: memberBotId,
              })),
            });
            const thread = await tx.thread.create({
              data: { spaceId, groupId: group.id, userId },
              select: { id: true },
            });
            return {
              groupId: group.id as GroupId,
              threadId: thread.id as ThreadId,
              botAId,
              botBId,
            };
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // The unordered pair index is the actual identity guarantee: it still
          // holds for any creator that does not take the Space lock.
          const winner = await prisma.chatGroup.findFirst({
            where: pairWhere(spaceId, pairKey),
            select: pairSelect,
          });
          if (!winner) throw error;
          return toAgentPair(winner, botAId, botBId);
        }
      });
    },
  };
}
