import {
  activityLabels,
  askedForHelpLabel,
  askedQuestionLabel,
  handedToLabel,
  planProgressLabel,
  returnedResultLabel,
  toolActionLabel,
} from "./labels.js";
import type {
  ActivityItem,
  ActivityProjectionContext,
  ActivitySourceEvent,
} from "./types.js";

/**
 * Product Harness Phase 4 — Activity Projector (§5/§6).
 *
 * Pure projection: persisted Product Events (+ run state and background task
 * rows) fold into ActivityItem[] through ONE reducer. Snapshot replay and
 * live SSE reduction call the same code, so "Replay == Live" by construction.
 * Items are upserted by deterministic ids, making the fold idempotent.
 *
 * Nothing here may surface runtime internals: plan_enter/agent_spawn/task
 * identifiers, raw tool names and event types stay inside this module; only
 * labels.ts vocabulary leaves it. Message content and model reasoning are
 * never projected (§31).
 */

/** Event types worth querying for a projection (bounded server-side). */
export const ACTIVITY_EVENT_TYPES = [
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.waiting_input",
  "thread.progress",
  "thread.subagent",
  "subagent.started",
  "subagent.progress",
  "subagent.completed",
  "subagent.failed",
  "subagent.cancelled",
  "agent.tool.called",
  "agent.tool.completed",
  "thread.collaboration.requested",
  "thread.collaboration.result",
  "thread.turn.handed_off",
] as const;

const MAX_DETAIL_CHARS = 200;

function clipDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

function upsert(items: ActivityItem[], item: ActivityItem): ActivityItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  const next = items.slice();
  // Merge so a later partial update never drops earlier fields.
  next[index] = { ...next[index]!, ...item };
  return next;
}

function patch(
  items: ActivityItem[],
  id: string,
  changes: Partial<ActivityItem>,
): ActivityItem[] {
  const index = items.findIndex((existing) => existing.id === id);
  if (index === -1) return items;
  const next = items.slice();
  next[index] = { ...next[index]!, ...changes };
  return next;
}

function botName(context: ActivityProjectionContext, botId: string | undefined): string {
  if (!botId) return "another agent";
  return context.botNames?.[botId] ?? "another agent";
}

function str(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Seed items from durable state so a refresh mid-run reconstructs the same
 * picture the live reducer built (runs in flight, waiting states, background
 * tasks that outlive their parent run).
 */
export function seedActivityFromContext(context: ActivityProjectionContext): ActivityItem[] {
  let items: ActivityItem[] = [];
  for (const run of context.runs ?? []) {
    const base = {
      id: `run:${run.runId}`,
      runId: run.runId,
      botId: run.botId,
      threadId: context.threadId,
      startedAt: run.startedAt ?? undefined,
    };
    if (run.status === "waiting_input") {
      items = upsert(items, {
        ...base,
        kind: "waiting_input",
        status: "waiting",
        title: activityLabels.waitingInput,
      });
    } else if (run.status === "waiting_takeover") {
      items = upsert(items, {
        ...base,
        kind: "waiting_takeover",
        status: "waiting",
        title: activityLabels.needsTakeover,
      });
    } else if (run.status === "running" || run.status === "queued" || run.status === "leased") {
      items = upsert(items, { ...base, kind: "working", status: "running", title: activityLabels.working });
    }
  }
  for (const task of context.backgroundTasks ?? []) {
    items = upsert(items, backgroundItem(context, task.taskId, task.parentRunId, task.botId, task.status, {
      startedAt: task.startedAt ?? undefined,
      completedAt: task.finishedAt ?? undefined,
      detail: clipDetail(task.status === "failed" ? task.error : task.label) ,
      taskId: task.status === "running" ? task.taskId : undefined,
    }));
  }
  return items;
}

function backgroundItem(
  context: ActivityProjectionContext,
  taskId: string,
  parentRunId: string,
  botId: string,
  status: string,
  extra: Partial<ActivityItem> = {},
): ActivityItem {
  const running = status === "running" || status === "pending";
  const title = running
    ? activityLabels.workingInBackground
    : status === "completed"
      ? activityLabels.backgroundCompleted
      : status === "cancelled"
        ? activityLabels.backgroundCancelled
        : activityLabels.backgroundFailed;
  return {
    id: `bg:${taskId}`,
    runId: parentRunId,
    botId,
    threadId: context.threadId,
    kind: "background",
    status: running
      ? "running"
      : status === "completed"
        ? "completed"
        : status === "cancelled"
          ? "cancelled"
          : "failed",
    title,
    // Cancel is only offered while running; clear the handle on terminal
    // states so a merged update cannot keep a stale cancelable id.
    taskId: running ? taskId : undefined,
    ...extra,
  };
}

/**
 * The single live/replay reducer: fold one persisted event into the activity
 * list. Unknown or state-only event types are ignored (mapping table §52/§53).
 */
export function reduceActivity(
  items: ActivityItem[],
  event: ActivitySourceEvent,
  context: ActivityProjectionContext,
): ActivityItem[] {
  const payload = event.payload;
  const runId = event.runId ?? undefined;
  const base = {
    runId,
    botId: event.botId,
    threadId: context.threadId,
  };
  switch (event.type) {
    case "run.started":
      return upsert(items, {
        ...base,
        id: `run:${runId ?? event.seq}`,
        kind: "working",
        status: "running",
        title: activityLabels.working,
        startedAt: event.createdAt,
      });
    case "run.completed":
      return upsert(items, {
        ...base,
        id: `run:${runId ?? event.seq}`,
        kind: "completed",
        status: "completed",
        title: activityLabels.completed,
        completedAt: event.createdAt,
      });
    case "run.failed":
      return upsert(items, {
        ...base,
        id: `run:${runId ?? event.seq}`,
        kind: "failed",
        status: "failed",
        title: activityLabels.failed,
        detail: clipDetail(payload?.error),
        completedAt: event.createdAt,
      });
    case "run.cancelled":
      return upsert(items, {
        ...base,
        id: `run:${runId ?? event.seq}`,
        kind: "cancelled",
        status: "cancelled",
        title: activityLabels.cancelled,
        completedAt: event.createdAt,
      });
    case "run.waiting_input":
      return upsert(items, {
        ...base,
        id: `run:${runId ?? event.seq}`,
        kind: "waiting_input",
        status: "waiting",
        title: activityLabels.waitingInput,
      });
    case "thread.progress": {
      if (payload?.activity !== true) return items;
      const label = planProgressLabel(String(payload?.text ?? ""));
      if (!label) return items;
      const kind =
        label === activityLabels.planning || label === activityLabels.readyToExecute
          ? "planning"
          : "approval";
      return upsert(items, {
        ...base,
        id: `${kind}:${runId ?? event.seq}`,
        kind,
        status: kind === "approval" ? "waiting" : "running",
        title: label,
        startedAt: event.createdAt,
      });
    }
    case "agent.tool.called": {
      const name = str(payload, "name");
      if (!name) return items;
      const executionId = str(payload, "executionId") ?? `${event.seq}`;
      return upsert(items, {
        ...base,
        id: `tool:${runId ?? event.seq}:${executionId}`,
        kind: "tool",
        status: "running",
        title: toolActionLabel(name),
        startedAt: event.createdAt,
      });
    }
    case "agent.tool.completed": {
      const executionId = str(payload, "executionId");
      if (!executionId || !runId) return items;
      const id = `tool:${runId}:${executionId}`;
      const durationMs =
        typeof payload?.durationMs === "number" && payload.durationMs >= 0
          ? payload.durationMs
          : undefined;
      const outcome = str(payload, "outcome");
      return patch(items, id, {
        status: outcome === "error" ? "failed" : "completed",
        completedAt: event.createdAt,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
    case "subagent.started": {
      const taskId = str(payload, "taskId");
      if (!taskId) return items;
      return upsert(
        items,
        backgroundItem(context, taskId, runId ?? "", event.botId, "running", {
          startedAt: event.createdAt,
          taskId,
        }),
      );
    }
    case "subagent.completed":
    case "subagent.failed":
    case "subagent.cancelled": {
      const taskId = str(payload, "taskId");
      if (!taskId) return items;
      const status =
        event.type === "subagent.completed"
          ? "completed"
          : event.type === "subagent.cancelled"
            ? "cancelled"
            : "failed";
      return upsert(
        items,
        backgroundItem(context, taskId, runId ?? "", event.botId, status, {
          completedAt: event.createdAt,
          detail: status === "failed" ? clipDetail(payload?.error) : undefined,
        }),
      );
    }
    case "subagent.progress":
      // Progress text is helper chatter; the card stays "Working in background".
      return items;
    case "thread.subagent": {
      const status = str(payload, "status") ?? "running";
      const agentId = str(payload, "agentId");
      if (!agentId) return items;
      // Background tasks announce via thread.subagent with agentId carrying
      // the taskId, right after subagent.started created the background card.
      // Never render the same helper twice (§49.9-style dedupe).
      if (items.some((item) => item.id === `bg:${agentId}`)) return items;
      const id = `helper:${runId ?? event.seq}:${agentId}`;
      const done = status === "completed" || status === "failed" || status === "cancelled";
      return upsert(items, {
        ...base,
        id,
        kind: "research",
        status: done
          ? status === "completed"
            ? "completed"
            : status === "cancelled"
              ? "cancelled"
              : "failed"
          : "running",
        title: activityLabels.researching,
        startedAt: event.createdAt,
        ...(done ? { completedAt: event.createdAt } : {}),
      });
    }
    case "thread.collaboration.requested": {
      const fromBotId = str(payload, "fromBotId") ?? event.botId;
      const toBotId = str(payload, "toBotId");
      const fromRunId = str(payload, "fromRunId");
      const toRunId = str(payload, "toRunId");
      if (!toBotId || !toRunId) return items;
      const intent = str(payload, "intent");
      const name = botName(context, toBotId);
      return upsert(items, {
        ...base,
        // Grouped under the requesting owner's run (§36): the support work is
        // part of the requester's turn, not a competing conversation.
        id: `collab:${toRunId}`,
        runId: fromRunId ?? runId,
        botId: fromBotId,
        kind: "delegation",
        status: "running",
        title: intent === "question" ? askedQuestionLabel(name) : askedForHelpLabel(name),
        target: { botId: toBotId, name },
        startedAt: event.createdAt,
      });
    }
    case "thread.collaboration.result": {
      const fromBotId = str(payload, "fromBotId") ?? event.botId;
      const fromRunId = str(payload, "fromRunId");
      const toRunId = str(payload, "toRunId");
      const name = botName(context, fromBotId);
      let next = items;
      if (fromRunId) {
        // Close the matching "Asked X for help" item.
        next = patch(next, `collab:${fromRunId}`, {
          status: "completed",
          completedAt: event.createdAt,
        });
      }
      return upsert(next, {
        ...base,
        id: `result:${toRunId ?? `${fromRunId ?? event.seq}`}`,
        runId: toRunId ?? runId,
        kind: "delegation",
        status: "completed",
        title: returnedResultLabel(name),
        actor: { botId: fromBotId, name },
        completedAt: event.createdAt,
      });
    }
    case "thread.turn.handed_off": {
      const fromBotId = str(payload, "fromBotId") ?? event.botId;
      const toBotId = str(payload, "toBotId");
      const fromRunId = str(payload, "fromRunId");
      const toRunId = str(payload, "toRunId");
      if (!toBotId) return items;
      return upsert(items, {
        ...base,
        id: `handoff:${fromRunId ?? runId ?? event.seq}:${toRunId ?? toBotId}`,
        runId: fromRunId ?? runId,
        botId: fromBotId,
        kind: "handoff",
        status: "completed",
        title: handedToLabel(botName(context, toBotId)),
        actor: { botId: fromBotId, name: botName(context, fromBotId) },
        target: { botId: toBotId, name: botName(context, toBotId) },
        completedAt: event.createdAt,
      });
    }
    default:
      // thread.turn.routed and everything else: state-only or dedicated UI (§53).
      return items;
  }
}

/**
 * Full projection: durable state seed + bounded event replay. The server uses
 * this for ThreadSnapshot.activity; clients reuse reduceActivity for live SSE.
 */
export function projectActivity(
  events: readonly ActivitySourceEvent[],
  context: ActivityProjectionContext,
): ActivityItem[] {
  let items = seedActivityFromContext(context);
  for (const event of events) {
    items = reduceActivity(items, event, context);
  }
  return items;
}

/**
 * One-line current activity for sidebar rows (§27/§28): the most recent
 * meaningful item, or a status-derived label. Never raw prompts.
 */
export function currentActivityLine(
  items: readonly ActivityItem[],
  runId: string,
): { kind: ActivityItem["kind"]; text: string } | null {
  const own = items.filter((item) => item.runId === runId);
  for (let i = own.length - 1; i >= 0; i -= 1) {
    const item = own[i]!;
    if (item.status === "running" || item.status === "waiting") {
      return { kind: item.kind, text: item.title };
    }
  }
  const last = own[own.length - 1];
  return last ? { kind: last.kind, text: last.title } : null;
}

