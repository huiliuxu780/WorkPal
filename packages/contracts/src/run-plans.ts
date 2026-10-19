import { z } from "zod";
import { Id, IsoDate } from "./ids.js";

export const PlanItemStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "skipped",
  "superseded",
  "unresolved",
]);
export type PlanItemStatus = z.infer<typeof PlanItemStatusSchema>;

export const PlanItemSchema = z.strictObject({
  id: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(200),
  status: PlanItemStatusSchema,
  reason: z.string().trim().min(1).max(500).optional(),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

/** A complete, immutable product Plan revision. Native plan_write Markdown is not this contract. */
export const RunPlanRevisionSchema = z.strictObject({
  planId: Id,
  runId: Id,
  sourceMessageId: Id.nullable(),
  revisionId: Id,
  revision: z.number().int().positive(),
  goal: z.string().trim().min(1).max(1000),
  items: z.array(PlanItemSchema).min(1).max(20),
  changeReason: z.string().trim().min(1).max(500).nullable(),
  createdAt: IsoDate,
});
export type RunPlanRevision = z.infer<typeof RunPlanRevisionSchema>;

export const PublishRunPlanInputSchema = z
  .strictObject({
    expectedRevision: z.number().int().nonnegative(),
    goal: z.string().trim().min(1).max(1000),
    items: z.array(PlanItemSchema).min(1).max(20),
    changeReason: z.string().trim().min(1).max(500).optional(),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of value.items.entries()) {
      if (seen.has(item.id))
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: "Duplicate Plan item id",
        });
      seen.add(item.id);
    }
    if (value.expectedRevision > 0 && !value.changeReason) {
      ctx.addIssue({
        code: "custom",
        path: ["changeReason"],
        message: "A revision needs a change reason",
      });
    }
  });
export type PublishRunPlanInput = z.infer<typeof PublishRunPlanInputSchema>;

/**
 * UX-02 unified plan review. One plan identity per Run; PostgreSQL carries the
 * authoritative content version, approval basis, and review state. The native
 * PLAN.md workspace file and PlanModeContextState are recoverable projections
 * of the same plan, never a second approvable truth.
 *
 * - `contentVersion` is the approval basis: it advances only when the
 *   normalized content (goal + item ids/titles/order) changes.
 * - `revision` is the execution-progress axis: every recorded change advances
 *   it, including pure item-status updates that never re-open a review.
 * - `reviewStatus` is null only on rows that predate unified review (legacy
 *   plans keep executing under their grandfathered basis; their next content
 *   change opens the first real review).
 */
export const PlanReviewStatusSchema = z.enum([
  "draft",
  "pending",
  "approved",
  "changes_requested",
  "rejected",
  "cancelled",
]);
export type PlanReviewStatus = z.infer<typeof PlanReviewStatusSchema>;

/** The three fixed review actions. There is deliberately no "always allow". */
export const PlanReviewDecisionSchema = z.enum(["approve", "request_changes", "reject"]);
export type PlanReviewDecision = z.infer<typeof PlanReviewDecisionSchema>;

/** Which unified entry submitted the content version for review. */
export const PlanReviewSourceSchema = z.enum([
  "plan_exit",
  "plan_write",
  "publish_run_plan",
  "legacy_native",
]);
export type PlanReviewSource = z.infer<typeof PlanReviewSourceSchema>;

/**
 * The exact content a reviewer is deciding on, bound to the review card so a
 * stale click can never approve a newer version. Items are the whitelisted
 * display projection (id/title/status only — no reasons or evidence).
 */
export const PlanReviewContentSchema = z
  .object({
    planId: Id,
    contentVersion: z.number().int().positive(),
    revision: z.number().int().positive(),
    goal: z.string().min(1).max(1000),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            title: z.string().min(1).max(200),
            status: PlanItemStatusSchema,
          })
          .strict(),
      )
      .min(1)
      .max(20),
    source: PlanReviewSourceSchema,
  })
  .strict();
export type PlanReviewContent = z.infer<typeof PlanReviewContentSchema>;

/** Plan-level review state carried on snapshots next to the current revision. */
export const PlanReviewStateSchema = z
  .object({
    planId: Id,
    /** Content version of the current revision. */
    contentVersion: z.number().int().positive(),
    reviewStatus: PlanReviewStatusSchema,
    /** Content version the current execution authorization is based on. */
    approvedContentVersion: z.number().int().positive().nullable(),
    revision: z.number().int().positive(),
    /** Feedback of the most recent changes_requested/rejected round, if any. */
    feedback: z.string().max(2000).nullable(),
  })
  .strict();
export type PlanReviewState = z.infer<typeof PlanReviewStateSchema>;

/** Native plan_write/plan_exit facade inputs (structured, backend-validated). */
export const PlanWriteInputSchema = PublishRunPlanInputSchema;
export type PlanWriteInput = z.infer<typeof PlanWriteInputSchema>;

export const PlanExitInputSchema = z.strictObject({
  summary: z.string().trim().max(500).optional(),
});
export type PlanExitInput = z.infer<typeof PlanExitInputSchema>;

export const PlanEnterInputSchema = z.strictObject({
  reason: z.string().trim().max(500).optional(),
});
export type PlanEnterInput = z.infer<typeof PlanEnterInputSchema>;
