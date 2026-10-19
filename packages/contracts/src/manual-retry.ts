import * as z from "zod";
import { Id } from "./ids.js";

export const ManualRetryDenyReason = z.enum([
  "not_found",
  "forbidden",
  "not_root",
  "not_terminal",
  "completed",
  "ineligible_trigger",
  "thread_cleared",
  "bot_unavailable",
  "thread_busy",
  "already_active",
]);
export type ManualRetryDenyReason = z.infer<typeof ManualRetryDenyReason>;

export const ManualRetryProjectionSchema = z.strictObject({
  allowed: z.boolean(),
  reason: ManualRetryDenyReason.optional(),
});
export type ManualRetryProjection = z.infer<typeof ManualRetryProjectionSchema>;

export const ManualRetryInputSchema = z.strictObject({
  runId: Id,
  clientNonce: z.string().min(1).max(200),
});
export type ManualRetryInput = z.infer<typeof ManualRetryInputSchema>;

export const ManualRetryOutputSchema = z.strictObject({
  sourceRunId: Id,
  runId: Id,
  taskId: Id,
  threadId: Id,
  botId: Id,
  replayed: z.boolean(),
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("bot"), botId: Id }),
    z.strictObject({ kind: z.literal("group"), groupId: Id }),
  ]),
});
export type ManualRetryOutput = z.infer<typeof ManualRetryOutputSchema>;

export const MANUAL_RETRY_EFFECT_AUTHORIZED = "manual_retry_authorized";
export const MANUAL_RETRY_EFFECT_CANCELLED = "manual_retry_cancelled";
export const MANUAL_RETRY_EFFECT_CONFIRMED = "manual_retry_confirmed";

export const MANUAL_RETRY_CHOICE_CONFIRM = "confirm_completed";
export const MANUAL_RETRY_CHOICE_AUTHORIZE = "authorize_retry";
export const MANUAL_RETRY_CHOICE_CANCEL = "cancel";
