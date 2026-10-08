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
