import { z } from "zod";
import type {
  BackgroundJob,
  BackgroundJobHandlers,
  BackgroundJobName,
  BackgroundJobPayloads,
} from "./types.js";

const payloadSchemas = {
  "run.continue": z.object({ runId: z.string().min(1) }),
  "routine.wakeup": z.object({
    routineId: z.string().min(1),
    scheduledFor: z.string().datetime({ offset: true }),
  }),
  "computer.update": z.object({ updateId: z.string().min(1) }),
  "computer.sleep": z.object({ computerId: z.string().min(1) }),
  "computer.control-expire": z.object({
    computerId: z.string().min(1),
    leaseId: z.string().min(1),
  }),
  "skill.teaching-expire": z.object({ skillId: z.string().min(1) }),
  "history.compact": z.object({
    threadId: z.string().min(1),
    sourceRunId: z.string().min(1).optional(),
    modelProvider: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
  }),
  "memory.extract": z.object({ threadId: z.string().min(1) }),
  "memory.summary": z.object({
    spaceId: z.string().min(1),
    recipientUserId: z.string().min(1),
    recipientBotId: z.string().min(1),
  }),
  "memory.outbox": z.object({}),
  "messaging.deliver": z.object({ runId: z.string().min(1).optional() }),
  "delivery.dispatch": z.object({}),
  "cloud_agent.poll": z.object({ agentId: z.string().min(1) }),
} satisfies { [Name in BackgroundJobName]: z.ZodType<BackgroundJobPayloads[Name]> };

export function parseBackgroundJob(name: string, payload: unknown): BackgroundJob {
  if (!(name in payloadSchemas)) throw new Error(`Unknown background job: ${name}`);
  const typedName = name as BackgroundJobName;
  const parsed = payloadSchemas[typedName].parse(payload);
  return { name: typedName, payload: parsed } as BackgroundJob;
}

export async function dispatchBackgroundJob(
  handlers: BackgroundJobHandlers,
  name: string,
  payload: unknown,
): Promise<void> {
  const job = parseBackgroundJob(name, payload);
  const handler = handlers[job.name] as (payload: typeof job.payload) => Promise<void>;
  await handler(job.payload);
}

export function runJobKey(runId: string): string {
  return `run:${runId}`;
}

export function routineJobKey(routineId: string): string {
  return `routine:${routineId}`;
}

export function computerSleepJobKey(computerId: string): string {
  return `computer.sleep:${computerId}`;
}

export function computerControlExpireJobKey(computerId: string, leaseId?: string): string {
  return leaseId
    ? `computer.control-expire:${computerId}:${leaseId}`
    : `computer.control-expire:${computerId}`;
}

export function skillTeachingExpireJobKey(skillId: string): string {
  return `skill.teaching-expire:${skillId}`;
}

export function runContinueJob(runId: string): BackgroundJob {
  return {
    name: "run.continue",
    payload: { runId },
    replaceKey: runJobKey(runId),
  };
}

export function routineWakeupJob(routineId: string, scheduledFor: Date): BackgroundJob {
  return {
    name: "routine.wakeup",
    payload: { routineId, scheduledFor: scheduledFor.toISOString() },
    availableAt: scheduledFor,
    replaceKey: routineJobKey(routineId),
  };
}

export function computerSleepJob(computerId: string, availableAt: Date): BackgroundJob {
  return {
    name: "computer.sleep",
    payload: { computerId },
    availableAt,
    replaceKey: computerSleepJobKey(computerId),
  };
}

export function computerControlExpireJob(
  computerId: string,
  leaseId: string,
  availableAt: Date,
): BackgroundJob {
  return {
    name: "computer.control-expire",
    payload: { computerId, leaseId },
    availableAt,
    replaceKey: computerControlExpireJobKey(computerId, leaseId),
  };
}

export function skillTeachingExpireJob(skillId: string, availableAt: Date): BackgroundJob {
  return {
    name: "skill.teaching-expire",
    payload: { skillId },
    availableAt,
    replaceKey: skillTeachingExpireJobKey(skillId),
  };
}

export function historyCompactJobKey(threadId: string): string {
  return `history.compact:${threadId}`;
}

/**
 * Each attempt runs a summarizer completion that can take up to the summarizer
 * timeout, so the job queue's default attempt count turns one permanently
 * failing thread into hours of paid retries. A few tries ride out transient
 * provider errors without storming.
 */
export const HISTORY_COMPACT_MAX_ATTEMPTS = 4;

export function messagingDeliverJob(runId?: string, availableAt?: Date): BackgroundJob {
  return {
    name: "messaging.deliver",
    payload: runId ? { runId } : {},
    replaceKey: `messaging.deliver:${runId ?? "drain"}`,
    ...(availableAt ? { availableAt } : {}),
  };
}

export function deliveryDispatchJob(availableAt?: Date): BackgroundJob {
  return {
    name: "delivery.dispatch",
    payload: {},
    replaceKey: "delivery.dispatch:drain",
    ...(availableAt ? { availableAt } : {}),
  };
}

/**
 * `pinnedModel` fixes the summarizer identity at enqueue time (ME-02 M4): the
 * most recent completed main-conversation Run covering the batch tail. The
 * handler must resolve credentials for exactly this identity and fail loudly
 * when they are gone — a later bot-model change must not redirect the job.
 */
export function historyCompactJob(
  threadId: string,
  pinnedModel?: { modelProvider: string; modelId: string; sourceRunId?: string },
): BackgroundJob {
  return {
    name: "history.compact",
    payload: pinnedModel
      ? {
          threadId,
          ...(pinnedModel.sourceRunId ? { sourceRunId: pinnedModel.sourceRunId } : {}),
          modelProvider: pinnedModel.modelProvider,
          modelId: pinnedModel.modelId,
        }
      : { threadId },
    replaceKey: historyCompactJobKey(threadId),
    maxAttempts: HISTORY_COMPACT_MAX_ATTEMPTS,
  };
}

export function memoryExtractJobKey(threadId: string): string {
  return `memory.extract:${threadId}`;
}

/**
 * Extraction attempts one bounded model call; the periodic sweep re-enqueues
 * threads that still lag, so a failed attempt must not storm paid retries.
 */
export const MEMORY_EXTRACT_MAX_ATTEMPTS = 3;

export function memoryExtractJob(threadId: string, availableAt?: Date): BackgroundJob {
  return {
    name: "memory.extract",
    payload: { threadId },
    replaceKey: memoryExtractJobKey(threadId),
    maxAttempts: MEMORY_EXTRACT_MAX_ATTEMPTS,
    ...(availableAt ? { availableAt } : {}),
  };
}

export function memorySummaryJobKey(recipientUserId: string, recipientBotId: string): string {
  return `memory.summary:${recipientUserId}:${recipientBotId}`;
}

export const MEMORY_SUMMARY_MAX_ATTEMPTS = 3;

export function memorySummaryJob(
  payload: BackgroundJobPayloads["memory.summary"],
  availableAt?: Date,
): BackgroundJob {
  return {
    name: "memory.summary",
    payload,
    replaceKey: memorySummaryJobKey(payload.recipientUserId, payload.recipientBotId),
    maxAttempts: MEMORY_SUMMARY_MAX_ATTEMPTS,
    ...(availableAt ? { availableAt } : {}),
  };
}

export function memoryOutboxJob(availableAt?: Date): BackgroundJob {
  return {
    name: "memory.outbox",
    payload: {},
    replaceKey: "memory.outbox:drain",
    ...(availableAt ? { availableAt } : {}),
  };
}

export function cloudAgentPollJobKey(agentId: string): string {
  return `cloud_agent.poll:${agentId}`;
}

export function cloudAgentPollJob(
  payload: BackgroundJobPayloads["cloud_agent.poll"],
  availableAt?: Date,
): BackgroundJob {
  return {
    name: "cloud_agent.poll",
    payload,
    replaceKey: cloudAgentPollJobKey(payload.agentId),
    ...(availableAt ? { availableAt } : {}),
  };
}
