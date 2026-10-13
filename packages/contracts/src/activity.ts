import { z } from "zod";
import { Id } from "./ids.js";

/**
 * Product Harness Phase 4 activity projection (§3): the product-semantic view
 * of what an agent is doing. Projected server-side from persisted events and
 * mirrored here for the wire; never a stored entity, never runtime internals.
 */
export const ActivityKindSchema = z.enum([
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
]);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export const ActivityStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;

export const ActivityItemSchema = z.strictObject({
  id: z.string(),
  runId: Id.optional(),
  botId: Id,
  threadId: Id,
  kind: ActivityKindSchema,
  status: ActivityStatusSchema,
  title: z.string(),
  detail: z.string().optional(),
  actor: z.object({ botId: Id, name: z.string().optional() }).optional(),
  target: z.object({ botId: Id, name: z.string().optional() }).optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  count: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Background tasks only, while cancelable. */
  taskId: z.string().optional(),
  collapsible: z.boolean().optional(),
  // v1 projections are flat; grouping is expressed via ActivityGroup on the
  // consumer side, so no recursive children on the wire.
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;
