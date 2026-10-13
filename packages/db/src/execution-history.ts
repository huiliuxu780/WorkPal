import {
  ACTIVITY_PAGE_DEFAULT_LIMIT,
  ACTIVITY_PAGE_MAX_LIMIT,
  ACTIVITY_SCAN_LIMIT,
  type ActivityItem,
  EXECUTION_STEPS_LIMIT,
  EXECUTION_TIMELINE_LIMIT,
  EXECUTION_TODOS_LIMIT,
  type ExecutionActivityPage,
  type ExecutionSnapshot,
  type ExecutionSummary,
  MAX_SUMMARY_ARTIFACTS,
  RunPlanRevisionSchema,
  RunStepSnapshotSchema,
  RunTodoSnapshotSchema,
} from "@rakazo/contracts";
import {
  ACTIVITY_EVENT_TYPES,
  type ActivityProjectionContext,
  type ActivityRunContext,
  type ActivitySourceEvent,
  buildExecutionSummary,
  composeRunRev,
  decodeExecutionActivityCursor,
  type ExecutionSummaryFacts,
  encodeExecutionActivityCursor,
  pickExecutionResult,
  projectActivity,
} from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { currentThreadGeneration } from "./events.js";
import { loadInterventionViews } from "./interventions.js";

/**
 * ExecutionSnapshot read model (HISTORY-001). Pure composed reads over the
 * durable facts — Run/Task/Message/Event/Plan/Step/Todo/Intervention/Artifact/
 * BackgroundAgentTask. No snapshot document is stored and nothing here writes;
 * the only writes are the `thread.artifact` membership events that the
 * Artifact create/delete paths append, so an Artifact change moves a Run's rev.
 */

type TxLike = Prisma.TransactionClient | PrismaClient;

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ACTION_COUNT_EVENT_TYPE = "agent.tool.completed";
/** Guards a pathological Run with an enormous message count. */
const SUMMARY_MESSAGE_SCAN_LIMIT = 500;

/** Thrown for a cursor that belongs to another Run or a stale generation. */
export class ExecutionActivityCursorError extends Error {
  readonly reason: "invalid_cursor" | "stale_cursor";

  constructor(reason: ExecutionActivityCursorError["reason"]) {
    super(reason);
    this.name = "ExecutionActivityCursorError";
    this.reason = reason;
  }
}

/** Per-Run event facts behind the snapshot version and the generation fence. */
export type ExecutionEventFacts = {
  /**
   * Highest event seq over ALL surviving events — the event component of the
   * snapshot version (composed with `runs.snapshotRev` via `composeRunRev`).
   * Events are append-only within a generation (the only deletions are
   * `thread.progress` rows, and they are removed before a higher-seq terminal
   * event lands), so re-reads of the same commit return the same value and no
   * other Run's write moves this one.
   */
  ceiling: number;
  /**
   * Highest seq over surviving Run-lifecycle events — everything except the
   * thread-maintenance `thread.artifact` rows, which may be appended even
   * after a pre-clear Run becomes terminal. Other events can also be appended
   * to completed/failed Runs before Clear (for example background-task and
   * delivery events). The fence relies on a write-path invariant, not a
   * structural guarantee: after Clear, no lifecycle event may be appended
   * for a Run from the old generation. Background and delivery writers check
   * the generation; `assertRunCanWriteHistory` itself only blocks cancelled
   * Runs. New terminal-Run event paths must uphold the same Clear fence.
   * `null` means no lifecycle event survived, so the Run is from an older
   * generation.
   */
  lifecycleSeq: number | null;
  /** Newest event time; the Run's recorded-update fact for the contract. */
  lastEventAt: Date | null;
};

export async function executionEventCeilings(
  db: TxLike,
  runIds: readonly string[],
): Promise<Map<string, ExecutionEventFacts>> {
  const ceilings = new Map<string, ExecutionEventFacts>();
  if (runIds.length === 0) return ceilings;
  const rows = await db.$queryRaw<
    Array<{ runId: string; seq: number; lifecycleSeq: number | null; lastEventAt: Date | null }>
  >`
    SELECT "runId" AS "runId",
           COALESCE(MAX("seq"), 0)::int AS "seq",
           MAX("seq") FILTER (WHERE "type" <> 'thread.artifact')::int AS "lifecycleSeq",
           MAX("createdAt") AS "lastEventAt"
    FROM "events"
    WHERE "runId" IN (${Prisma.join(runIds)})
    GROUP BY "runId"
  `;
  for (const row of rows ?? []) {
    if (!row.runId) continue;
    ceilings.set(row.runId, {
      ceiling: Number(row.seq),
      lifecycleSeq: row.lifecycleSeq === null ? null : Number(row.lifecycleSeq),
      lastEventAt: row.lastEventAt ?? null,
    });
  }
  return ceilings;
}

/** MIN/MAX bot-message seq per Run in one indexed pass (anchors + result heads). */
async function messageEndsByRun(
  db: TxLike,
  threadId: string,
  runIds: readonly string[],
): Promise<Map<string, { firstSeq: number; lastSeq: number }>> {
  const ends = new Map<string, { firstSeq: number; lastSeq: number }>();
  if (runIds.length === 0) return ends;
  const rows = await db.$queryRaw<Array<{ runId: string; firstSeq: number; lastSeq: number }>>`
    SELECT "runId" AS "runId", MIN("seq")::int AS "firstSeq", MAX("seq")::int AS "lastSeq"
    FROM "messages"
    WHERE "threadId" = ${threadId} AND "role" = 'bot' AND "runId" IN (${Prisma.join(runIds)})
    GROUP BY "runId"
  `;
  for (const row of rows ?? []) {
    if (row.runId)
      ends.set(row.runId, { firstSeq: Number(row.firstSeq), lastSeq: Number(row.lastSeq) });
  }
  return ends;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Batched summaries for a set of Runs of one Thread: one grouped pass per
 * fact source regardless of how many Runs the window holds (no fan-out).
 *
 * Generation fence: active Runs and Runs with pending Interventions are
 * current by construction (clear cancels and settles them); a terminal Run is
 * current only while its event ceiling sits above the last `thread.cleared`
 * seq. Pre-clear terminal Runs drop out of the window while their audit rows
 * survive untouched.
 */
export async function loadExecutionSummaries(
  db: TxLike,
  input: {
    threadId: string;
    spaceId: string;
    runIds: readonly string[];
    /** Keep stale terminal Runs at rev 0 (single-Run detail reads). */
    includeStale?: boolean;
  },
): Promise<ExecutionSummary[]> {
  const runIds = [...new Set(input.runIds)].sort();
  if (runIds.length === 0) return [];
  const [runs, generation, ceilings] = await Promise.all([
    db.run.findMany({
      where: { id: { in: runIds }, threadId: input.threadId, spaceId: input.spaceId },
      select: {
        id: true,
        threadId: true,
        botId: true,
        taskId: true,
        status: true,
        waitKind: true,
        trigger: true,
        error: true,
        orchestration: true,
        sourceMessageId: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        snapshotRev: true,
      },
    }),
    currentThreadGeneration(db, input.threadId),
    executionEventCeilings(db, runIds),
  ]);
  const present = runs.filter((run) => {
    if (input.includeStale) return true;
    if (!TERMINAL_RUN_STATUSES.has(run.status)) return true;
    // Generation fence by the Run's own lifecycle footprint, not by "any
    // event exists": a Thread Clear deletes every pre-clear event, but
    // thread-maintenance `thread.artifact` rows (e.g. deleting a stale Run's
    // artifact afterwards) may be appended for a terminal Run at any time and
    // must not drag it back into the current generation. Presence-based (not
    // seq > generation) to stay exact at the seq-0 boundary.
    const lifecycleSeq = ceilings.get(run.id)?.lifecycleSeq;
    return lifecycleSeq !== undefined && lifecycleSeq !== null;
  });
  if (present.length === 0) return [];
  const scopedIds = present.map((run) => run.id);
  const taskIds = [...new Set(present.map((run) => run.taskId))];
  const sourceIds = present
    .filter((run) => run.trigger === "bot_message" && run.sourceMessageId)
    .map((run) => run.sourceMessageId as string);
  const [
    tasks,
    sources,
    ends,
    stepCounts,
    actionCounts,
    agentCounts,
    artifactTotals,
    artifactRows,
  ] = await Promise.all([
    db.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, prompt: true } }),
    db.message.findMany({ where: { id: { in: sourceIds } }, select: { id: true, blocks: true } }),
    messageEndsByRun(db, input.threadId, scopedIds),
    db.runStep.groupBy({
      by: ["runId"],
      where: { runId: { in: scopedIds }, threadGeneration: generation },
      _count: { _all: true },
    }),
    db.event.groupBy({
      by: ["runId"],
      where: { runId: { in: scopedIds }, type: ACTION_COUNT_EVENT_TYPE },
      _count: { _all: true },
    }),
    db.backgroundAgentTask.groupBy({
      by: ["parentRunId"],
      where: { parentRunId: { in: scopedIds }, threadGeneration: generation },
      _count: { _all: true },
    }),
    db.artifact.groupBy({
      by: ["runId"],
      where: { runId: { in: scopedIds }, spaceId: input.spaceId },
      _count: { _all: true },
    }),
    // Per-Run preview partition: a global `take` would let one artifact-rich
    // Run starve every later Run's preview. Each Run keeps its own first
    // MAX_SUMMARY_ARTIFACTS names in a stable createdAt+id order.
    db.$queryRaw<Array<{ id: string; runId: string | null; name: string; mimeType: string }>>`
        SELECT "id", "runId", "name", "mimeType" FROM (
          SELECT "id", "runId", "name", "mimeType",
                 ROW_NUMBER() OVER (
                   PARTITION BY "runId" ORDER BY "createdAt", "id"
                 ) AS "rn"
          FROM "artifacts"
          WHERE "spaceId" = ${input.spaceId} AND "runId" IN (${Prisma.join(scopedIds)})
        ) AS "ranked"
        WHERE "rn" <= ${MAX_SUMMARY_ARTIFACTS}
        ORDER BY "runId", "rn"
      `,
  ]);
  const promptByTask = new Map(tasks.map((task) => [task.id, task.prompt]));
  const blocksBySource = new Map(sources.map((source) => [source.id, source.blocks]));
  const stepsByRun = new Map(stepCounts.map((row) => [row.runId, row._count._all]));
  const actionsByRun = new Map(actionCounts.map((row) => [row.runId, row._count._all]));
  const agentsByRun = new Map(agentCounts.map((row) => [row.parentRunId, row._count._all]));
  const artifactsTotalByRun = new Map<string, number>();
  for (const row of artifactTotals) {
    if (row.runId) artifactsTotalByRun.set(row.runId, row._count._all);
  }
  const artifactsByRun = new Map<string, Array<{ id: string; name: string; mimeType?: string }>>();
  for (const artifact of artifactRows) {
    if (!artifact.runId) continue;
    const list = artifactsByRun.get(artifact.runId) ?? [];
    list.push({ id: artifact.id, name: artifact.name, mimeType: artifact.mimeType });
    artifactsByRun.set(artifact.runId, list);
  }

  const wantedSeqs: number[] = [];
  for (const run of present) {
    const endsFor = ends.get(run.id);
    if (!endsFor) continue;
    wantedSeqs.push(endsFor.firstSeq, endsFor.lastSeq);
  }
  const bySeq = new Map<string, { id: string; runId: string | null; blocks: unknown }>();
  if (wantedSeqs.length > 0) {
    const messages = await db.message.findMany({
      where: {
        threadId: input.threadId,
        role: "bot",
        runId: { in: scopedIds },
        seq: { in: [...new Set(wantedSeqs)] },
      },
      orderBy: { seq: "desc" },
      take: SUMMARY_MESSAGE_SCAN_LIMIT,
      select: { id: true, runId: true, seq: true, blocks: true },
    });
    for (const message of messages) bySeq.set(`${message.runId}:${message.seq}`, message);
  }

  const summaries: ExecutionSummary[] = [];
  for (const run of present) {
    const endsFor = ends.get(run.id);
    const outcomeMessage = endsFor ? bySeq.get(`${run.id}:${endsFor.lastSeq}`) : undefined;
    const anchorMessage = endsFor ? bySeq.get(`${run.id}:${endsFor.firstSeq}`) : undefined;
    const outcome = outcomeMessage
      ? pickExecutionResult({ messageId: outcomeMessage.id, blocks: outcomeMessage.blocks })
      : null;
    const artifactsTotal = artifactsTotalByRun.get(run.id);
    const facts: ExecutionSummaryFacts = {
      run: {
        id: run.id,
        threadId: run.threadId,
        botId: run.botId,
        status: run.status as ExecutionSummaryFacts["run"]["status"],
        waitKind: run.waitKind,
        trigger: run.trigger,
        error: run.error,
        orchestration: run.orchestration,
        startedAt: toIso(run.startedAt),
        completedAt: toIso(run.completedAt),
        createdAt: run.createdAt.toISOString(),
      },
      lastEventAt: toIso(ceilings.get(run.id)?.lastEventAt ?? null),
      rev: composeRunRev({
        eventCeiling: ceilings.get(run.id)?.ceiling ?? 0,
        rowVersion: run.snapshotRev,
      }),
      taskPrompt: promptByTask.get(run.taskId) ?? null,
      peerSourceBlocks: run.sourceMessageId ? blocksBySource.get(run.sourceMessageId) : undefined,
      outcomeBlocks: outcome?.blocks,
      counts: {
        steps: stepsByRun.get(run.id),
        actions: actionsByRun.get(run.id),
        agents: agentsByRun.get(run.id),
        artifacts: artifactsTotal,
      },
      artifacts: artifactsByRun.get(run.id) ?? [],
      artifactsTotal,
      anchorMessageId: anchorMessage?.id ?? null,
    };
    summaries.push(buildExecutionSummary(facts));
  }
  return summaries;
}

/* ------------------------------------------------------------------ */
/* Activity pagination                                                 */
/* ------------------------------------------------------------------ */

const activityEventWhere = (runId: string) => ({
  runId,
  type: { in: [...ACTIVITY_EVENT_TYPES] },
});

async function runActivityContext(
  db: TxLike,
  threadId: string,
  run: { id: string; botId: string; status: string; startedAt: Date | null },
  generation: number,
): Promise<ActivityProjectionContext> {
  const [bot, tasks] = await Promise.all([
    db.bot.findUnique({ where: { id: run.botId }, select: { name: true } }),
    db.backgroundAgentTask.findMany({
      where: { parentRunId: run.id, threadGeneration: generation },
      orderBy: { startedAt: "desc" },
      take: 20,
      select: {
        taskId: true,
        parentRunId: true,
        botId: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        error: true,
      },
    }),
  ]);
  const runs: ActivityRunContext[] = [
    {
      runId: run.id,
      botId: run.botId,
      status: run.status,
      startedAt: run.startedAt?.toISOString() ?? null,
    },
  ];
  return {
    threadId,
    botNames: { [run.botId]: bot?.name ?? "Bot" },
    runs,
    backgroundTasks: tasks.map((task) => ({
      taskId: task.taskId,
      parentRunId: task.parentRunId,
      botId: task.botId,
      status: task.status,
      startedAt: task.startedAt?.toISOString() ?? null,
      finishedAt: task.finishedAt?.toISOString() ?? null,
      error: task.error,
    })),
  };
}

type ActivityEventRow = {
  type: string;
  botId: string;
  seq: number;
  createdAt: Date;
  runId: string | null;
  payload: unknown;
};

function mapActivityEvent(event: ActivityEventRow): ActivitySourceEvent {
  return {
    type: event.type,
    botId: event.botId,
    seq: event.seq,
    createdAt: event.createdAt.toISOString(),
    runId: event.runId,
    payload:
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : undefined,
  };
}

/**
 * One page of a Run's Activity projection, oldest-last on the wire so a
 * client prepends older pages. The opaque cursor binds the Run, the Thread
 * clear generation, and the walk bounds, so events appended while paging can
 * neither duplicate nor skip an already-delivered item. called/completed
 * pairing is page-safe: when a page opens on a `completed` whose `called`
 * event lies below the bound, the parent is fetched and prepended so the
 * shared projector pairs it and the newer page carries the completed status.
 */
export async function loadRunActivityPage(
  db: TxLike,
  input: { threadId: string; spaceId: string; runId: string; cursor?: string; limit?: number },
): Promise<ExecutionActivityPage> {
  const limit = Math.min(
    Math.max(input.limit ?? ACTIVITY_PAGE_DEFAULT_LIMIT, 1),
    ACTIVITY_PAGE_MAX_LIMIT,
  );
  const run = await db.run.findFirst({
    where: { id: input.runId, threadId: input.threadId, spaceId: input.spaceId },
    select: { id: true, botId: true, status: true, startedAt: true },
  });
  if (!run) {
    throw new ExecutionActivityCursorError("invalid_cursor");
  }
  const generation = await currentThreadGeneration(db, input.threadId);
  let exclusiveAbove: number | null = null;
  let boundHi = 0;
  if (input.cursor) {
    const decoded = decodeExecutionActivityCursor(input.cursor);
    if (!decoded) throw new ExecutionActivityCursorError("invalid_cursor");
    if (decoded.r !== run.id) throw new ExecutionActivityCursorError("invalid_cursor");
    if (decoded.g !== generation) throw new ExecutionActivityCursorError("stale_cursor");
    exclusiveAbove = decoded.nx;
    boundHi = decoded.hi;
  }
  const rows = await db.event.findMany({
    where: {
      ...activityEventWhere(run.id),
      ...(exclusiveAbove === null ? {} : { seq: { lt: exclusiveAbove } }),
    },
    orderBy: { seq: "desc" },
    take: limit + 1,
    select: { type: true, botId: true, seq: true, createdAt: true, runId: true, payload: true },
  });
  const haveMore = rows.length > limit;
  const page = haveMore ? rows.slice(0, limit) : rows;
  const pageEvents = page.map(mapActivityEvent).reverse();
  const oldest = page.at(-1)?.seq ?? 0;
  const newest = page[0]?.seq ?? 0;
  // A page may open on an agent.tool.completed whose called event sits below
  // the walk bound. The shared reducer drops such an orphan patch, so without
  // this the step would render "running" nowhere and "completed" nowhere — a
  // gap at the page boundary. Fetch exactly those parent events and prepend
  // them so the projector pairs them; the live SSE path never needs this.
  const calledHere = new Set(
    pageEvents.flatMap((event) =>
      event.type === "agent.tool.called" && typeof event.payload?.executionId === "string"
        ? [event.payload.executionId]
        : [],
    ),
  );
  const orphanExecutions = [
    ...new Set(
      pageEvents.flatMap((event) =>
        event.type === "agent.tool.completed" && typeof event.payload?.executionId === "string"
          ? [event.payload.executionId]
          : [],
      ),
    ),
  ].filter((executionId) => !calledHere.has(executionId));
  let events = pageEvents;
  if (orphanExecutions.length > 0 && page.length > 0) {
    const parents = await db.$queryRaw<
      Array<{
        type: string;
        botId: string;
        seq: number;
        createdAt: Date;
        runId: string | null;
        payload: unknown;
      }>
    >`
      SELECT "type", "botId", "seq", "createdAt", "runId", "payload"
      FROM "events"
      WHERE "runId" = ${run.id}
        AND "type" = 'agent.tool.called'
        AND "seq" < ${oldest}
        AND "payload" ->> 'executionId' IN (${Prisma.join(orphanExecutions)})
      ORDER BY "seq" ASC
      LIMIT ${orphanExecutions.length}
    `;
    events = [...parents.map(mapActivityEvent), ...pageEvents];
  }
  const context = await runActivityContext(db, input.threadId, run, generation);
  const items = projectActivity(events, context).filter(
    (item: ActivityItem) => item.runId === run.id,
  );
  const olderCursor =
    haveMore && page.length > 0
      ? encodeExecutionActivityCursor({
          v: 1,
          r: run.id,
          g: generation,
          hi: boundHi === 0 ? newest : boundHi,
          nx: oldest,
        })
      : null;
  return { items, olderCursor, truncated: haveMore };
}

/* ------------------------------------------------------------------ */
/* Detail snapshot                                                     */
/* ------------------------------------------------------------------ */

/**
 * The full per-Run ExecutionSnapshot. Reads only: one Thread `FOR SHARE` lock
 * is the caller's job (same fence as threads/get), which serializes this
 * transaction against event appends and yields a pre-/post-commit-consistent
 * view rather than a stitched one.
 */
export async function loadExecutionSnapshot(
  db: TxLike,
  input: { threadId: string; spaceId: string; runId: string },
): Promise<ExecutionSnapshot | null> {
  const [run, generation] = await Promise.all([
    db.run.findFirst({
      where: { id: input.runId, threadId: input.threadId, spaceId: input.spaceId },
      select: { id: true, botId: true, status: true, startedAt: true },
    }),
    currentThreadGeneration(db, input.threadId),
  ]);
  if (!run) return null;
  const ceilings = await executionEventCeilings(db, [run.id]);
  // Staleness keys off the lifecycle ceiling, not the all-events ceiling: a
  // post-clear `thread.artifact` event (artifact deleted after a Thread
  // Clear) raises the all-events ceiling of a pre-clear Run without making it
  // current again.
  const stale = generation > 0 && (ceilings.get(run.id)?.lifecycleSeq ?? 0) <= generation;

  const [summaries, planRow, stepRows, todoRows, runMessages] = await Promise.all([
    loadExecutionSummaries(db, {
      threadId: input.threadId,
      spaceId: input.spaceId,
      runIds: [run.id],
      includeStale: true,
    }),
    stale ? Promise.resolve(null) : db.runPlan.findUnique({ where: { runId: run.id } }),
    stale
      ? Promise.resolve([])
      : db.runStep.findMany({
          where: { runId: run.id, threadGeneration: generation },
          orderBy: { sortOrder: "asc" },
          take: EXECUTION_STEPS_LIMIT + 1,
        }),
    stale
      ? Promise.resolve([])
      : db.runTodo.findMany({
          where: { runId: run.id, threadGeneration: generation },
          orderBy: { sortOrder: "asc" },
          take: EXECUTION_TODOS_LIMIT + 1,
        }),
    db.message.findMany({
      where: { threadId: input.threadId, runId: run.id, role: "bot" },
      orderBy: { seq: "asc" },
      take: SUMMARY_MESSAGE_SCAN_LIMIT,
      select: { id: true, runId: true, blocks: true },
    }),
  ]);
  const summary = summaries[0];
  if (!summary) return null;

  const interventions = stale
    ? []
    : (
        await loadInterventionViews(db as Prisma.TransactionClient, input.threadId, runMessages, [
          run.id,
        ])
      ).filter((view) => view.runId === run.id);

  const stepsTruncated = stepRows.length > EXECUTION_STEPS_LIMIT;
  const steps = {
    items: stepRows
      .slice(0, EXECUTION_STEPS_LIMIT)
      .map((row) => RunStepSnapshotSchema.parse(row.current)),
    total: stepsTruncated ? undefined : stepRows.length,
    truncated: stepsTruncated,
  };
  const todosTruncated = todoRows.length > EXECUTION_TODOS_LIMIT;
  const todos = {
    items: todoRows
      .slice(0, EXECUTION_TODOS_LIMIT)
      .map((row) => RunTodoSnapshotSchema.parse(row.current)),
    total: todosTruncated ? undefined : todoRows.length,
    truncated: todosTruncated,
  };
  const planParsed =
    planRow && planRow.threadGeneration === generation
      ? RunPlanRevisionSchema.safeParse(planRow.current)
      : null;
  const plan = planParsed?.success ? planParsed.data : undefined;

  const timelineRows = await db.event.findMany({
    where: activityEventWhere(run.id),
    orderBy: { seq: "desc" },
    take: ACTIVITY_SCAN_LIMIT,
    select: { type: true, botId: true, seq: true, createdAt: true, runId: true, payload: true },
  });
  const activityTruncated = timelineRows.length >= ACTIVITY_SCAN_LIMIT;
  const context = await runActivityContext(db, input.threadId, run, generation);
  const timelineItems = projectActivity(
    timelineRows.map(mapActivityEvent).reverse(),
    context,
  ).filter((item: ActivityItem) => item.runId === run.id);
  const timeline = timelineItems.slice(-EXECUTION_TIMELINE_LIMIT);

  const activityPage = await loadRunActivityPage(db, {
    threadId: input.threadId,
    spaceId: input.spaceId,
    runId: run.id,
  });

  const lastMessage = runMessages.length > 0 ? runMessages[runMessages.length - 1] : null;
  const result = lastMessage
    ? pickExecutionResult({ messageId: lastMessage.id, blocks: lastMessage.blocks })
    : null;

  const incomplete = new Set(summary.incompleteSections ?? []);
  if (stale) {
    for (const section of [
      "plan",
      "steps",
      "todos",
      "activity",
      "interventions",
      "result",
    ] as const) {
      incomplete.add(section);
    }
  }
  if (activityTruncated) incomplete.add("activity");
  if (steps.truncated) incomplete.add("steps");
  if (todos.truncated) incomplete.add("todos");

  return {
    summary: {
      ...summary,
      ...(incomplete.size > 0
        ? {
            incompleteSections: [...incomplete].sort() as NonNullable<
              ExecutionSummary["incompleteSections"]
            >,
          }
        : {}),
    },
    ...(plan ? { plan } : {}),
    steps,
    todos,
    timeline,
    activityPage,
    interventions,
    ...(result ? { result } : {}),
  };
}
