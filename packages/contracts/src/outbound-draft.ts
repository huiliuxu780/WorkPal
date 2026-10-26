import * as z from "zod";

/**
 * A10 outbound drafts. Revisions are immutable: saving stores a new row and
 * only the latest pending revision may be decided. The fingerprint is the
 * decision binding — it covers exactly the content the user confirmed.
 */
export const OUTBOUND_DRAFT_MAX_RECIPIENTS = 20;
export const OUTBOUND_DRAFT_MAX_SUBJECT_CHARS = 200;
export const OUTBOUND_DRAFT_MAX_BODY_CHARS = 65_536;
export const OUTBOUND_DRAFT_MAX_BODY_BYTES = 65_536;
export const OUTBOUND_DRAFT_RECIPIENT_MAX_CHARS = 320;
/** Mirrors the production mail sender's recipient parser. */
export const OUTBOUND_DRAFT_RECIPIENT_PATTERN =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export type OutboundDraftRecipientIssue = "empty" | "too_many" | "invalid" | "duplicate";

/** Same acceptance rules as validateOutgoingMail(), for pre-save editors. */
export function outboundDraftRecipientIssue(
  recipients: readonly string[],
): OutboundDraftRecipientIssue | null {
  const values = recipients.map((address) => address.trim());
  if (values.length === 0) return "empty";
  if (values.length > OUTBOUND_DRAFT_MAX_RECIPIENTS) return "too_many";
  if (
    values.some(
      (address) =>
        address.length === 0 ||
        address.length > OUTBOUND_DRAFT_RECIPIENT_MAX_CHARS ||
        !OUTBOUND_DRAFT_RECIPIENT_PATTERN.test(address),
    )
  ) {
    return "invalid";
  }
  if (new Set(values).size !== values.length) return "duplicate";
  return null;
}

export const OutboundDraftChannelSchema = z.enum(["email"]);
export type OutboundDraftChannel = z.infer<typeof OutboundDraftChannelSchema>;

export const OutboundDraftRecipientSchema = z
  .string()
  .trim()
  .min(3)
  .max(OUTBOUND_DRAFT_RECIPIENT_MAX_CHARS)
  .regex(OUTBOUND_DRAFT_RECIPIENT_PATTERN, "Invalid email address");

export const OutboundDraftRecipientsSchema = z
  .array(OutboundDraftRecipientSchema)
  .min(1)
  .max(OUTBOUND_DRAFT_MAX_RECIPIENTS)
  .refine((recipients) => new Set(recipients).size === recipients.length, {
    message: "Recipient addresses must be unique.",
  });

export function outboundDraftBodyBytes(body: string): number {
  return new TextEncoder().encode(body).length;
}

export const OutboundDraftBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(OUTBOUND_DRAFT_MAX_BODY_CHARS)
  .refine((body) => outboundDraftBodyBytes(body) <= OUTBOUND_DRAFT_MAX_BODY_BYTES, {
    message: "The email body must be at most 64 KB.",
  });

export const OutboundDraftContentSchema = z.strictObject({
  recipients: OutboundDraftRecipientsSchema,
  subject: z.string().trim().min(1).max(OUTBOUND_DRAFT_MAX_SUBJECT_CHARS),
  body: OutboundDraftBodySchema,
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
