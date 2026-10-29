import * as z from "zod";
import { ActivityItemSchema } from "./activity.js";
import {
  DisplayBlockSchema,
  InteractionCapabilitiesSchema,
  InteractionViewSchema,
} from "./card-interaction.js";
import { MessageBlock } from "./events.js";
import { Id, RunStatus, RunTrigger, WaitKind } from "./ids.js";
import { InterventionViewSchema } from "./intervention.js";
import { ManualRetryDenyReason } from "./manual-retry.js";
import { PlanReviewStateSchema, RunPlanRevisionSchema } from "./run-plans.js";
import { RunStepSnapshotSchema } from "./run-steps.js";
import { RunTodoSnapshotSchema } from "./run-todos.js";

/**
 * ExecutionSnapshot: the per-Run server-side read model for one execution
 * (HISTORY-001). It composes the existing durable facts — Run/Attempt, Events,
 * RunPlan/Step/Todo, Activity projection, Intervention views, the final
 * result Message, and Artifact metadata — into one product projection.
 *
 * It is a READ MODEL. Nothing here is a second source of execution truth, and
 * no write path maintains a snapshot document. Server fields carry semantic
 * values only (durations in ms, stable status enums, entry kinds); display
 * wording stays in the Web i18n layer.
 */

export const ExecutionEntrySchema = z.enum(["execution", "result", "collaboration"]);
export type ExecutionEntry = z.infer<typeof ExecutionEntrySchema>;

export const ExecutionSectionSchema = z.enum([
  "plan",
  "steps",
  "todos",
  "activity",
  "interventions",
  "result",
  "artifacts",
]);
export type ExecutionSection = z.infer<typeof ExecutionSectionSchema>;

/** Artifact names listed on a summary; the true total rides on counts. */
export const MAX_SUMMARY_ARTIFACTS = 20;

export const ExecutionSummarySchema = z.strictObject({
  runId: Id,
  threadId: Id,
  botId: Id,
  /**
   * Server fact (PD-01P): the message that triggered this Run — the durable
   * `runs.sourceMessageId` link, not an inference from message order, Bot
   * names, or timestamps. One message may own zero, one, or several Runs (a
   * multi-Bot group turn creates one Run per dispatched Bot), so clients must
   * read this field instead of treating `Message.runId` as exhaustive; that
   * legacy column still names the first Run for old clients. Manual-retry
   * successors inherit the predecessor's source message, so they stay linked
   * to the same trigger. Omitted when the Run has no triggering message.
   */
  sourceMessageId: Id.optional(),
  /**
   * Stable monotonic version of the visible projection: the highest product
   * event seq attributed to this Run (0 when none survive, e.g. after a
   * Thread clear). Re-reads of the same commit yield the same value; other
   * Runs' and ordinary chat writes never move it.
   */
  rev: z.number().int().nonnegative(),
  status: RunStatus,
  waitKind: WaitKind.nullable().optional(),
  trigger: RunTrigger,
  /** One-line task title from durable facts (Task prompt / peer message). */
  title: z.string(),
  /** Short excerpt of the Run's real result message. Never generated. */
  outcome: z.string().optional(),
  /** User-safe failure text (existing mapping); never the runtime's raw error. */
  failure: z.string().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  /**
   * Last recorded update of the Run: its newest product event time, or its
   * creation time when no event survives. Never the raw `runs.updatedAt` —
   * invisible row writes (lease renewal) must not move a contract field that
   * `rev` is supposed to pin down. One rev ⇒ one summary content.
   */
  updatedAt: z.string(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Trusted counts only; an unknown count is omitted, never reported as 0. */
  counts: z
    .strictObject({
      steps: z.number().int().nonnegative().optional(),
      actions: z.number().int().nonnegative().optional(),
      agents: z.number().int().nonnegative().optional(),
      artifacts: z.number().int().nonnegative().optional(),
    })
    .optional(),
  artifacts: z
    .array(
      z.strictObject({
        id: Id,
        name: z.string(),
        mimeType: z.string().optional(),
      }),
    )
    .max(MAX_SUMMARY_ARTIFACTS),
  entry: ExecutionEntrySchema,
  /** Server-chosen transcript anchor; the Web no longer scans messages for it. */
  anchorMessageId: Id.optional(),
  /** Sections the server knows are incomplete for this view (truncated/missing). */
  incompleteSections: z.array(ExecutionSectionSchema).optional(),
  /** Predecessor in the manual-retry chain; omitted when this Run is not a retry. */
  retryOfRunId: Id.optional(),
  /** Direct successor created by a later manual retry; omitted when none exists. */
  retrySuccessorRunId: Id.optional(),
  /** Completed Run this amendment follow-up reviews; omitted for other Runs. */
  followUpOfRunId: Id.optional(),
  /** Follow-up created by a later amendment; omitted when none exists. */
  followUpSuccessorRunId: Id.optional(),
  /** Whether the actor may request a manual retry of this Run. */
  manualRetry: z
    .strictObject({
      allowed: z.boolean(),
      reason: ManualRetryDenyReason.optional(),
    })
    .optional(),
});
export type ExecutionSummary = z.infer<typeof ExecutionSummarySchema>;

export const ACTIVITY_PAGE_DEFAULT_LIMIT = 50;
export const ACTIVITY_PAGE_MAX_LIMIT = 100;

/**
 * One page of the Run's Activity projection, newest first beyond the visible
 * window. `items` are the shared safe ActivityItem projection — never raw
 * Event payloads. `olderCursor` null means there is no older data; an unknown
 * total is omitted, never guessed.
 */
export const ExecutionActivityPageSchema = z.strictObject({
  items: z.array(ActivityItemSchema),
  olderCursor: z.string().nullable(),
  /** True when older matching events exist beyond this page. */
  truncated: z.boolean(),
  total: z.number().int().nonnegative().optional(),
});
export type ExecutionActivityPage = z.infer<typeof ExecutionActivityPageSchema>;

/** Bounded scan window used to build one Activity page server-side. */
export const ACTIVITY_SCAN_LIMIT = 400;

/** The Run's committed result message. Absent means no result exists yet. */
export const ExecutionResultSchema = z.strictObject({
  messageId: Id,
  /** Existing serialized + redacted MessageBlock vocabulary. */
  blocks: z.array(MessageBlock),
  truncated: z.boolean(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const ExecutionStepsViewSchema = z.strictObject({
  items: z.array(RunStepSnapshotSchema),
  total: z.number().int().nonnegative().optional(),
  truncated: z.boolean(),
});

export const ExecutionTodosViewSchema = z.strictObject({
  items: z.array(RunTodoSnapshotSchema),
  total: z.number().int().nonnegative().optional(),
  truncated: z.boolean(),
});

/** Per-section caps for the detail read; overflow flips `truncated`. */
export const EXECUTION_STEPS_LIMIT = 200;
export const EXECUTION_TODOS_LIMIT = 200;
/** A few product-semantic nodes, never a copy of the event log. */
export const EXECUTION_TIMELINE_LIMIT = 24;
export const EXECUTION_SUMMARY_WINDOW = 50;

export const ExecutionSnapshotSchema = z.strictObject({
  summary: ExecutionSummarySchema,
  plan: RunPlanRevisionSchema.optional(),
  /**
   * UX-02: plan-level review state (content version vs approval basis) next to
   * the current revision. Absent for runs without a plan and for legacy plans
   * that predate unified review and never opened a review round.
   */
  planReview: PlanReviewStateSchema.optional(),
  steps: ExecutionStepsViewSchema,
  todos: ExecutionTodosViewSchema,
  /** Recent durable product nodes for this Run, newest last. */
  timeline: z.array(ActivityItemSchema).max(EXECUTION_TIMELINE_LIMIT),
  /** Head page of the Activity timeline (newest window). */
  activityPage: ExecutionActivityPageSchema,
  /** All Interventions of this Run inside the snapshot windows. */
  interventions: z.array(InterventionViewSchema),
  /** CARD-01A projection; present only when cards_unified_v2 is enabled. */
  interactionCapabilities: InteractionCapabilitiesSchema.optional(),
  interactions: z.array(InteractionViewSchema).optional(),
  displayBlocks: z.array(DisplayBlockSchema).optional(),
  result: ExecutionResultSchema.optional(),
});
export type ExecutionSnapshot = z.infer<typeof ExecutionSnapshotSchema>;
