import * as z from "zod";
import type { MessageBlock } from "./events.js";
import { Id } from "./ids.js";
import { OutboundDraftStateSchema } from "./outbound-draft.js";
import { PlanReviewContentSchema, PlanReviewDecisionSchema } from "./run-plans.js";

/**
 * `plan_review` is the typed UX-02 waiting reason for a unified plan version
 * review. It rides the existing waiting_input Run status — no new Run state
 * machine branch — and is never a tool authorization: approving a plan version
 * does not approve any tool call, connector, or credential.
 */
export const InterventionKindSchema = z.enum(["approval", "input", "plan_review"]);
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

/** Public display fields for a secret destination: the handle, the site, and
    the auth type. Never a username, a password, a token, or a header value. */
export const InterventionCredentialSchema = z
  .object({
    name: z.string().min(1).max(64),
    origin: z.string().min(1).max(2048),
    authType: z.enum(["bearer", "header", "basic", "login"]),
  })
  .strict();
export type InterventionCredential = z.infer<typeof InterventionCredentialSchema>;

export const MAX_PRESENTATION_TEXT_CHARS = 4_000;
export const MAX_PRESENTATION_DETAIL_CHARS = 8_000;
export const MAX_PLAN_REVIEW_FEEDBACK_CHARS = 2_000;

/**
 * Plan-review projection on an Intervention: the exact version the reviewer
 * saw (so a stale card can never approve newer content), plus the recorded
 * decision and feedback once settled. Backend-projected state only — never
 * inferred from Markdown or tool logs.
 */
export const InterventionPlanReviewSchema = z
  .object({
    content: PlanReviewContentSchema,
    decision: PlanReviewDecisionSchema.optional(),
    feedback: z.string().max(MAX_PLAN_REVIEW_FEEDBACK_CHARS).optional(),
  })
  .strict();
export type InterventionPlanReview = z.infer<typeof InterventionPlanReviewSchema>;

/**
 * Sanitized display snapshot persisted on the Intervention row. The card
 * renders from this alone, so a request stays complete after a refresh even
 * when its source message left the current page. Strict whitelist: no answer
 * plaintext, no secret, no ExternalEffect request/result bodies.
 */
export const InterventionPresentationSchema = z
  .object({
    /** The question the user must answer. */
    text: z.string().max(MAX_PRESENTATION_TEXT_CHARS),
    /** Approval scope/risk preview or extra explanation. */
    detail: z.string().max(MAX_PRESENTATION_DETAIL_CHARS).optional(),
    credential: InterventionCredentialSchema.optional(),
  })
  .strict();
export type InterventionPresentation = z.infer<typeof InterventionPresentationSchema>;

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
        /**
         * A10: the immutable outbound draft revisions. Only approval rows backed
         * by an outbound effect carry it; other approvals stay preview-only.
         */
        outbound: OutboundDraftStateSchema.optional(),
      })
      .strict()
      .optional(),
    planReview: InterventionPlanReviewSchema.optional(),
    presentation: InterventionPresentationSchema.optional(),
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
    planReview: InterventionPlanReviewSchema.optional(),
    presentation: InterventionPresentationSchema.optional(),
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

/**
 * Project one Ask block onto the presentation whitelist. Only the question,
 * the safe detail preview, and public credential display fields survive;
 * answers, secrets, and credential identities never enter the snapshot.
 */
export function presentationFromAskBlock(
  ask: Extract<MessageBlock, { kind: "ask" }>,
): InterventionPresentation {
  const presentation: InterventionPresentation = {
    text: ask.text.slice(0, MAX_PRESENTATION_TEXT_CHARS),
  };
  if (ask.detail) presentation.detail = ask.detail.slice(0, MAX_PRESENTATION_DETAIL_CHARS);
  if (ask.credential) {
    presentation.credential = {
      name: ask.credential.name,
      origin: ask.credential.origin,
      authType: ask.credential.auth.type,
    };
  }
  return InterventionPresentationSchema.parse(presentation);
}
