import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/**
 * ME-01/ME-02 memory fact contracts. Facts are the first-party atomic memory
 * records; candidates never enter the injection read path until confirmed.
 * Mutations carry expectedRevision so two open pages cannot silently
 * overwrite each other — a stale write returns an actionable conflict result
 * instead of an opaque error.
 */

export const MemoryFactStateSchema = z.enum([
  "candidate",
  "active",
  "superseded",
  "deleted",
  "rejected",
]);
export type MemoryFactState = z.infer<typeof MemoryFactStateSchema>;

export const MemoryFactOriginSchema = z.enum([
  "user_direct",
  "user_confirmed",
  "model_candidate",
  "legacy_import",
]);
export type MemoryFactOrigin = z.infer<typeof MemoryFactOriginSchema>;

export const MemoryFactScopeKindSchema = z.enum(["bot", "user", "space"]);
export type MemoryFactScopeKind = z.infer<typeof MemoryFactScopeKindSchema>;

export const MEMORY_FACT_MAX_TEXT_CHARS = 500;
export const MEMORY_FACT_MAX_LITERAL_ENTRIES = 10;
export const MEMORY_FACT_MAX_LITERAL_VALUE_CHARS = 200;

export const MemoryFactLiteralValuesSchema = z
  .record(z.string().max(40), z.string().max(MEMORY_FACT_MAX_LITERAL_VALUE_CHARS))
  .refine((value) => Object.keys(value).length <= MEMORY_FACT_MAX_LITERAL_ENTRIES, {
    message: `literalValues supports at most ${MEMORY_FACT_MAX_LITERAL_ENTRIES} entries`,
  })
  .nullable();
export type MemoryFactLiteralValues = z.infer<typeof MemoryFactLiteralValuesSchema>;

export const MemoryFactSchema = z.strictObject({
  id: Id,
  scopeKind: MemoryFactScopeKindSchema,
  scopeId: Id,
  kind: z.string(),
  text: z.string(),
  literalValues: MemoryFactLiteralValuesSchema,
  language: z.string().nullable(),
  origin: MemoryFactOriginSchema,
  state: MemoryFactStateSchema,
  revision: z.number().int(),
  ownerUserId: Id,
  botId: Id.nullable(),
  validFrom: IsoDate.nullable(),
  expiresAt: IsoDate.nullable(),
  /** True when expiresAt has passed at read time; such facts never inject. */
  expired: z.boolean(),
  learnedAt: IsoDate,
  lastConfirmedAt: IsoDate.nullable(),
  updatedAt: IsoDate,
  /** Distinct threads with accessible trusted evidence — the display gate for
   * model-inferred candidates (four independent threads). */
  evidenceThreadCount: z.number().int(),
  evidenceCount: z.number().int(),
  supersedesFactId: Id.nullable(),
  promotionSourceFactId: Id.nullable(),
  sourceDocumentId: Id.nullable(),
  /** External index cleanup for this fact is still queued or retrying. */
  indexCleanupPending: z.boolean(),
});
export type MemoryFactDto = z.infer<typeof MemoryFactSchema>;

export const MemoryFactEvidenceSchema = z.strictObject({
  id: Id,
  threadId: Id,
  messageId: Id.nullable(),
  messageSeq: z.number().int(),
  threadGeneration: z.number().int(),
  authorUserId: Id,
  originKind: z.string(),
  evidenceType: z.string(),
  /** False once the source was deleted or the thread cleared; such evidence
   * no longer counts toward candidate eligibility. */
  accessible: z.boolean(),
  capturedAt: IsoDate,
});
export type MemoryFactEvidenceDto = z.infer<typeof MemoryFactEvidenceSchema>;

export const MemoryFactListInputSchema = z.strictObject({
  botId: Id.optional(),
  states: z.array(MemoryFactStateSchema).min(1).optional(),
  includeExpired: z.boolean().optional(),
});
export type MemoryFactListInput = z.infer<typeof MemoryFactListInputSchema>;

export const MemoryFactListOutputSchema = z.strictObject({
  facts: z.array(MemoryFactSchema),
});
export type MemoryFactListOutput = z.infer<typeof MemoryFactListOutputSchema>;

export const MemoryFactGetInputSchema = z.strictObject({
  factId: Id,
  botId: Id.optional(),
});
export type MemoryFactGetInput = z.infer<typeof MemoryFactGetInputSchema>;

export const MemoryFactGetOutputSchema = z.strictObject({
  fact: MemoryFactSchema,
  evidence: z.array(MemoryFactEvidenceSchema),
});
export type MemoryFactGetOutput = z.infer<typeof MemoryFactGetOutputSchema>;

export const MemoryFactCreateInputSchema = z.strictObject({
  /** Direct creation is limited to the actor's personal scopes; space-scope
   * facts only exist through per-item promotion. */
  scopeKind: z.enum(["bot", "user"]),
  botId: Id.optional(),
  text: z.string().min(1).max(MEMORY_FACT_MAX_TEXT_CHARS),
  kind: z.string().min(1).max(40).optional(),
  literalValues: MemoryFactLiteralValuesSchema.optional(),
});
export type MemoryFactCreateInput = z.infer<typeof MemoryFactCreateInputSchema>;

export const MemoryFactConfirmInputSchema = z.strictObject({
  factId: Id,
  expectedRevision: z.number().int().nonnegative(),
});
export type MemoryFactConfirmInput = z.infer<typeof MemoryFactConfirmInputSchema>;

export const MemoryFactCorrectInputSchema = z.strictObject({
  factId: Id,
  expectedRevision: z.number().int().nonnegative(),
  text: z.string().min(1).max(MEMORY_FACT_MAX_TEXT_CHARS).optional(),
  literalValues: MemoryFactLiteralValuesSchema.optional(),
  expiresAt: IsoDate.nullable().optional(),
  reason: z.string().max(200).optional(),
});
export type MemoryFactCorrectInput = z.infer<typeof MemoryFactCorrectInputSchema>;

export const MemoryFactRejectInputSchema = z.strictObject({
  factId: Id,
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().max(200).optional(),
});
export type MemoryFactRejectInput = z.infer<typeof MemoryFactRejectInputSchema>;

export const MemoryFactDeleteInputSchema = z.strictObject({
  factId: Id,
  expectedRevision: z.number().int().nonnegative(),
});
export type MemoryFactDeleteInput = z.infer<typeof MemoryFactDeleteInputSchema>;

export const MemoryFactPromoteInputSchema = z.strictObject({
  factId: Id,
  expectedRevision: z.number().int().nonnegative(),
});
export type MemoryFactPromoteInput = z.infer<typeof MemoryFactPromoteInputSchema>;

export const MemoryFactImportLegacyInputSchema = z.strictObject({
  documentId: Id,
  /** Optional user-confirmed wording; defaults to the document content. */
  text: z.string().min(1).max(MEMORY_FACT_MAX_TEXT_CHARS).optional(),
});
export type MemoryFactImportLegacyInput = z.infer<typeof MemoryFactImportLegacyInputSchema>;

export const MemoryFactMutationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("updated"), fact: MemoryFactSchema }),
  z.strictObject({ status: z.literal("replayed"), fact: MemoryFactSchema }),
  z.strictObject({
    status: z.literal("conflict"),
    currentRevision: z.number().int(),
    fact: MemoryFactSchema.nullable(),
  }),
  z.strictObject({ status: z.literal("invalid_state"), fact: MemoryFactSchema }),
]);
export type MemoryFactMutationResult = z.infer<typeof MemoryFactMutationResultSchema>;

export const MemoryFactEvidenceListInputSchema = z.strictObject({ factId: Id });
export type MemoryFactEvidenceListInput = z.infer<typeof MemoryFactEvidenceListInputSchema>;

export const MemorySummarySchema = z.strictObject({
  /** A version-matching generated summary exists. */
  available: z.boolean(),
  /** Recorded source versions no longer match the current shards; the summary
   * is refused for injection and will be rebuilt. */
  stale: z.boolean(),
  content: z.string().nullable(),
  generatedAt: IsoDate.nullable(),
  summaryModel: z.string().nullable(),
  promptVersion: z.string().nullable(),
  tokenEstimate: z.number().int().nullable(),
  shardVersions: z.record(z.string(), z.number().int()),
});
export type MemorySummaryDto = z.infer<typeof MemorySummarySchema>;

export const MemorySummaryGetInputSchema = z.strictObject({ botId: Id });
export type MemorySummaryGetInput = z.infer<typeof MemorySummaryGetInputSchema>;

export const MemoryAutoExtractionSchema = z.enum(["off", "on", "paused"]);
export type MemoryAutoExtraction = z.infer<typeof MemoryAutoExtractionSchema>;

export const MemoryPolicySchema = z.strictObject({
  autoExtraction: MemoryAutoExtractionSchema,
});
export type MemoryPolicyDto = z.infer<typeof MemoryPolicySchema>;

export const MemoryPolicySetInputSchema = z.strictObject({
  autoExtraction: MemoryAutoExtractionSchema,
});
export type MemoryPolicySetInput = z.infer<typeof MemoryPolicySetInputSchema>;
