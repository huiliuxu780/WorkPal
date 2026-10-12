import * as z from "zod";
import { Id } from "./ids.js";

export const InterventionKindSchema = z.enum(["approval", "input"]);
export type InterventionKind = z.infer<typeof InterventionKindSchema>;

export const InterventionStatusSchema = z.enum([
  "pending",
  "answered",
  "expired",
  "cancelled",
  "superseded",
]);
export type InterventionStatus = z.infer<typeof InterventionStatusSchema>;

export const InterventionInputModeSchema = z.enum(["text", "choice", "secret"]);
export type InterventionInputMode = z.infer<typeof InterventionInputModeSchema>;

export const InterventionDecisionSchema = z.enum(["approved", "denied"]);
export type InterventionDecision = z.infer<typeof InterventionDecisionSchema>;

const InterventionActionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string(),
  })
  .strict();

/**
 * Read model for one Intervention. Approval decision and effect execution
 * status are separate. The projection never carries an answer body, a secret,
 * or ExternalEffect request/result payloads.
 */
export const InterventionViewSchema = z
  .object({
    id: Id,
    revision: z.number().int().positive(),
    kind: InterventionKindSchema,
    status: InterventionStatusSchema,
    spaceId: Id,
    threadId: Id,
    runId: Id,
    attemptId: Id,
    botId: Id,
    messageId: Id,
    createdAt: z.string(),
    expiresAt: z.string().optional(),
    resolvedAt: z.string().optional(),
    resolvedByUserId: Id.optional(),
    supersededById: Id.optional(),
    requestingActor: z
      .object({
        botId: Id,
        agentId: Id.optional(),
        backgroundTaskId: Id.optional(),
      })
      .strict(),
    input: z
      .object({
        mode: InterventionInputModeSchema,
        purpose: z.enum(["otp", "password", "api_key"]).optional(),
        actions: z.array(InterventionActionSchema).optional(),
      })
      .strict()
      .optional(),
    approval: z
      .object({
        effectId: Id,
        decision: InterventionDecisionSchema.optional(),
        effectStatus: z.string().min(1),
        /** Redacted ask-block actions. Labels are not ExternalEffect bodies. */
        actions: z.array(InterventionActionSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type InterventionView = z.infer<typeof InterventionViewSchema>;

/** Public lifecycle event. Strict so answer text and effect bodies cannot ride along. */
export const InterventionEventPayloadSchema = z
  .object({
    interventionId: Id,
    revision: z.number().int().positive(),
    kind: InterventionKindSchema,
    status: InterventionStatusSchema,
    runId: Id,
    attemptId: Id,
    messageId: Id,
    botId: Id,
    createdAt: z.string(),
    expiresAt: z.string().optional(),
    resolvedAt: z.string().optional(),
    resolvedByUserId: Id.optional(),
    actor: z
      .object({
        botId: Id,
        agentId: Id.optional(),
        backgroundTaskId: Id.optional(),
      })
      .strict(),
    input: z
      .object({
        mode: InterventionInputModeSchema,
        purpose: z.enum(["otp", "password", "api_key"]).optional(),
        actions: z.array(InterventionActionSchema).optional(),
      })
      .strict()
      .optional(),
    approval: z
      .object({
        effectId: Id,
        decision: InterventionDecisionSchema.optional(),
        effectStatus: z.string().min(1),
        actions: z.array(InterventionActionSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type InterventionEventPayload = z.infer<typeof InterventionEventPayloadSchema>;

export const ResolveInterventionResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("accepted"),
    intervention: InterventionViewSchema,
  }),
  z.object({
    outcome: z.literal("already_handled"),
    intervention: InterventionViewSchema,
  }),
]);
export type ResolveInterventionResult = z.infer<typeof ResolveInterventionResultSchema>;

/** Deterministic id for a pending ask that predates the interventions table. */
export function legacyInterventionId(messageId: string): string {
  return `legacy_${messageId}`;
}
