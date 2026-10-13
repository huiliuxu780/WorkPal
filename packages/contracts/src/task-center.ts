import * as z from "zod";
import { ExecutionSummarySchema } from "./execution-snapshot.js";
import { Id } from "./ids.js";

/**
 * Task Center: the cross-conversation second entry to EXISTING root Runs.
 * It is an index and navigation surface only — no second Task/Run entity,
 * no Task Center lifecycle, no state machine parallel to `Run.status`.
 * `ExecutionSummary` stays the single status-summary source; this contract
 * adds only the authorized navigation target around it.
 *
 * Percentage progress is deliberately absent: production has no trusted
 * server-owned processed/total contract, and an unknown is omitted entirely
 * (never 0%, "--" or a guess).
 */

export const TASK_CENTER_DEFAULT_LIMIT = 30;
export const TASK_CENTER_MAX_LIMIT = 100;
/** Bounded recent-terminal window (mirrors the HISTORY-001 thread window). */
export const TASK_CENTER_TERMINAL_WINDOW = 50;

/** The authorized conversation the Run belongs to; resolved server-side. */
export const TaskCenterTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("bot"), botId: Id }),
  z.strictObject({ kind: z.literal("group"), groupId: Id }),
]);
export type TaskCenterTarget = z.infer<typeof TaskCenterTargetSchema>;

export const TaskCenterItemSchema = z.strictObject({
  /** The existing HISTORY-001 summary; never a second DTO of its fields. */
  summary: ExecutionSummarySchema,
  target: TaskCenterTargetSchema,
});
export type TaskCenterItem = z.infer<typeof TaskCenterItemSchema>;

export const TaskCenterPageSchema = z.strictObject({
  items: z.array(TaskCenterItemSchema),
  /**
   * Opaque, versioned, actor-bound server cursor; the Web never parses it.
   * Null means there is no next page.
   */
  nextCursor: z.string().nullable(),
  /**
   * Authoritative count of active + waiting root Runs, computed with the
   * same authorization and generation rules as the list. 0 renders no badge.
   */
  activeCount: z.number().int().nonnegative(),
});
export type TaskCenterPage = z.infer<typeof TaskCenterPageSchema>;
