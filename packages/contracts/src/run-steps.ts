import { z } from "zod";
import { Id, IsoDate } from "./ids.js";

export const RunStepStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "retrying",
  "skipped",
  "cancelled",
  "blocked",
]);

export const RunStepEvidenceSchema = z.strictObject({
  kind: z.enum(["tool_event", "external_effect", "artifact"]),
  id: Id,
});

export const RunStepBatchSchema = z
  .strictObject({
    processed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().optional(),
    unit: z.string().trim().min(1).max(40),
  })
  .refine((value) => value.total === undefined || value.processed <= value.total, {
    message: "Processed count cannot exceed total",
    path: ["processed"],
  });

export const PublishRunStepInputSchema = z
  .strictObject({
    stepId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    expectedRevision: z.number().int().nonnegative(),
    order: z.number().int().nonnegative().max(999),
    title: z.string().trim().min(1).max(200),
    status: RunStepStatusSchema,
    resultSummary: z.string().trim().min(1).max(500).optional(),
    planItemId: z.string().min(1).max(64).optional(),
    parentStepId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
    evidence: z.array(RunStepEvidenceSchema).max(10).optional(),
  })
  .refine((value) => value.parentStepId !== value.stepId, {
    message: "A Step cannot parent itself",
    path: ["parentStepId"],
  });
export type PublishRunStepInput = z.infer<typeof PublishRunStepInputSchema>;

export const RunStepSnapshotSchema = z.strictObject({
  stepId: Id,
  runId: Id,
  sourceMessageId: Id.nullable(),
  revision: z.number().int().positive(),
  order: z.number().int().nonnegative(),
  title: z.string().min(1),
  /** `unknown` is a read projection when the Run ended without a Step terminal event. */
  status: RunStepStatusSchema.or(z.literal("unknown")),
  resultSummary: z.string().nullable(),
  planItemId: Id.nullable(),
  parentStepId: Id.nullable(),
  attemptId: Id.nullable(),
  attemptNumber: z.number().int().positive().nullable(),
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
  evidence: z.array(RunStepEvidenceSchema),
  batch: RunStepBatchSchema.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type RunStepSnapshot = z.infer<typeof RunStepSnapshotSchema>;
