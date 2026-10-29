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
  type MessageBlock,
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
  callIdFromClientNonce,
  composeRunRev,
  decodeExecutionActivityCursor,
  type ExecutionSummaryFacts,
  encodeExecutionActivityCursor,
  pickExecutionResult,
  projectActivity,
  projectManualRetryEligibility,
} from "@rakazo/core";
import { type CardMessageFact, projectExecutionCardInteractions } from "./card-interactions.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { currentThreadGeneration } from "./events.js";
import { loadInterventionViews } from "./interventions.js";
import { loadPlanReviewState } from "./run-plans.js";

/**
 * ExecutionSnapshot read model (HISTORY-001). Pure composed reads over the
 * durable facts — Run/Task/Message/Event/Plan/Step/Todo/Intervention/Artifact/
 * BackgroundAgentTask. No snapshot document is stored and nothing here writes.
 * Artifact membership events and explicit background-projection version bumps
 * make those non-Run-row changes move the owning Run's rev.
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

/**
 * MIN/MAX bot-message seq per Run in one indexed pass (anchors + result
 * heads). A message always lives in its Run's Thread, so the runId scope
 * alone is exact — and keeps one pass for windows spanning several Threads.
 */
async function messageEndsByRun(
  db: TxLike,
  runIds: readonly string[],
): Promise<Map<string, { firstSeq: number; lastSeq: number }>> {
  const ends = new Map<string, { firstSeq: number; lastSeq: number }>();
  if (runIds.length === 0) return ends;
  const rows = await db.$queryRaw<Array<{ runId: string; firstSeq: number; lastSeq: number }>>`
    SELECT "runId" AS "runId", MIN("seq")::int AS "firstSeq", MAX("seq")::int AS "lastSeq"
    FROM "messages"
    WHERE "role" = 'bot' AND "runId" IN (${Prisma.join(runIds)})
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

/** A Run row as the summary builder needs it (authorization already applied). */
export type SummaryRunRow = {
  id: string;
  threadId: string;
  botId: string;
  taskId: string;
  status: string;
  waitKind: string | null;
  trigger: string;
  error: string | null;
  orchestration: unknown;
  sourceMessageId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  snapshotRev: number;
  retryOfRunId?: string | null;
  followUpOfRunId?: string | null;
};

/** Columns every summary read needs; one shape for window and message reads. */
const SUMMARY_RUN_SELECT = {
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
  retryOfRunId: true,
  followUpOfRunId: true,
} as const;

/** Latest `thread.cleared` seq per Thread in one grouped pass (absent = 0). */
export async function currentThreadGenerations(
  db: TxLike,
  threadIds: readonly string[],
): Promise<Map<string, number>> {
  const generations = new Map<string, number>();
  if (threadIds.length === 0) return generations;
  const rows = await db.$queryRaw<Array<{ threadId: string; generation: number | null }>>`
    SELECT "threadId" AS "threadId", MAX("seq")::int AS "generation"
    FROM "events"
    WHERE "type" = 'thread.cleared' AND "threadId" IN (${Prisma.join(threadIds)})
    GROUP BY "threadId"
  `;
  for (const row of rows ?? []) {
    if (row.threadId && row.generation !== null)
      generations.set(row.threadId, Number(row.generation));
  }
  return generations;
}

/**
 * Batched summaries for already-authorized Runs of one OR several Threads:
 * one grouped pass per fact source regardless of how many Runs the window
 * holds (no per-Run — and no per-Thread — query fan-out). Used by the
 * per-Thread window (`loadExecutionSummaries`).
 *
 * Generation fence: active Runs and Runs with pending Interventions are
 * current by construction (clear cancels and settles them); a terminal Run is
 * current only while a Run-lifecycle event survives (everything except the
 * thread-maintenance `thread.artifact` rows). Pre-clear terminal Runs drop
 * out of the window while their audit rows survive untouched.
 */
export async function buildExecutionSummariesForRuns(
  db: TxLike,
  input: {
    spaceId: string;
    runs: readonly SummaryRunRow[];
  },
): Promise<ExecutionSummary[]> {
  const byId = new Map<string, SummaryRunRow>();
  for (const run of input.runs) byId.set(run.id, run);
  const scoped = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (scoped.length === 0) return [];
  const runIds = scoped.map((run) => run.id);
  const threadIds = [...new Set(scoped.map((run) => run.threadId))].sort();
  const [generations, ceilings] = await Promise.all([
    currentThreadGenerations(db, threadIds),
    executionEventCeilings(db, runIds),
  ]);
  const generationOf = (run: SummaryRunRow) => generations.get(run.threadId) ?? 0;
  const present = scoped.filter((run) => {
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
  const successorRows = await db.run.findMany({
    where: {
      OR: [{ retryOfRunId: { in: scopedIds } }, { followUpOfRunId: { in: scopedIds } }],
    },
    select: { id: true, retryOfRunId: true, followUpOfRunId: true, status: true },
  });
  const retrySuccessorByPredecessor = new Map<string, { id: string; status: string }>();
  const followUpSuccessorByPredecessor = new Map<string, { id: string; status: string }>();
  for (const row of successorRows) {
    if (row.retryOfRunId) {
      retrySuccessorByPredecessor.set(row.retryOfRunId, { id: row.id, status: row.status });
    }
    if (row.followUpOfRunId) {
      followUpSuccessorByPredecessor.set(row.followUpOfRunId, {
        id: row.id,
        status: row.status,
      });
    }
  }
  const taskIds = [...new Set(present.map((run) => run.taskId))];
  const sourceIds = present
    .filter((run) => run.trigger === "bot_message" && run.sourceMessageId)
    .map((run) => run.sourceMessageId as string);
  // Generation-filtered fact tables span Threads, so the per-Run current
  // generation rides along in a VALUES join — still ONE grouped pass each.
  const generationPairs = Prisma.join(
    present.map((run) => Prisma.sql`(${run.id}::text, ${generationOf(run)}::int)`),
  );
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
    messageEndsByRun(db, scopedIds),
    db.$queryRaw<Array<{ runId: string; count: number }>>`
        SELECT s."runId" AS "runId", COUNT(*)::int AS "count"
        FROM "run_steps" s
        JOIN (VALUES ${generationPairs}) AS v("runId", "gen")
          ON v."runId" = s."runId" AND v."gen" = s."threadGeneration"
        GROUP BY s."runId"
      `,
    db.event.groupBy({
      by: ["runId"],
      where: { runId: { in: scopedIds }, type: ACTION_COUNT_EVENT_TYPE },
      _count: { _all: true },
    }),
    db.$queryRaw<Array<{ runId: string; count: number }>>`
        SELECT b."parentRunId" AS "runId", COUNT(*)::int AS "count"
        FROM "background_agent_tasks" b
        JOIN (VALUES ${generationPairs}) AS v("runId", "gen")
          ON v."runId" = b."parentRunId" AND v."gen" = b."threadGeneration"
        GROUP BY b."parentRunId"
      `,
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
  const stepsByRun = new Map(stepCounts.map((row) => [row.runId, Number(row.count)]));
  const actionsByRun = new Map(actionCounts.map((row) => [row.runId, row._count._all]));
  const agentsByRun = new Map(agentCounts.map((row) => [row.runId, Number(row.count)]));
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
        sourceMessageId: run.sourceMessageId,
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
      sourceMessageId: run.sourceMessageId,
      retryOfRunId: run.retryOfRunId ?? null,
      retrySuccessorRunId: retrySuccessorByPredecessor.get(run.id)?.id ?? null,
      followUpOfRunId: run.followUpOfRunId ?? null,
      followUpSuccessorRunId: followUpSuccessorByPredecessor.get(run.id)?.id ?? null,
      manualRetry: projectManualRetryEligibility({
        status: run.status,
        trigger: run.trigger,
        orchestration: run.orchestration,
        successorStatus: retrySuccessorByPredecessor.get(run.id)?.status ?? null,
      }),
    };
    summaries.push(buildExecutionSummary(facts));
  }
  return summaries;
}

/**
 * The per-Thread summary window (HISTORY-001): fetches the authorized Run
 * rows of one Thread and delegates to the shared multi-Thread builder.
 */
export async function loadExecutionSummaries(
  db: TxLike,
  input: {
    threadId: string;
    spaceId: string;
    runIds: readonly string[];
  },
): Promise<ExecutionSummary[]> {
  const runIds = [...new Set(input.runIds)].sort();
  if (runIds.length === 0) return [];
  const runs = await db.run.findMany({
    where: { id: { in: runIds }, threadId: input.threadId, spaceId: input.spaceId },
    select: SUMMARY_RUN_SELECT,
  });
  return buildExecutionSummariesForRuns(db, { spaceId: input.spaceId, runs });
}

/**
 * The message → Runs projection (PD-01P): every Run whose durable source is
 * one of the given history-page messages.
 *
 * A user turn can create several Runs (a multi-Bot group dispatch creates one
 * Run per destination, each with `sourceMessageId` set to the same message),
 * while the legacy `messages.runId` column only records the first. This reads
 * the whole page in ONE query — no per-message N+1 — unions the legacy
 * message→run ids for pre-`sourceMessageId` rows, and relies on the shared
 * builder for the Thread generation fence, retry eligibility, and all other
 * summary facts. The Thread+Space scope is applied in the query itself, so a
 * Run from another Thread or Space can never leak through a shared message id.
 *
 * Output order is `Run.createdAt ASC, Run.id ASC` — the database order is
 * made explicit here so paging, reloads, and query-plan changes project the
 * same sequence. A Run reachable through both the legacy id and its source
 * message appears once (the builder dedupes by Run id).
 */
export async function loadExecutionSummariesForMessages(
  db: TxLike,
  input: {
    threadId: string;
    spaceId: string;
    /** Messages of the loaded history page; each may own 0..N Runs. */
    messageIds: readonly string[];
    /** Legacy `Message.runId` links; unioned but never treated as exhaustive. */
    runIds?: readonly string[];
  },
): Promise<ExecutionSummary[]> {
  const messageIds = [...new Set(input.messageIds)].sort();
  const runIds = [...new Set(input.runIds ?? [])].sort();
  if (messageIds.length === 0 && runIds.length === 0) return [];
  const runs = await db.run.findMany({
    where: {
      threadId: input.threadId,
      spaceId: input.spaceId,
      OR: [
        ...(messageIds.length > 0 ? [{ sourceMessageId: { in: messageIds } }] : []),
        ...(runIds.length > 0 ? [{ id: { in: runIds } }] : []),
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: SUMMARY_RUN_SELECT,
  });
  const summaries = await buildExecutionSummariesForRuns(db, {
    spaceId: input.spaceId,
    runs,
  });
  // The builder filters stale/cleared Runs and dedupes; restore its rows to the
  // stable source order rather than the builder's batching order.
  const position = new Map(runs.map((run, index) => [run.id, index]));
  return summaries.sort((a, b) => (position.get(a.runId) ?? 0) - (position.get(b.runId) ?? 0));
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
  const lifecycleSeq = (await executionEventCeilings(db, [run.id])).get(run.id)?.lifecycleSeq;
  if (
    TERMINAL_RUN_STATUSES.has(run.status) &&
    generation > 0 &&
    (lifecycleSeq === undefined || lifecycleSeq === null || lifecycleSeq <= generation)
  ) {
    throw new ExecutionActivityCursorError("stale_cursor");
  }
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
  input: {
    threadId: string;
    spaceId: string;
    runId: string;
    /** CARD-01A: merge message-backed approvals into the snapshot projection. */
    cardsUnifiedV2?: boolean;
  },
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
  if (TERMINAL_RUN_STATUSES.has(run.status) && stale) return null;

  const [summaries, planRow, stepRows, todoRows, latestRunMessages] = await Promise.all([
    loadExecutionSummaries(db, {
      threadId: input.threadId,
      spaceId: input.spaceId,
      runIds: [run.id],
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
      // The newest message is the result head. Keep the bounded scan close
      // to that head so a Run with >500 bot messages cannot return message 500
      // as its final result or miss a later legacy Ask in the same window.
      orderBy: { seq: "desc" },
      take: SUMMARY_MESSAGE_SCAN_LIMIT,
      select: {
        id: true,
        role: true,
        runId: true,
        clientNonce: true,
        blocks: true,
        createdAt: true,
      },
    }),
  ]);
  const summary = summaries[0];
  if (!summary) return null;
  const runMessages = latestRunMessages.reverse();

  const interventions = stale
    ? []
    : (
        await loadInterventionViews(db as Prisma.TransactionClient, input.threadId, runMessages, [
          run.id,
        ])
      ).filter((view) => view.runId === run.id);

  const cardInteractions =
    input.cardsUnifiedV2 && !stale
      ? projectExecutionCardInteractions({
          interventions,
          messages: runMessages.map(
            (message): CardMessageFact => ({
              id: message.id,
              threadId: input.threadId,
              spaceId: input.spaceId,
              botId: run.botId,
              runId: message.runId ?? run.id,
              createdAt: message.createdAt.toISOString(),
              role: message.role,
              callId: callIdFromClientNonce(message.clientNonce),
              blocks: message.blocks as MessageBlock[],
            }),
          ),
        })
      : undefined;

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
  // UX-02: review state rides next to the current revision. Legacy plans
  // (reviewStatus NULL) project nothing and keep their historical display.
  const planReview =
    plan && planRow && planRow.reviewStatus !== null
      ? await loadPlanReviewState(db as Prisma.TransactionClient, run.id)
      : undefined;

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
    ...(planReview ? { planReview } : {}),
    steps,
    todos,
    timeline,
    activityPage,
    interventions,
    ...(cardInteractions ? { interactions: cardInteractions } : {}),
    ...(result ? { result } : {}),
  };
}
