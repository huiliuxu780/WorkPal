import {
  GROUP_MEMBER_MIN,
  type RunStatus,
  TASK_CENTER_DEFAULT_LIMIT,
  TASK_CENTER_MAX_LIMIT,
  TASK_CENTER_TERMINAL_WINDOW,
  type TaskCenterItem,
  type TaskCenterPage,
  type TaskCenterTarget,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  compareTaskCenterRuns,
  decodeTaskCenterCursor,
  encodeTaskCenterCursor,
  taskCenterAfterPosition,
  taskCenterPriority,
} from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { buildExecutionSummariesForRuns, type SummaryRunRow } from "./execution-history.js";

/**
 * Task Center read model: the cross-conversation index of the actor's
 * authorized ROOT Runs. Read-only composition over the durable facts — no
 * second Task/Run state, no snapshot document, and every item carries the
 * existing HISTORY-001 `ExecutionSummary` built by the shared batched
 * projection (one grouped pass per fact source, no per-Run fan-out).
 *
 * Window: every active/waiting root Run plus the `TASK_CENTER_TERMINAL_WINDOW`
 * terminal root Runs with the newest STABLE summary time (newest product
 * event, `createdAt` fallback — never the invisible-write-driven
 * `runs.updatedAt`) of the CURRENT generation (the HISTORY-001
 * lifecycle-event fence — a cleared Run never re-enters, and later
 * `thread.artifact` maintenance cannot revive it because the fence excludes
 * those rows). Ordering and the cursor position use that same stable time, so
 * lease heartbeats and mirror timestamps can neither reorder the list nor make
 * pagination skip Runs.
 *
 * Root-Run authority is the stored orchestration lineage
 * (`orchestration.collaboration.parentRunId`), never the card title, the
 * trigger text, or the presence of background subtasks. `BackgroundAgentTask`
 * projections are not Run rows and can never enter the list.
 */

type TxLike = Prisma.TransactionClient | PrismaClient;

const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;

/** Thrown for a malformed, version-mismatched or foreign-actor cursor. */
export class TaskCenterCursorError extends Error {
  readonly reason = "invalid_cursor";

  constructor() {
    super("task_center_cursor");
    this.name = "TaskCenterCursorError";
  }
}

type TaskCenterRunRow = SummaryRunRow & {
  /**
   * The stable summary time (newest product-event time, Run `createdAt` when
   * no event survives) — the same value `ExecutionSummary.updatedAt` reports.
   * Invisible row writes (lease renewal, `botOutcomeReturnedAt`, mirror
   * timestamps) never move it, so pagination can neither skip nor reorder
   * Runs behind a client's back.
   */
  sortTime: Date;
  threadBotId: string | null;
  threadGroupId: string | null;
};

const RUN_COLUMNS = Prisma.sql`r.id, r."threadId", r."botId", r."taskId", r.status,
       r."waitKind", r.trigger, r.error, r.orchestration, r."sourceMessageId",
       r."startedAt", r."completedAt", r."createdAt", r."snapshotRev", r."retryOfRunId",
       COALESCE((SELECT MAX(e2."createdAt") FROM events e2 WHERE e2."runId" = r.id),
                r."createdAt") AS "sortTime",
       t."botId" AS "threadBotId", t."groupId" AS "threadGroupId"`;

/**
 * Authorization is one server-side predicate over the Thread's owning chat:
 * a bot Thread requires the actor's own unarchived bot of this Space; a group
 * Thread requires the actor's own unarchived group of this Space with its
 * minimum active member bots. Threads of archived or foreign chats — and
 * external-conversation Threads (neither bot nor group) — never match, so
 * unauthorized items never reach the browser to be hidden there.
 */
function authorizationPredicate(spaceId: string, userId: string) {
  return Prisma.sql`
    (
      (t."botId" IS NOT NULL AND EXISTS (
        SELECT 1 FROM bots b
        WHERE b.id = t."botId" AND b."spaceId" = ${spaceId}
          AND b."userId" = ${userId} AND b."archivedAt" IS NULL))
      OR (t."groupId" IS NOT NULL AND EXISTS (
        SELECT 1 FROM chat_groups g
        WHERE g.id = t."groupId" AND g."spaceId" = ${spaceId}
          AND g."userId" = ${userId} AND g."archivedAt" IS NULL
          AND (SELECT COUNT(*)::int FROM chat_group_members m
               JOIN bots mb ON mb.id = m."botId"
               WHERE m."groupId" = g.id AND mb."archivedAt" IS NULL) >= ${GROUP_MEMBER_MIN}))
    )`;
}

/** Root Runs only: the stored collaboration lineage is the authority. */
const ROOT_RUN_PREDICATE = Prisma.sql`
    NULLIF(r.orchestration->'collaboration'->>'parentRunId', '') IS NULL`;

function mapRow(row: Record<string, unknown>): TaskCenterRunRow {
  return {
    id: String(row.id),
    threadId: String(row.threadId),
    botId: String(row.botId),
    taskId: String(row.taskId),
    status: String(row.status),
    waitKind: (row.waitKind as string | null) ?? null,
    trigger: String(row.trigger),
    error: (row.error as string | null) ?? null,
    orchestration: row.orchestration ?? null,
    sourceMessageId: (row.sourceMessageId as string | null) ?? null,
    startedAt: (row.startedAt as Date | null) ?? null,
    completedAt: (row.completedAt as Date | null) ?? null,
    createdAt: row.createdAt as Date,
    snapshotRev: Number(row.snapshotRev ?? 0),
    retryOfRunId: (row.retryOfRunId as string | null) ?? null,
    sortTime: row.sortTime as Date,
    threadBotId: (row.threadBotId as string | null) ?? null,
    threadGroupId: (row.threadGroupId as string | null) ?? null,
  };
}

function targetOf(row: TaskCenterRunRow): TaskCenterTarget | null {
  if (row.threadBotId) return { kind: "bot", botId: row.threadBotId };
  if (row.threadGroupId) return { kind: "group", groupId: row.threadGroupId };
  return null;
}

export async function loadTaskCenterPage(
  db: TxLike,
  input: {
    spaceId: string;
    userId: string;
    cursor?: string;
    limit?: number;
  },
): Promise<TaskCenterPage> {
  const limit = Math.min(
    Math.max(input.limit ?? TASK_CENTER_DEFAULT_LIMIT, 1),
    TASK_CENTER_MAX_LIMIT,
  );
  let cursorPosition: { p: number; t: number; r: string } | null = null;
  if (input.cursor !== undefined) {
    const cursor = decodeTaskCenterCursor(input.cursor);
    // A cursor is bound to its issuing actor and Space: one from another
    // user, another Space or another layout version is rejected outright and
    // never reinterpreted against this actor's data.
    if (!cursor || cursor.sp !== input.spaceId || cursor.us !== input.userId)
      throw new TaskCenterCursorError();
    cursorPosition = { p: cursor.p, t: cursor.t, r: cursor.r };
  }

  const auth = authorizationPredicate(input.spaceId, input.userId);
  const [activeRows, terminalRows] = await Promise.all([
    db.$queryRaw<Array<Record<string, unknown>>>`
      SELECT ${RUN_COLUMNS}
      FROM runs r
      JOIN threads t ON t.id = r."threadId"
      WHERE r."spaceId" = ${input.spaceId}
        AND r.status IN (${Prisma.join([...ACTIVE_RUN_STATUSES])})
        AND ${ROOT_RUN_PREDICATE}
        AND ${auth}
    `,
    // The bounded terminal window: newest by the SAME stable summary time as
    // the ordering and the cursor, and only while a Run-lifecycle event
    // survives (the Thread Clear fence; `thread.artifact` maintenance rows do
    // not count and cannot revive).
    db.$queryRaw<Array<Record<string, unknown>>>`
      SELECT ${RUN_COLUMNS}
      FROM runs r
      JOIN threads t ON t.id = r."threadId"
      WHERE r."spaceId" = ${input.spaceId}
        AND r.status IN (${Prisma.join([...TERMINAL_RUN_STATUSES])})
        AND ${ROOT_RUN_PREDICATE}
        AND EXISTS (
          SELECT 1 FROM events e
          WHERE e."runId" = r.id AND e.type <> 'thread.artifact')
        AND ${auth}
      ORDER BY "sortTime" DESC, r.id DESC
      LIMIT ${TASK_CENTER_TERMINAL_WINDOW}
    `,
  ]);

  const rowsById = new Map<string, TaskCenterRunRow>();
  for (const raw of [...(activeRows ?? []), ...(terminalRows ?? [])]) {
    const row = mapRow(raw);
    rowsById.set(row.id, row);
  }
  const factsOf = (row: TaskCenterRunRow) => ({
    runId: row.id,
    status: row.status as RunStatus,
    sortTimeMs: row.sortTime.getTime(),
  });
  const ordered = [...rowsById.values()].sort((a, b) =>
    compareTaskCenterRuns(factsOf(a), factsOf(b)),
  );
  // activeCount shares the exact authorization, root-Run and window rules of
  // the list: it is the size of the same authorized active selection.
  const activeCount = ordered.filter((row) =>
    (ACTIVE_RUN_STATUSES as readonly string[]).includes(row.status),
  ).length;

  const after = cursorPosition
    ? ordered.filter((row) => taskCenterAfterPosition(factsOf(row), cursorPosition!))
    : ordered;
  const page = after.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    last && after.length > limit
      ? encodeTaskCenterCursor({
          v: 1,
          sp: input.spaceId,
          us: input.userId,
          p: taskCenterPriority(last.status as RunStatus),
          t: last.sortTime.getTime(),
          r: last.id,
        })
      : null;

  // Summaries only for the delivered page — the shared HISTORY-001 builder,
  // batched across the page's Threads.
  const summaries = await buildExecutionSummariesForRuns(db, {
    spaceId: input.spaceId,
    runs: page,
  });
  const summaryById = new Map(summaries.map((summary) => [summary.runId, summary]));
  const items: TaskCenterItem[] = [];
  for (const row of page) {
    const summary = summaryById.get(row.id);
    const target = targetOf(row);
    if (!summary || !target) continue;
    items.push({ summary, target });
  }
  return { items, nextCursor, activeCount };
}
