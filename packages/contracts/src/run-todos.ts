import { z } from "zod";
import { Id, IsoDate } from "./ids.js";

export const RunTodoStatusSchema = z.enum(["pending", "active", "resolved", "deferred"]);

export const PublishRunTodoInputSchema = z.strictObject({
  todoId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  expectedRevision: z.number().int().nonnegative(),
  order: z.number().int().nonnegative().max(999),
  title: z.string().trim().min(1).max(200),
  status: RunTodoStatusSchema,
  linkedStepId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type PublishRunTodoInput = z.infer<typeof PublishRunTodoInputSchema>;

export const RunTodoSnapshotSchema = z.strictObject({
  todoId: Id,
  runId: Id,
  sourceMessageId: Id.nullable(),
  revision: z.number().int().positive(),
  order: z.number().int().nonnegative(),
  title: z.string().min(1),
  status: RunTodoStatusSchema,
  linkedStepId: Id.nullable(),
  reason: z.string().nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type RunTodoSnapshot = z.infer<typeof RunTodoSnapshotSchema>;
