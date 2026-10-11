import {
  type Actor,
  MessageBlock,
  type RunActivityRow,
  type RunsDetailOutput,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  ACTIVITY_EVENT_TYPES,
  botMessageContext,
  currentActivityLine,
  projectActivity,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

const RECENT_LIMIT = 20;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

function promptSnippet(prompt: string, max = 120): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function activityPromptSnippet(
  input: { trigger: string; prompt: string; sourceBlocks?: unknown },
  max = 120,
): string {
  if (input.trigger !== "bot_message") return promptSnippet(input.prompt, max);
  const parsed = MessageBlock.array().safeParse(input.sourceBlocks);
  const message = parsed.success ? botMessageContext(parsed.data) : undefined;
  if (!message) return "Message from another agent";
  const name = message.fromBotName.trim() || "Another agent";
  const label =
    message.intent === "result" || message.intent === "status" || message.intent === "fyi"
      ? `Update from ${name}`
      : `${name} asked`;
  return promptSnippet(message.text.trim() ? `${label}: ${message.text}` : label, max);
}

export function activityNotificationsEnabled(
  groupId: string | null,
  notifyOnFinish: boolean,
): boolean {
  return groupId !== null || notifyOnFinish;
}

const ACTIVITY_EVENT_WINDOW = 400;

type RunActivityLine = NonNullable<RunActivityRow["activity"]>;

/**
 * §28: project the current activity line for active runs server-side so the
 * sidebar shows product language instead of re-parsing events (or falling
 * back to prompt snippets) on its own.
 */
async function projectActiveRunActivities(
  prisma: PrismaClient,
  rows: Array<{
    id: string;
    botId: string;
    threadId: string;
    status: string;
    startedAt: Date | null;
  }>,
): Promise<Map<string, RunActivityLine>> {
  const lines = new Map<string, RunActivityLine>();
  if (rows.length === 0) return lines;
  const events = await prisma.event.findMany({
    where: { runId: { in: rows.map((row) => row.id) }, type: { in: [...ACTIVITY_EVENT_TYPES] } },
    orderBy: { seq: "desc" },
    take: ACTIVITY_EVENT_WINDOW,
    select: { type: true, botId: true, seq: true, createdAt: true, runId: true, payload: true },
  });
  type EventRow = (typeof events)[number];
  const byRun = new Map<string, EventRow[]>();
  for (const event of events) {
    if (!event.runId) continue;
    const bucket = byRun.get(event.runId);
    if (bucket) bucket.push(event);
    else byRun.set(event.runId, [event]);
  }
  for (const row of rows) {
    const runEvents = (byRun.get(row.id) ?? []).slice().reverse();
    const items = projectActivity(
      runEvents.map((event) => ({
        type: event.type,
        botId: event.botId,
        seq: event.seq,
        createdAt: event.createdAt.toISOString(),
        runId: event.runId,
        payload:
          event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : undefined,
      })),
      {
        threadId: row.threadId,
        runs: [
          {
            runId: row.id,
            botId: row.botId,
            status: row.status,
            startedAt: row.startedAt?.toISOString() ?? null,
          },
        ],
      },
    );
    const line = currentActivityLine(items, row.id);
    if (line) lines.set(row.id, line as RunActivityLine);
  }
  return lines;
}

export async function listSpaceRuns(
  prisma: PrismaClient,
  actor: Actor,
  filter: "active" | "recent",
): Promise<RunActivityRow[]> {
  const rows = await prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
      ...(filter === "active"
        ? { status: { in: [...ACTIVE_RUN_STATUSES] } }
        : { status: { in: [...TERMINAL_STATUSES] } }),
    },
    include: {
      bot: { select: { name: true, archivedAt: true, notifyOnFinish: true } },
      task: { select: { prompt: true } },
      sourceMessage: { select: { blocks: true } },
      thread: {
        select: {
          groupId: true,
          group: { select: { name: true } },
        },
      },
    },
    orderBy:
      filter === "active"
        ? [{ updatedAt: "desc" }, { id: "desc" }]
        : [{ completedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    take: filter === "recent" ? RECENT_LIMIT : undefined,
  });

  const activityLines =
    filter === "active"
      ? await projectActiveRunActivities(prisma, rows)
      : new Map<string, RunActivityLine>();

  return rows.map((row) => {
    const activity = activityLines.get(row.id);
    return {
      runId: row.id,
      botId: row.botId,
      botName: row.bot.name,
      groupId: row.thread.groupId,
      groupName: row.thread.group?.name ?? null,
      threadId: row.threadId,
      status: row.status as RunActivityRow["status"],
      trigger: row.trigger as RunActivityRow["trigger"],
      notificationsEnabled: activityNotificationsEnabled(
        row.thread.groupId,
        row.bot.notifyOnFinish,
      ),
      promptSnippet: activityPromptSnippet({
        trigger: row.trigger,
        prompt: row.task.prompt,
        sourceBlocks: row.sourceMessage?.blocks,
      }),
      updatedAt: (filter === "recent" && row.completedAt
        ? row.completedAt
        : row.updatedAt
      ).toISOString(),
      ...(activity ? { activity } : {}),
    };
  });
}

export async function getRunDetail(
  prisma: PrismaClient,
  actor: Actor,
  runId: string,
): Promise<RunsDetailOutput | null> {
  const run = await prisma.run.findFirst({
    where: { id: runId, spaceId: actor.spaceId, userId: actor.userId },
    include: {
      bot: { select: { name: true, color: true, notifyOnFinish: true } },
      task: { select: { prompt: true } },
      thread: { select: { groupId: true } },
      attempts: { orderBy: { fence: "asc" } },
      effects: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!run) return null;

  const siblings = run.routineId
    ? await prisma.run.findMany({
        where: {
          routineId: run.routineId,
          id: { not: run.id },
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
        orderBy: [{ completedAt: "desc" }, { updatedAt: "desc" }],
        take: 5,
        include: { task: { select: { prompt: true } } },
      })
    : [];

  return {
    run: {
      runId: run.id,
      botId: run.botId,
      botName: run.bot.name,
      botColor: run.bot.color,
      threadId: run.threadId,
      status: run.status as RunsDetailOutput["run"]["status"],
      trigger: run.trigger as RunsDetailOutput["run"]["trigger"],
      notificationsEnabled: activityNotificationsEnabled(
        run.thread.groupId,
        run.bot.notifyOnFinish,
      ),
      promptSnippet: activityPromptSnippet({ trigger: run.trigger, prompt: run.task.prompt }),
      error: run.error,
      routineId: run.routineId,
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      updatedAt: run.updatedAt.toISOString(),
    },
    attempts: run.attempts.map((attempt) => ({
      fence: attempt.fence,
      status: attempt.status,
      error: attempt.error,
      startedAt: attempt.startedAt.toISOString(),
      finishedAt: attempt.finishedAt?.toISOString() ?? null,
    })),
    effects: run.effects.map((effect) => ({
      effectId: effect.id,
      kind: effect.kind,
      status: effect.status,
      request: effect.request,
      result: effect.result ?? null,
      createdAt: effect.createdAt.toISOString(),
    })),
    history: siblings.map((sibling) => ({
      runId: sibling.id,
      status: sibling.status as RunsDetailOutput["run"]["status"],
      promptSnippet: activityPromptSnippet({
        trigger: sibling.trigger,
        prompt: sibling.task.prompt,
      }),
      at: (sibling.completedAt ?? sibling.updatedAt).toISOString(),
    })),
  };
}
