import {
  type ActionApprovalView,
  type AttentionItem,
  type AttentionQueueItem,
  type AttentionQueuePage,
  compareAttentionItems,
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
  loadOriginControlFacts,
  ORIGIN_CONTROL_MAX_DEPTH,
} from "./card-interactions.js";
import { Prisma, type PrismaClient } from "./client.js";
import { interventionView } from "./interventions.js";

export type AttentionQueryInput = {
  spaceId: string;
  userId: string;
  cursor?: string | null;
  limit?: number;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

type AttentionCursor = { expiresAt: string | null; attentionAt: string; stableId: string };

type DurableProjectionRow = {
  interactionId: string;
  expiresAt: Date | null;
  attentionAt: Date;
};

/**
 * CARD-01E attention read.
 *
 * Durable pending Interventions are read from the compact
 * `attention_interventions` projection maintained by the interventions trigger.
 * The page is a keyset slice of that table and `total` is an exact indexed
 * count, so candidates the page will not show are never materialized as
 * Intervention rows, presentation JSON, or ExternalEffect facts. Expired rows
 * leave the queue at read time; the timeout job still owns their settlement.
 *
 * The three remaining sources are bounded by current facts instead of history:
 * active Runs on the user's visible Threads (takeover/return), the bounded
 * origin chain of active delegated Runs, and message blocks matched through the
 * `messages_blocks_gin` index. Plain Runs, Run history, receipts, task_status
 * and PD-01 Retry are not InteractionViews and never enter this query.
 */
export async function loadAttentionPage(
  prisma: PrismaClient,
  input: AttentionQueryInput,
): Promise<AttentionQueuePage> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const decoded = input.cursor ? decodeAttentionCursor(input.cursor) : null;
  // A cursor is opaque but not trusted: an unparseable timestamp would reach
  // the SQL parameter binder. Fall back to the first page instead of failing.
  const cursor =
    decoded &&
    Number.isFinite(Date.parse(decoded.attentionAt)) &&
    (decoded.expiresAt === null || Number.isFinite(Date.parse(decoded.expiresAt)))
      ? decoded
      : null;
  return prisma.$transaction(
    async (tx) => {
      const now = new Date();
      // Human-visible conversations only: a direct chat or a standard group.
      // Hidden agent_pair threads share the same userId and must never be
      // addressed directly; their delegated controls are rebased below.
      // Archived conversations are not navigable, so their requests stay out
      // of the queue instead of pointing at a source the user cannot open.
      const threads = await tx.thread.findMany({
        where: {
          spaceId: input.spaceId,
          userId: input.userId,
          OR: [{ bot: { archivedAt: null } }, { group: { kind: "standard", archivedAt: null } }],
        },
        select: { id: true, botId: true, groupId: true },
      });
      if (threads.length === 0) return { items: [], total: 0, nextCursor: null };
      const threadById = new Map(threads.map((thread) => [thread.id, thread]));

      const durable = await loadDurableAttention(tx, {
        spaceId: input.spaceId,
        userId: input.userId,
        cursor,
        limit,
        now,
      });
      const live = await loadLiveAttention(tx, {
        spaceId: input.spaceId,
        userId: input.userId,
        threadIds: threads.map((thread) => thread.id),
        threadById,
        now,
      });

      const cursorItem = cursor
        ? ({
            expiresAt: cursor.expiresAt,
            attentionAt: cursor.attentionAt,
            stableId: cursor.stableId,
          } as AttentionItem)
        : null;
      const allLiveItems = projectAttentionItems(live.views);
      const liveItems = allLiveItems.filter(
        (item) => !cursorItem || compareAttentionItems(item, cursorItem) > 0,
      );
      const seen = new Set<string>();
      const merged: AttentionItem[] = [];
      for (const item of [...durable.items, ...liveItems].sort(compareAttentionItems)) {
        const key = `${item.interactionId}\u0000${item.revision}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
      const page = merged.slice(0, limit);
      const display = await loadDisplayFacts(tx, {
        spaceId: input.spaceId,
        threads: threadById,
        items: page,
      });
      return {
        items: page.map((item) => display.get(item.interactionId) ?? fallbackDisplay(item)),
        total: durable.total + allLiveItems.length,
        nextCursor: merged.length > limit ? encodeAttentionCursor(page[page.length - 1]!) : null,
      };
    },
    {
      timeout: 20_000,
      maxWait: 20_000,
      // The exact count and the keyset page must answer from one snapshot:
      // under READ COMMITTED a settle between the two statements could make
      // `total` disagree with the list the client is about to page through.
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  );
}

/**
 * Exact count and keyset page over the persisted pending-Intervention
 * projection. The projection carries only the frozen sort tuple; the page then
 * loads those Intervention rows, their effect statuses, and the RT-12 facts for
 * the rows it will actually render.
 *
 * `total` uses the same eligibility rule as the page query. The SQL predicate
 * covers the structural cases (pending kind, choice actions, approval source,
 * current thread/bot/group, expiry, membership permission); the two complex
 * projections (plan reviews and RT-12 membership approvals) carry nested
 * payloads that only the strict TypeScript projector can validate, so those
 * rows are validated in batches and subtracted from the SQL count. A
 * historical row that cannot render therefore disappears from both the page and
 * the badge instead of inflating the count.
 */
async function loadDurableAttention(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    userId: string;
    cursor: AttentionCursor | null;
    limit: number;
    now: Date;
  },
): Promise<{ items: AttentionItem[]; total: number }> {
  const countRows = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count
    ${durableFrom(input)}
    WHERE ${durableFilters({ ...input, cursor: null })}
  `);
  const eligibleCount = Number(countRows[0]?.count ?? 0);
  const unrenderable = eligibleCount > 0 ? await countUnrenderableComplex(tx, input) : 0;
  const total = Math.max(eligibleCount - unrenderable, 0);
  if (total === 0) return { items: [], total: 0 };

  const wanted = input.limit + 1;
  const items: AttentionItem[] = [];
  let after = input.cursor;
  while (items.length < wanted) {
    const remaining = wanted - items.length;
    const rows = await tx.$queryRaw<DurableProjectionRow[]>(Prisma.sql`
      SELECT ai."interactionId", ai."expiresAt", ai."attentionAt"
      ${durableFrom(input)}
      WHERE ${durableFilters({ ...input, cursor: after })}
      ORDER BY ai."expiresAt" ASC NULLS LAST, ai."attentionAt" ASC, ai."interactionId" ASC
      LIMIT ${remaining}
    `);
    if (rows.length === 0) break;
    items.push(...(await projectDurableRows(tx, rows, input.spaceId)));
    const last = rows[rows.length - 1]!;
    after = {
      expiresAt: last.expiresAt ? last.expiresAt.toISOString() : null,
      attentionAt: last.attentionAt.toISOString(),
      stableId: last.interactionId,
    };
    if (rows.length < remaining) break;
  }
  return { items: items.slice(0, wanted), total };
}

function durableFrom(input: { spaceId: string; userId: string }): Prisma.Sql {
  return Prisma.sql`
    FROM "attention_interventions" AS ai
    JOIN "threads" AS thread
      ON thread."id" = ai."threadId"
     AND thread."userId" = ${input.userId}
     AND thread."spaceId" = ${input.spaceId}
    LEFT JOIN "bots" AS thread_bot ON thread_bot."id" = thread."botId"
    LEFT JOIN "chat_groups" AS thread_group ON thread_group."id" = thread."groupId"
    JOIN "bots" AS source_bot
      ON source_bot."id" = ai."botId"
     AND source_bot."spaceId" = ai."spaceId"
    JOIN "interventions" AS intervention ON intervention."id" = ai."interactionId"
    LEFT JOIN "external_effects" AS effect ON effect."id" = intervention."effectId"
  `;
}

/**
 * Plan reviews and membership approvals are the only pending rows whose strict
 * projection depends on nested JSON. Validate every such row in the user's
 * eligible set (not just the page) so `total` cannot include a card the page
 * will drop. Other kinds are fully decided by the SQL eligibility predicate.
 */
async function countUnrenderableComplex(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    userId: string;
    now: Date;
  },
): Promise<number> {
  const rows = await tx.$queryRaw<DurableProjectionRow[]>(Prisma.sql`
    SELECT ai."interactionId", ai."expiresAt", ai."attentionAt"
    ${durableFrom(input)}
    WHERE ${durableFilters({ ...input, cursor: null })}
      AND (
        intervention."kind" = 'plan_review'
        OR (intervention."kind" = 'approval' AND intervention."effectId" IS NULL)
      )
  `);
  let unrenderable = 0;
  const batchSize = 200;
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    const items = await projectDurableRows(tx, batch, input.spaceId);
    unrenderable += batch.length - items.length;
  }
  return unrenderable;
}

function durableFilters(input: {
  spaceId: string;
  userId: string;
  cursor: AttentionCursor | null;
  now: Date;
}): Prisma.Sql {
  const visibleThread = Prisma.sql`(
    (thread."botId" IS NOT NULL AND thread_bot."archivedAt" IS NULL)
    OR (
      thread."groupId" IS NOT NULL
      AND thread_group."kind" = 'standard'
      AND thread_group."archivedAt" IS NULL
    )
  )`;
  const pastExpiry = Prisma.sql`(ai."expiresAt" IS NULL OR ai."expiresAt" > ${input.now})`;
  const manageableMembership = Prisma.sql`NOT (
    intervention."kind" = 'approval'
    AND EXISTS (
      SELECT 1 FROM "group_membership_requests" AS request
      WHERE request."interventionId" = intervention."id"
        AND NOT EXISTS (
          SELECT 1 FROM "chat_groups" AS target
          WHERE target."id" = request."groupId"
            AND target."spaceId" = ${input.spaceId}
            AND target."userId" = ${input.userId}
            AND target."kind" = 'standard'
            AND target."archivedAt" IS NULL
        )
    )
  )`;
  // The one eligibility rule shared by count, complex validation and paging.
  // Anything the strict projector can reject without reading nested JSON is
  // excluded here; plan reviews and membership payloads are validated in
  // countUnrenderableComplex.
  const eligible = Prisma.sql`(
    intervention."status" = 'pending'
    AND intervention."kind" IN ('input', 'approval', 'plan_review')
    AND length(intervention."id") > 0
    AND length(intervention."spaceId") > 0
    AND length(intervention."threadId") > 0
    AND length(intervention."runId") > 0
    AND length(intervention."messageId") > 0
    AND length(intervention."botId") > 0
    AND length(ai."interactionId") > 0
    AND length(ai."threadId") > 0
    AND length(ai."botId") > 0
    AND intervention."revision" > 0
    AND (
      intervention."kind" = 'plan_review'
      OR (
        intervention."kind" = 'input'
        AND (
          intervention."inputMode" IS DISTINCT FROM 'choice'
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(intervention."inputActions") = 'array'
                  THEN intervention."inputActions"
                ELSE '[]'::jsonb
              END
            ) AS action
            WHERE jsonb_typeof(action) = 'object'
              AND jsonb_typeof(action -> 'id') = 'string'
              AND length(action ->> 'id') > 0
          )
        )
      )
      OR (
        intervention."kind" = 'approval'
        AND (
          (
            intervention."effectId" IS NOT NULL
            AND (effect."id" IS NULL OR effect."status" <> '')
          )
          OR EXISTS (
            SELECT 1 FROM "group_membership_requests" AS request
            WHERE request."interventionId" = intervention."id"
          )
        )
      )
    )
  )`;
  if (!input.cursor) {
    return Prisma.sql`${visibleThread} AND source_bot."archivedAt" IS NULL AND ${pastExpiry} AND ${eligible} AND ${manageableMembership}`;
  }
  const afterCursor =
    input.cursor.expiresAt === null
      ? Prisma.sql`ai."expiresAt" IS NULL AND (
          ai."attentionAt" > ${new Date(input.cursor.attentionAt)}
          OR (
            ai."attentionAt" = ${new Date(input.cursor.attentionAt)}
            AND ai."interactionId" > ${input.cursor.stableId}
          )
        )`
      : Prisma.sql`(
          ai."expiresAt" > ${new Date(input.cursor.expiresAt)}
          OR (
            ai."expiresAt" = ${new Date(input.cursor.expiresAt)}
            AND (
              ai."attentionAt" > ${new Date(input.cursor.attentionAt)}
              OR (
                ai."attentionAt" = ${new Date(input.cursor.attentionAt)}
                AND ai."interactionId" > ${input.cursor.stableId}
              )
            )
          )
          OR ai."expiresAt" IS NULL
        )`;
  return Prisma.sql`${visibleThread} AND source_bot."archivedAt" IS NULL AND ${pastExpiry} AND ${eligible} AND ${manageableMembership} AND ${afterCursor}`;
}

async function projectDurableRows(
  tx: Prisma.TransactionClient,
  rows: readonly DurableProjectionRow[],
  spaceId: string,
): Promise<AttentionItem[]> {
  const ids = rows.map((row) => row.interactionId);
  const interventions = await tx.intervention.findMany({ where: { id: { in: ids } } });
  const interventionById = new Map(interventions.map((row) => [row.id, row]));
  const effectIds = interventions
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
  const membershipRequests = await tx.groupMembershipRequest.findMany({
    where: { spaceId, interventionId: { in: ids } },
  });
  const membershipByIntervention = new Map(
    membershipRequests
      .filter((row): row is typeof row & { interventionId: string } => Boolean(row.interventionId))
      .map((row) => [row.interventionId, row]),
  );
  const membershipGroups = await loadManagedMembershipGroupIds(
    tx,
    membershipRequests.map((row) => row.groupId),
  );

  const items: AttentionItem[] = [];
  for (const projectionRow of rows) {
    const row = interventionById.get(projectionRow.interactionId);
    if (!row || row.status !== "pending") continue;
    const membership = membershipByIntervention.get(row.id);
    const view = membership
      ? projectGroupMembershipApproval({
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
          presentation: membership.presentation as GroupMembershipApprovalFacts["presentation"],
          canManageMembers: membershipGroups.has(membership.groupId),
        })
      : interactionViewFromIntervention(
          interventionView(row, row.effectId ? effectStatus.get(row.effectId) : undefined),
        );
    if (!view) continue;
    const item = projectAttentionItems([view])[0];
    if (item) items.push(item);
  }
  return items;
}

async function loadManagedMembershipGroupIds(
  tx: Prisma.TransactionClient,
  groupIds: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(groupIds)];
  if (unique.length === 0) return new Set();
  const groups = await tx.chatGroup.findMany({
    where: { id: { in: unique }, kind: "standard", archivedAt: null },
    select: { id: true },
  });
  return new Set(groups.map((group) => group.id));
}

async function loadLiveAttention(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    userId: string;
    threadIds: string[];
    threadById: Map<string, { id: string; botId: string | null; groupId: string | null }>;
    now: Date;
  },
): Promise<{ views: InteractionView[] }> {
  const views: InteractionView[] = [];

  // 1. Current SessionControls from active Runs.
  const runs = await tx.run.findMany({
    where: {
      threadId: { in: input.threadIds },
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
    const activeBots = await loadActiveBotIds(
      tx,
      input.spaceId,
      runs.map((run) => run.botId),
    );
    const activeRuns = runs.filter((run) => activeBots.has(run.botId));
    if (activeRuns.length > 0) {
      const computers = await loadBotComputerFacts(tx, {
        spaceId: input.spaceId,
        botIds: activeRuns.map((run) => run.botId),
      });
      const runFacts: SessionControlRunFact[] = activeRuns.map((run) => ({
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
        ...deriveSessionControlViews({ runs: runFacts, computers: computerFacts, now: input.now }),
      );
    }
  }

  // 2. Delegated Runs execute in hidden pair Threads; project their live
  // controls into the visible origin Thread the user can actually open.
  const visibleThreadIds = new Set(input.threadIds);
  const activeDelegated = await tx.run.findMany({
    where: {
      spaceId: input.spaceId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
      originThreadId: { not: null },
      originRunId: { not: null },
      originMessageId: { not: null },
      trigger: { not: "message_group" },
    },
    select: { originThreadId: true },
  });
  const candidateOrigins = new Set<string>();
  let hiddenFrontier = new Set<string>();
  for (const run of activeDelegated) {
    const originThreadId = run.originThreadId;
    if (!originThreadId) continue;
    if (visibleThreadIds.has(originThreadId)) candidateOrigins.add(originThreadId);
    else hiddenFrontier.add(originThreadId);
  }
  for (let depth = 0; depth < ORIGIN_CONTROL_MAX_DEPTH && hiddenFrontier.size > 0; depth += 1) {
    const parents = await tx.run.findMany({
      where: {
        spaceId: input.spaceId,
        threadId: { in: [...hiddenFrontier] },
        originThreadId: { not: null },
        trigger: { not: "message_group" },
      },
      select: { originThreadId: true },
      distinct: ["originThreadId"],
    });
    const nextFrontier = new Set<string>();
    for (const parent of parents) {
      const originThreadId = parent.originThreadId;
      if (!originThreadId) continue;
      if (visibleThreadIds.has(originThreadId)) candidateOrigins.add(originThreadId);
      else nextFrontier.add(originThreadId);
    }
    hiddenFrontier = nextFrontier;
  }
  for (const originThreadId of candidateOrigins) {
    const originControls = await loadOriginControlFacts(tx, {
      spaceId: input.spaceId,
      threadId: originThreadId,
    });
    if (originControls.runs.length === 0) continue;
    views.push(
      ...deriveSessionControlViews({
        runs: originControls.runs,
        computers: originControls.computers,
        now: input.now,
      }),
    );
  }

  // 3. Strictly mapped pending business approvals that live in message blocks.
  // The JSONB filter only decides which messages are worth reading; whether a
  // block is pending is answered per block by the projection below, so one
  // settled card can never hide its pending sibling in the same message.
  const approvalMessages = await tx.message.findMany({
    where: {
      threadId: { in: input.threadIds },
      role: "bot",
      OR: [
        { blocks: { array_contains: [{ kind: "app_connect", status: "pending" }] } },
        { blocks: { array_contains: [{ kind: "mcp_approval", status: "pending" }] } },
        {
          // A pre-upgrade MCP block can omit the schema-defaulted status, which
          // the projection treats as open. Those cannot be matched positively,
          // so admit messages whose MCP blocks are all unsettled and keep the
          // settled ones out of the source limit.
          AND: [
            { blocks: { array_contains: [{ kind: "mcp_approval" }] } },
            {
              NOT: { blocks: { array_contains: [{ kind: "mcp_approval", status: "connected" }] } },
            },
            {
              NOT: { blocks: { array_contains: [{ kind: "mcp_approval", status: "dismissed" }] } },
            },
          ],
        },
        { blocks: { array_contains: [{ kind: "skill_draft", status: "draft" }] } },
      ],
    },
    orderBy: [{ seq: "desc" }],
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
  if (approvalMessages.length > 0) {
    const activeBots = await loadActiveBotIds(
      tx,
      input.spaceId,
      approvalMessages.map((message) => message.botId),
    );
    const messageFacts: CardMessageFact[] = approvalMessages
      .filter((message) => !message.botId || activeBots.has(message.botId))
      .map((message) =>
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
  }

  return { views };
}

async function loadActiveBotIds(
  tx: Prisma.TransactionClient,
  spaceId: string,
  botIds: readonly (string | null | undefined)[],
): Promise<Set<string>> {
  const unique = [...new Set(botIds.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Set();
  const bots = await tx.bot.findMany({
    where: { id: { in: unique }, spaceId, archivedAt: null },
    select: { id: true },
  });
  return new Set(bots.map((bot) => bot.id));
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
