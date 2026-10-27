import {
  type ActionApprovalView,
  type AttentionItem,
  type AttentionQueueItem,
  type AttentionQueuePage,
  decodeAttentionCursor,
  deriveSessionControlViews,
  encodeAttentionCursor,
  type GroupMembershipApprovalFacts,
  type InteractionView,
  interactionViewFromIntervention,
  type MessageBlock,
  projectAttentionItems,
  projectGroupMembershipApproval,
  type SessionControlComputerFact,
  type SessionControlRunFact,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import {
  type CardMessageFact,
  cardMessageFact,
  interactionViewsFromMessages,
  loadBotComputerFacts,
} from "./card-interactions.js";
import type { Prisma, PrismaClient } from "./client.js";
import { interventionView } from "./interventions.js";

export type AttentionQueryInput = {
  spaceId: string;
  userId: string;
  cursor?: string | null;
  limit?: number;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Safety bound on the per-source fact reads; pending work is small by nature. */
const SOURCE_LIMIT = 500;

/**
 * CARD-01D bounded attention read. It never scans Run history or imports the
 * thread's message window: the three sources are the durable pending
 * Interventions, current SessionControls derived from active Runs, and the
 * strictly mapped pending business approvals (message-bag approvals plus the
 * RT-12 membership requests). Everything is scoped to Threads this user owns.
 */
export async function loadAttentionPage(
  prisma: PrismaClient,
  input: AttentionQueryInput,
): Promise<AttentionQueuePage> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  return prisma.$transaction(
    async (tx) => {
      const threads = await tx.thread.findMany({
        where: { spaceId: input.spaceId, userId: input.userId },
        select: { id: true, botId: true, groupId: true },
      });
      if (threads.length === 0) return { items: [], total: 0, nextCursor: null };
      const threadById = new Map(threads.map((thread) => [thread.id, thread]));
      const threadIds = threads.map((thread) => thread.id);

      const views = await loadPendingViews(tx, {
        spaceId: input.spaceId,
        userId: input.userId,
        threadIds,
        threadById,
      });
      const items = projectAttentionItems(views);
      const total = items.length;
      const page = pageItems(items, input.cursor ?? null, limit);
      const display = await loadDisplayFacts(tx, {
        spaceId: input.spaceId,
        threads: threadById,
        items: page,
      });
      return {
        items: page.map((item) => display.get(item.interactionId) ?? fallbackDisplay(item)),
        total,
        nextCursor: page.length === limit ? encodeAttentionCursor(page[page.length - 1]!) : null,
      };
    },
    { timeout: 20_000, maxWait: 20_000 },
  );
}

async function loadPendingViews(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    userId: string;
    threadIds: string[];
    threadById: Map<string, { id: string; botId: string | null; groupId: string | null }>;
  },
): Promise<InteractionView[]> {
  const views: InteractionView[] = [];

  // 1. Durable pending Interventions (input, approval, plan review, membership).
  const pendingRows = await tx.intervention.findMany({
    where: { threadId: { in: input.threadIds }, status: "pending" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: SOURCE_LIMIT,
  });
  const effectIds = pendingRows
    .map((row) => row.effectId)
    .filter((id): id is string => Boolean(id));
  const effects =
    effectIds.length > 0
      ? await tx.externalEffect.findMany({
          where: { id: { in: effectIds } },
          select: { id: true, status: true },
        })
      : [];
  const effectStatus = new Map(effects.map((effect) => [effect.id, effect.status]));
  // RT-12 membership requests project through their strict business facts; the
  // generic Intervention projection intentionally yields nothing for them.
  const membershipRequests =
    pendingRows.length > 0
      ? await tx.groupMembershipRequest.findMany({
          where: {
            spaceId: input.spaceId,
            userId: input.userId,
            interventionId: { in: pendingRows.map((row) => row.id) },
          },
        })
      : [];
  const membershipByIntervention = new Map(
    membershipRequests
      .filter((row): row is typeof row & { interventionId: string } => Boolean(row.interventionId))
      .map((row) => [row.interventionId, row]),
  );
  const membershipGroups = await loadManagedMembershipGroupIds(
    tx,
    input.spaceId,
    input.userId,
    membershipRequests.map((row) => row.groupId),
  );
  for (const row of pendingRows) {
    const membership = membershipByIntervention.get(row.id);
    if (membership) {
      const presentation = membership.presentation as GroupMembershipApprovalFacts["presentation"];
      const projected = projectGroupMembershipApproval({
        interactionId: row.id,
        revision: row.revision,
        groupId: membership.groupId,
        botId: membership.botId,
        messageGroupRequestId: membership.id,
        requestRevision: membership.requestRevision,
        sourceSpaceId: membership.spaceId,
        sourceThreadId: membership.sourceThreadId,
        sourceMessageId: membership.cardMessageId ?? row.messageId,
        sourceRunId: membership.sourceRunId,
        sourceBotId: membership.botId,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
        status: "pending",
        presentation,
        canManageMembers: membershipGroups.has(membership.groupId),
      });
      if (projected) views.push(projected);
      continue;
    }
    const projected = interactionViewFromIntervention(
      interventionView(row, row.effectId ? effectStatus.get(row.effectId) : undefined),
    );
    if (projected) views.push(projected);
  }

  // 2. Current SessionControls from active Runs.
  const runs = await tx.run.findMany({
    where: {
      threadId: { in: input.threadIds },
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: SOURCE_LIMIT,
    select: {
      id: true,
      spaceId: true,
      threadId: true,
      botId: true,
      status: true,
      waitKind: true,
      createdAt: true,
      waitStartedAt: true,
      leaseOwner: true,
      leaseExpiresAt: true,
    },
  });
  if (runs.length > 0) {
    const computers = await loadBotComputerFacts(tx, {
      spaceId: input.spaceId,
      botIds: runs.map((run) => run.botId),
    });
    const runFacts: SessionControlRunFact[] = runs.map((run) => ({
      id: run.id,
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      status: run.status,
      waitKind: run.waitKind,
      createdAt: run.createdAt,
      waitStartedAt: run.waitStartedAt,
      executionLeaseActive: Boolean(
        (run.status === "leased" || run.status === "running") &&
          run.leaseOwner &&
          (!run.leaseExpiresAt || run.leaseExpiresAt.getTime() > Date.now()),
      ),
    }));
    const computerFacts: SessionControlComputerFact[] = computers;
    views.push(
      ...deriveSessionControlViews({ runs: runFacts, computers: computerFacts, now: new Date() }),
    );
  }

  // 3. Strictly mapped pending business approvals that live in message blocks.
  // The JSONB filter targets the block itself, never "the recent messages".
  const approvalMessages = await tx.message.findMany({
    where: {
      threadId: { in: input.threadIds },
      role: "bot",
      OR: [
        { blocks: { array_contains: [{ kind: "app_connect", status: "pending" }] } },
        { blocks: { array_contains: [{ kind: "mcp_approval" }] } },
        { blocks: { array_contains: [{ kind: "skill_draft", status: "draft" }] } },
      ],
    },
    orderBy: [{ seq: "desc" }],
    take: SOURCE_LIMIT,
    select: {
      id: true,
      threadId: true,
      botId: true,
      runId: true,
      createdAt: true,
      role: true,
      blocks: true,
    },
  });
  const messageFacts: CardMessageFact[] = approvalMessages.map((message) =>
    cardMessageFact(
      {
        id: message.id,
        threadId: message.threadId,
        botId: message.botId ?? undefined,
        runId: message.runId ?? undefined,
        createdAt: message.createdAt.toISOString(),
        role: message.role as "bot" | "user" | "system",
        blocks: message.blocks as MessageBlock[],
      },
      input.spaceId,
    ),
  );
  for (const view of interactionViewsFromMessages(messageFacts).interactions) {
    if (view.status !== "pending" || view.kind !== "action_approval") continue;
    const kind = (view as ActionApprovalView).approval.kind;
    if (
      kind !== "connect.app_authorization" &&
      kind !== "connect.mcp_assignment" &&
      kind !== "skill_save"
    ) {
      continue;
    }
    views.push(view);
  }

  return views;
}

async function loadManagedMembershipGroupIds(
  tx: Prisma.TransactionClient,
  spaceId: string,
  userId: string,
  groupIds: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(groupIds)];
  if (unique.length === 0) return new Set();
  const groups = await tx.chatGroup.findMany({
    where: { id: { in: unique }, spaceId, userId, kind: "standard", archivedAt: null },
    select: { id: true },
  });
  return new Set(groups.map((group) => group.id));
}

function pageItems(items: AttentionItem[], cursor: string | null, limit: number): AttentionItem[] {
  if (!cursor) return items.slice(0, limit);
  const decoded = decodeAttentionCursor(cursor);
  if (!decoded) return items.slice(0, limit);
  // Keyed by the frozen comparator: skip through the cursor row itself.
  const index = items.findIndex(
    (item) =>
      item.stableId === decoded.stableId &&
      item.attentionAt === decoded.attentionAt &&
      item.expiresAt === decoded.expiresAt,
  );
  return items.slice(index < 0 ? 0 : index + 1, index < 0 ? limit : index + 1 + limit);
}

async function loadDisplayFacts(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threads: Map<string, { id: string; botId: string | null; groupId: string | null }>;
    items: AttentionItem[];
  },
): Promise<Map<string, AttentionQueueItem>> {
  const botIds = new Set<string>();
  const groupIds = new Set<string>();
  const runIds = new Set<string>();
  for (const item of input.items) {
    if (item.source.botId) botIds.add(item.source.botId);
    if (item.source.runId) runIds.add(item.source.runId);
    const thread = input.threads.get(item.source.threadId);
    if (thread?.botId) botIds.add(thread.botId);
    if (thread?.groupId) groupIds.add(thread.groupId);
  }
  const [bots, groups, runs] = await Promise.all([
    botIds.size > 0
      ? tx.bot.findMany({
          where: { id: { in: [...botIds] }, spaceId: input.spaceId },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    groupIds.size > 0
      ? tx.chatGroup.findMany({
          where: { id: { in: [...groupIds] }, spaceId: input.spaceId },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    runIds.size > 0
      ? tx.run.findMany({
          where: { id: { in: [...runIds] }, spaceId: input.spaceId },
          select: { id: true, task: { select: { prompt: true } } },
        })
      : Promise.resolve([]),
  ]);
  const botNames = new Map(bots.map((bot) => [bot.id, bot.name]));
  const groupNames = new Map(groups.map((group) => [group.id, group.name]));
  const taskTitles = new Map(runs.map((run) => [run.id, safeTaskTitle(run.task?.prompt ?? null)]));
  const display = new Map<string, AttentionQueueItem>();
  for (const item of input.items) {
    const thread = input.threads.get(item.source.threadId);
    const direct = thread?.botId ?? null;
    const groupId = thread?.groupId ?? null;
    const conversationKind = direct ? ("direct" as const) : ("group" as const);
    const conversationId = direct ?? groupId;
    if (!conversationId) continue;
    display.set(item.interactionId, {
      ...item,
      botName: item.source.botId ? (botNames.get(item.source.botId) ?? null) : null,
      conversationKind,
      conversationId,
      conversationName:
        (direct ? botNames.get(direct) : groupNames.get(groupId ?? "")) ??
        (direct ? "Direct chat" : "Group"),
      taskTitle: item.source.runId ? (taskTitles.get(item.source.runId) ?? null) : null,
    });
  }
  return display;
}

function fallbackDisplay(item: AttentionItem): AttentionQueueItem {
  const direct = item.source.threadId;
  return {
    ...item,
    botName: null,
    conversationKind: "direct",
    conversationId: direct,
    conversationName: "Direct chat",
    taskTitle: null,
  };
}

function safeTaskTitle(prompt: string | null): string | null {
  const first = prompt?.split(/[\r\n]+/)[0]?.trim() ?? "";
  if (!first) return null;
  return first.slice(0, 200);
}
