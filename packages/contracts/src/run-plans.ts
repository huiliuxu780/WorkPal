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
