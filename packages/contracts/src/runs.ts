import * as z from "zod";
import { Id, RunStatus } from "./ids.js";

export const RunActivityRowSchema = z.object({
  runId: Id,
  botId: Id,
  botName: z.string(),
  groupId: Id.nullable(),
  groupName: z.string().nullable(),
  threadId: Id,
  status: RunStatus,
  trigger: z.enum([
    "user",
    "routine",
    "resume",
    "follow_up",
    "reaction",
    "call_end",
    "spawn",
    "skill",
    "bot_message",
    "webhook",
    "messaging",
    "cloud_agent",
    "created",
  ]),
  notificationsEnabled: z.boolean(),
  promptSnippet: z.string(),
  /** Projected current activity (§28); sidebar prefers it over promptSnippet. */
  activity: z
    .object({
      kind: z.enum([
        "working",
        "planning",
        "approval",
        "tool",
        "research",
        "delegation",
        "handoff",
        "background",
        "waiting_input",
        "waiting_takeover",
        "completed",
        "failed",
        "cancelled",
      ]),
      text: z.string(),
    })
    .optional(),
  updatedAt: z.string(),
});
export type RunActivityRow = z.infer<typeof RunActivityRowSchema>;

export const RunsListOutputSchema = z.object({
  runs: z.array(RunActivityRowSchema),
});
export type RunsListOutput = z.infer<typeof RunsListOutputSchema>;

/** One execution attempt inside a run (fence = retry ordinal). */
export const RunAttemptRowSchema = z.object({
  fence: z.number().int(),
  status: z.string(),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type RunAttemptRow = z.infer<typeof RunAttemptRowSchema>;

/** External side effect recorded against a run (see ExternalEffect). */
export const RunEffectRowSchema = z.object({
  effectId: Id,
  kind: z.string(),
  status: z.string(),
  request: z.unknown(),
  result: z.unknown().nullable(),
  createdAt: z.string(),
});
export type RunEffectRow = z.infer<typeof RunEffectRowSchema>;

/** Earlier execution of the same routine, newest first (routine runs only). */
export const RunHistoryRowSchema = z.object({
  runId: Id,
  status: RunStatus,
  promptSnippet: z.string(),
  at: z.string(),
});
export type RunHistoryRow = z.infer<typeof RunHistoryRowSchema>;

export const RunsDetailOutputSchema = z.object({
  run: z.object({
    runId: Id,
    botId: Id,
    botName: z.string(),
    botColor: z.string(),
    threadId: Id,
    status: RunStatus,
    trigger: RunActivityRowSchema.shape.trigger,
    notificationsEnabled: z.boolean(),
    promptSnippet: z.string(),
    error: z.string().nullable(),
    routineId: Id.nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    updatedAt: z.string(),
  }),
  attempts: z.array(RunAttemptRowSchema),
  effects: z.array(RunEffectRowSchema),
  history: z.array(RunHistoryRowSchema),
});
export type RunsDetailOutput = z.infer<typeof RunsDetailOutputSchema>;
