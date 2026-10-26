import * as z from "zod";

/**
 * A10 outbound drafts. Revisions are immutable: saving stores a new row and
 * only the latest pending revision may be decided. The fingerprint is the
 * decision binding — it covers exactly the content the user confirmed.
 */
export const OUTBOUND_DRAFT_MAX_RECIPIENTS = 20;
export const OUTBOUND_DRAFT_MAX_SUBJECT_CHARS = 200;
export const OUTBOUND_DRAFT_MAX_BODY_CHARS = 65_536;

export const OutboundDraftChannelSchema = z.enum(["email"]);
export type OutboundDraftChannel = z.infer<typeof OutboundDraftChannelSchema>;

export const OutboundDraftRecipientSchema = z.string().trim().min(3).max(320);

export const OutboundDraftContentSchema = z.strictObject({
  recipients: z.array(OutboundDraftRecipientSchema).min(1).max(OUTBOUND_DRAFT_MAX_RECIPIENTS),
  subject: z.string().trim().min(1).max(OUTBOUND_DRAFT_MAX_SUBJECT_CHARS),
  body: z.string().trim().min(1).max(OUTBOUND_DRAFT_MAX_BODY_CHARS),
});
export type OutboundDraftContent = z.infer<typeof OutboundDraftContentSchema>;

export const OutboundDraftSchema = z.strictObject({
  revision: z.number().int().positive(),
  fingerprint: z.string().min(8).max(128),
  ...OutboundDraftContentSchema.shape,
});
export type OutboundDraft = z.infer<typeof OutboundDraftSchema>;

export const OutboundDraftRevisionStatusSchema = z.enum(["pending", "superseded"]);

export const OutboundDraftRevisionMetaSchema = z.strictObject({
  revision: z.number().int().positive(),
  fingerprint: z.string().min(8).max(128),
  subject: z.string().min(1).max(OUTBOUND_DRAFT_MAX_SUBJECT_CHARS),
  createdAt: z.string(),
  status: OutboundDraftRevisionStatusSchema,
});
export type OutboundDraftRevisionMeta = z.infer<typeof OutboundDraftRevisionMetaSchema>;

/** What the card loads and what an edit RPC returns. */
export const OutboundDraftStateSchema = z.strictObject({
  channel: OutboundDraftChannelSchema,
  draft: OutboundDraftSchema,
  revisions: z.array(OutboundDraftRevisionMetaSchema).max(100),
});
export type OutboundDraftState = z.infer<typeof OutboundDraftStateSchema>;
