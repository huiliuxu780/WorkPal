import type {
  ContextSummary,
  MemoryEvidence,
  MemoryFact,
  MemoryJobOutbox,
  MemoryShard,
  PrismaClient,
} from "./generated/prisma/client.js";
import { Prisma } from "./generated/prisma/client.js";

type FactJsonInput = Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;

function asJsonInput(value: Prisma.JsonValue | null | undefined): FactJsonInput {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}
import { canonicalKeyFor, sourceVersionDigest } from "./memory-digest.js";

/**
 * ME-01/ME-02 first-party fact repository. PostgreSQL is the authority for
 * facts, revisions, evidence and audits; every mutation that changes the
 * visible fact set bumps the owning shard version and writes the summary /
 * index outbox in the same transaction. Model calls never happen in here.
 */

export const MEMORY_FACT_STATES = [
  "candidate",
  "active",
  "superseded",
  "deleted",
  "rejected",
  /** legacy_import only: the import was undone; the source document returns
   * to the legacy injection path. Distinct from "deleted" — deleting an
   * imported fact must NOT resurrect the legacy document. */
  "reverted",
] as const;
export type MemoryFactState = (typeof MEMORY_FACT_STATES)[number];

export const MEMORY_FACT_ORIGINS = [
  "user_direct",
  "user_confirmed",
  "model_candidate",
  "legacy_import",
] as const;
export type MemoryFactOrigin = (typeof MEMORY_FACT_ORIGINS)[number];

export const MEMORY_SCOPE_KINDS = ["bot", "user", "space"] as const;
export type MemoryScopeKind = (typeof MEMORY_SCOPE_KINDS)[number];

/** Facts are short single assertions; the repository refuses transcripts. */
export const MEMORY_FACT_MAX_TEXT_CHARS = 500;
export const MEMORY_FACT_MAX_LITERAL_ENTRIES = 10;
export const MEMORY_FACT_MAX_LITERAL_KEY_CHARS = 40;
export const MEMORY_FACT_MAX_LITERAL_VALUE_CHARS = 200;

export interface FactScope {
  spaceId: string;
  scopeKind: MemoryScopeKind;
  scopeId: string;
}

/** scopeKey is only ever built from backend-validated entity ids. */
export function memoryScopeKey(scopeKind: MemoryScopeKind, scopeId: string): string {
  if (!scopeId || scopeId.includes(":") || scopeId.trim() !== scopeId) {
    throw new Error(`Invalid memory scope entity id for kind ${scopeKind}`);
  }
  return `${scopeKind}:${scopeId}`;
}

export function factScopeKey(scope: FactScope): string {
  return memoryScopeKey(scope.scopeKind, scope.scopeId);
}

export interface FactEvidenceInput {
  /** Null for non-message evidence such as legacy document imports. */
  threadId?: string | null;
  threadGeneration: number;
  messageId?: string | null;
  messageSeq?: number | null;
  authorUserId: string;
  originKind: string;
  evidenceType: string;
  sourceDigest: string;
}

export interface CreateFactInput {
  scope: FactScope;
  ownerUserId: string;
  botId?: string | null;
  kind: string;
  text: string;
  language?: string | null;
  literalValues?: unknown;
  origin: MemoryFactOrigin;
  /** candidate rows never enter the read path; explicit user entries activate once. */
  state?: "candidate" | "active";
  validFrom?: Date | null;
  expiresAt?: Date | null;
  actorUserId: string;
  sourceRunId?: string | null;
  supersedesFactId?: string | null;
  promotionSourceFactId?: string | null;
  sourceDocumentId?: string | null;
  evidence?: FactEvidenceInput[];
}

export type CreateFactResult =
  | { status: "created"; fact: MemoryFact }
  | { status: "duplicate"; fact: MemoryFact }
  | { status: "merged"; fact: MemoryFact }
  | { status: "blocked_by_user_fact"; fact: MemoryFact };

async function markSupersededInTransaction(
  tx: Prisma.TransactionClient,
  oldFactId: string,
  newFactId: string,
  actorUserId: string,
): Promise<void> {
  const old = await tx.memoryFact.findFirst({ where: { id: oldFactId, state: "active" } });
  if (!old) return;
  await tx.$queryRaw`SELECT id FROM memory_facts WHERE id = ${old.id} FOR UPDATE`;
  const revision = old.revision + 1;
  const updated = await tx.memoryFact.update({
    where: { id: old.id },
    data: { state: "superseded", revision, lastChangedBy: actorUserId },
  });
  await tx.memoryFactRevision.create({
    data: {
      factId: old.id,
      revision,
      state: "superseded",
      text: old.text,
      kind: old.kind,
      changedBy: actorUserId,
      reason: `superseded_by:${newFactId}`,
    },
  });
  const scope: FactScope = {
    spaceId: old.spaceId,
    scopeKind: old.scopeKind as MemoryScopeKind,
    scopeId: old.scopeKey.slice(old.scopeKind.length + 1),
  };
  const { shardId } = await lockShardAndBump(tx, scope);
  await enqueueMemoryJobsInTransaction(tx, factChangeOutboxJobs(updated, shardId));
}

export interface FactMutationRef {
  spaceId: string;
  actorUserId: string;
  factId: string;
  expectedRevision: number;
}

export type FactMutationResult =
  | { status: "updated"; fact: MemoryFact }
  | { status: "replayed"; fact: MemoryFact }
  | { status: "conflict"; currentRevision: number; fact: MemoryFact | null }
  | { status: "not_found" }
  | { status: "invalid_state"; fact: MemoryFact };

function validateFactText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Memory fact text must not be empty");
  if (trimmed.length > MEMORY_FACT_MAX_TEXT_CHARS) {
    throw new Error(
      `Memory fact text exceeds ${MEMORY_FACT_MAX_TEXT_CHARS} characters; summarize the proposition`,
    );
  }
  return trimmed;
}

/** Restricted structured literals: string values only, bounded keys/lengths. */
export function sanitizeLiteralValues(input: unknown): FactJsonInput {
  if (input === null || input === undefined) return Prisma.DbNull;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("literalValues must be a JSON object of restricted string values");
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MEMORY_FACT_MAX_LITERAL_ENTRIES) {
    throw new Error(`literalValues supports at most ${MEMORY_FACT_MAX_LITERAL_ENTRIES} entries`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.length > MEMORY_FACT_MAX_LITERAL_KEY_CHARS) {
      throw new Error("literalValues key too long");
    }
    if (typeof value !== "string" || value.length > MEMORY_FACT_MAX_LITERAL_VALUE_CHARS) {
      throw new Error("literalValues entries must be short strings");
    }
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? Prisma.DbNull : (out as Prisma.InputJsonValue);
}

async function lockShardAndBump(
  tx: Prisma.TransactionClient,
  scope: FactScope,
): Promise<{ shardId: string; version: number }> {
  const spaceId = scope.spaceId;
  const scopeKind = scope.scopeKind;
  const scopeKey = factScopeKey(scope);
  const where = { spaceId_scopeKind_scopeKey: { spaceId, scopeKind, scopeKey } } as const;
  try {
    await tx.memoryShard.upsert({ where, create: { spaceId, scopeKind, scopeKey }, update: {} });
  } catch (error) {
    // Lost a create race with a concurrent writer; the row exists now.
    if (
      !(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "P2002"
      )
    ) {
      throw error;
    }
  }
  const shard = await tx.memoryShard.findUniqueOrThrow({ where });
  // Serialize concurrent fact mutations for one scope on the shard row so the
  // version bump and the expectedRevision checks stay atomic.
  await tx.$queryRaw`SELECT id FROM memory_shards WHERE id = ${shard.id} FOR UPDATE`;
  const bumped = await tx.memoryShard.update({
    where: { id: shard.id },
    data: { version: { increment: 1 } },
  });
  return { shardId: bumped.id, version: bumped.version };
}

export async function enqueueMemoryJobsInTransaction(
  tx: Prisma.TransactionClient,
  jobs: Array<{
    kind: string;
    spaceId: string;
    targetId: string;
    payload: Prisma.InputJsonValue;
    sourceVersionDigest?: string;
  }>,
): Promise<void> {
  for (const job of jobs) {
    await tx.memoryJobOutbox.upsert({
      where: {
        kind_targetId_sourceVersionDigest: {
          kind: job.kind,
          targetId: job.targetId,
          sourceVersionDigest: job.sourceVersionDigest ?? "",
        },
      },
      create: {
        kind: job.kind,
        spaceId: job.spaceId,
        targetId: job.targetId,
        payload: job.payload,
        sourceVersionDigest: job.sourceVersionDigest ?? "",
      },
      update: {
        // Re-arm an existing pending row; never roll back attempts accounting.
        payload: job.payload,
        nextAttemptAt: new Date(),
      },
    });
  }
}

function factChangeOutboxJobs(
  fact: { id: string; spaceId: string; state: string },
  shardId: string,
): Array<{ kind: string; spaceId: string; targetId: string; payload: Prisma.InputJsonValue }> {
  const jobs: Array<{
    kind: string;
    spaceId: string;
    targetId: string;
    payload: Prisma.InputJsonValue;
  }> = [
    {
      kind: "shard_profile_rebuild",
      spaceId: fact.spaceId,
      targetId: shardId,
      payload: { shardId } as Prisma.InputJsonValue,
    },
    {
      kind: "summary_rebuild",
      spaceId: fact.spaceId,
      targetId: `shard:${shardId}`,
      payload: { shardId } as Prisma.InputJsonValue,
    },
  ];
  if (fact.state === "deleted") {
    jobs.push({
      kind: "index_cleanup",
      spaceId: fact.spaceId,
      targetId: fact.id,
      payload: { factId: fact.id } as Prisma.InputJsonValue,
    });
  } else if (fact.state === "active") {
    jobs.push({
      kind: "index_projection",
      spaceId: fact.spaceId,
      targetId: fact.id,
      payload: { factId: fact.id } as Prisma.InputJsonValue,
    });
  }
  return jobs;
}

async function insertEvidence(
  tx: Prisma.TransactionClient,
  factId: string,
  evidence: FactEvidenceInput[],
): Promise<void> {
  for (const item of evidence) {
    await tx.memoryEvidence
      .create({
        data: {
          factId,
          threadId: item.threadId ?? null,
          threadGeneration: item.threadGeneration,
          messageId: item.messageId ?? null,
          messageSeq: item.messageSeq ?? null,
          authorUserId: item.authorUserId,
          originKind: item.originKind,
          evidenceType: item.evidenceType,
          sourceDigest: item.sourceDigest,
        },
      })
      // The same message backing the same fact through the same evidence type
      // is a replay, not new evidence.
      .catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: string }).code === "P2002"
        ) {
          return;
        }
        throw error;
      });
  }
}

/**
 * Creates a fact with dedupe against the canonical identity inside its scope.
 * Explicit user entries may activate in one step; model candidates never
 * overwrite a user-confirmed active fact and merge into an existing candidate
 * instead of duplicating it.
 */
export async function createFact(
  prisma: PrismaClient,
  input: CreateFactInput,
): Promise<CreateFactResult> {
  return prisma.$transaction((tx) => createFactInTransaction(tx, input));
}

/**
 * Transaction-scoped variant so a caller can commit the fact together with
 * its own guards (extraction re-checks the thread generation and advances
 * the cursor in the SAME transaction — a late job never commits partially).
 */
export async function createFactInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateFactInput,
): Promise<CreateFactResult> {
  const text = validateFactText(input.text);
  const literalValues = sanitizeLiteralValues(input.literalValues);
  const canonicalKey = canonicalKeyFor(input.kind, text);
  const spaceId = input.scope.spaceId;
  const scopeKind = input.scope.scopeKind;
  const scopeKey = factScopeKey(input.scope);
  const state = input.state ?? "active";
  if (state === "active" && input.origin === "model_candidate") {
    throw new Error("Model-inferred facts must stay candidates until the user confirms");
  }

  {
    const existing = await tx.memoryFact.findFirst({
      where: { spaceId, scopeKind, scopeKey, canonicalKey, state: { in: ["active", "candidate"] } },
      orderBy: { updatedAt: "desc" },
    });

    if (existing && existing.state === "active") {
      if (input.origin === "model_candidate") {
        // Model inference never overrides a remembered fact; a matching active
        // identity means the proposition is already stored.
        return { status: "blocked_by_user_fact" as const, fact: existing };
      }
      // Same canonical identity (kind + normalized text) is an idempotent
      // re-statement: merge new evidence only. Rewording goes through
      // correctFact and proposition replacement through supersedesFactId; a
      // hash match alone must never rewrite a fact silently.
      await insertEvidence(tx, existing.id, input.evidence ?? []);
      return { status: "duplicate" as const, fact: existing };
    }

    if (existing && existing.state === "candidate") {
      // Merge new evidence into the open candidate instead of duplicating it.
      await insertEvidence(tx, existing.id, input.evidence ?? []);
      if (state === "active") {
        // A user confirming by re-stating the same proposition activates it.
        await tx.$queryRaw`SELECT id FROM memory_facts WHERE id = ${existing.id} FOR UPDATE`;
        const revision = existing.revision + 1;
        const activated = await tx.memoryFact.update({
          where: { id: existing.id },
          data: {
            state: "active",
            origin: input.origin === "model_candidate" ? "user_confirmed" : input.origin,
            text,
            revision,
            lastChangedBy: input.actorUserId,
            lastConfirmedAt: new Date(),
          },
        });
        await tx.memoryFactRevision.create({
          data: {
            factId: activated.id,
            revision,
            state: "active",
            text,
            kind: activated.kind,
            changedBy: input.actorUserId,
            reason: "user_activation",
          },
        });
        const { shardId } = await lockShardAndBump(tx, input.scope);
        await enqueueMemoryJobsInTransaction(tx, factChangeOutboxJobs(activated, shardId));
        return { status: "created" as const, fact: activated };
      }
      return { status: "merged" as const, fact: existing };
    }

    const fact = await tx.memoryFact.create({
      data: {
        spaceId,
        ownerUserId: input.ownerUserId,
        ...(input.botId ? { botId: input.botId } : {}),
        scopeKind,
        scopeKey,
        canonicalKey,
        kind: input.kind,
        text,
        ...(input.language ? { language: input.language } : {}),
        literalValues,
        origin: input.origin,
        state,
        revision: 1,
        ...(input.supersedesFactId ? { supersedesFactId: input.supersedesFactId } : {}),
        ...(input.promotionSourceFactId
          ? { promotionSourceFactId: input.promotionSourceFactId }
          : {}),
        ...(input.sourceDocumentId ? { sourceDocumentId: input.sourceDocumentId } : {}),
        ...(input.validFrom ? { validFrom: input.validFrom } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        lastConfirmedAt: state === "active" ? new Date() : null,
        createdBy: input.actorUserId,
        lastChangedBy: input.actorUserId,
        ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      },
    });
    await tx.memoryFactRevision.create({
      data: {
        factId: fact.id,
        revision: 1,
        state,
        text,
        kind: fact.kind,
        literalValues,
        changedBy: input.actorUserId,
        reason: "created",
      },
    });
    await insertEvidence(tx, fact.id, input.evidence ?? []);
    if (state === "active") {
      if (input.supersedesFactId) {
        await markSupersededInTransaction(tx, input.supersedesFactId, fact.id, input.actorUserId);
      }
      const { shardId } = await lockShardAndBump(tx, input.scope);
      await enqueueMemoryJobsInTransaction(tx, factChangeOutboxJobs(fact, shardId));
    } else {
      // Candidates are not in the read path, but keep the shard row present so
      // confirmation can bump a stable scope version.
      await tx.memoryShard.upsert({
        where: { spaceId_scopeKind_scopeKey: { spaceId, scopeKind, scopeKey } },
        create: { spaceId, scopeKind, scopeKey },
        update: {},
      });
    }
    return { status: "created" as const, fact };
  }
}

async function mutateFact(
  prisma: PrismaClient,
  ref: FactMutationRef,
  mutate: (args: {
    tx: Prisma.TransactionClient;
    fact: MemoryFact;
    scope: FactScope;
  }) => Promise<FactMutationResult>,
): Promise<FactMutationResult> {
  return prisma.$transaction(async (tx) => {
    const fact = await tx.memoryFact.findFirst({
      where: { id: ref.factId, spaceId: ref.spaceId },
    });
    if (!fact) return { status: "not_found" as const };
    await tx.$queryRaw`SELECT id FROM memory_facts WHERE id = ${fact.id} FOR UPDATE`;
    if (fact.revision !== ref.expectedRevision) {
      return { status: "conflict" as const, currentRevision: fact.revision, fact };
    }
    const scope: FactScope = {
      spaceId: fact.spaceId,
      scopeKind: fact.scopeKind as MemoryScopeKind,
      scopeId: fact.scopeKey.slice(fact.scopeKind.length + 1),
    };
    return mutate({ tx, fact, scope });
  });
}

/** Candidate → active after explicit user confirmation. */
export async function confirmFact(
  prisma: PrismaClient,
  ref: FactMutationRef,
): Promise<FactMutationResult> {
  return mutateFact(prisma, ref, async ({ tx, fact, scope }) => {
    if (fact.state === "active" && fact.revision === ref.expectedRevision) {
      return { status: "replayed" as const, fact };
    }
    if (fact.state !== "candidate") return { status: "invalid_state" as const, fact };
    const revision = fact.revision + 1;
    const updated = await tx.memoryFact.update({
      where: { id: fact.id },
      data: {
        state: "active",
        origin: fact.origin === "model_candidate" ? "user_confirmed" : fact.origin,
        revision,
        lastChangedBy: ref.actorUserId,
        lastConfirmedAt: new Date(),
      },
    });
    await tx.memoryFactRevision.create({
      data: {
        factId: fact.id,
        revision,
        state: "active",
        text: fact.text,
        kind: fact.kind,
        literalValues: asJsonInput(fact.literalValues),
        changedBy: ref.actorUserId,
        reason: "user_confirmed",
      },
    });
    const { shardId } = await lockShardAndBump(tx, scope);
    await enqueueMemoryJobsInTransaction(tx, factChangeOutboxJobs(updated, shardId));
    return { status: "updated" as const, fact: updated };
  });
}

/** User correction: new effective revision in place, expected-revision CAS. */
export async function correctFact(
  prisma: PrismaClient,
  ref: FactMutationRef & {
    text?: string;
    kind?: string;
    literalValues?: unknown;
    expiresAt?: Date | null;
    reason?: string;
  },
): Promise<FactMutationResult> {
  const text = ref.text !== undefined ? validateFactText(ref.text) : null;
  const literalValues =
    ref.literalValues !== undefined ? sanitizeLiteralValues(ref.literalValues) : undefined;
  return mutateFact(prisma, ref, async ({ tx, fact, scope }) => {
    if (fact.state === "deleted" || fact.state === "rejected") {
      return { status: "invalid_state" as const, fact };
    }
    const nextText = text ?? fact.text;
    const nextKind = ref.kind ?? fact.kind;
    const nextCanonical =
      nextText === fact.text && nextKind === fact.kind
        ? fact.canonicalKey
        : canonicalKeyFor(nextKind, nextText);
    if (nextCanonical !== fact.canonicalKey) {
      // Changing the proposition identity must not silently collide with a
      // different active fact in the same scope.
      const clash = await tx.memoryFact.findFirst({
        where: {
          spaceId: fact.spaceId,
          scopeKind: fact.scopeKind,
          scopeKey: fact.scopeKey,
          canonicalKey: nextCanonical,
          state: { in: ["active", "candidate"] },
          id: { not: fact.id },
        },
        select: { id: true },
      });
      if (clash) return { status: "invalid_state" as const, fact };
    }
    const revision = fact.revision + 1;
    const updated = await tx.memoryFact.update({
      where: { id: fact.id },
      data: {
        text: nextText,
        kind: nextKind,
        canonicalKey: nextCanonical,
        ...(literalValues !== undefined ? { literalValues } : {}),
        ...(ref.expiresAt !== undefined ? { expiresAt: ref.expiresAt } : {}),
        revision,
        lastChangedBy: ref.actorUserId,
        lastConfirmedAt: fact.state === "active" ? new Date() : fact.lastConfirmedAt,
      },
    });
    await tx.memoryFactRevision.create({
      data: {
        factId: fact.id,
        revision,
        state: fact.state,
        text: nextText,
        kind: nextKind,
        literalValues:
          literalValues === undefined ? asJsonInput(fact.literalValues) : literalValues,
        changedBy: ref.actorUserId,
        reason: ref.reason ?? "user_correction",
      },
    });
    const { shardId } = await lockShardAndBump(tx, scope);
    await enqueueMemoryJobsInTransaction(tx, factChangeOutboxJobs(updated, shardId));
    return { status: "updated" as const, fact: updated };
  });
}

/** Candidate rejection. Kept as a tombstone so periodic scans cannot re-recommend
 * the same stale sources; a new explicit user instruction may create a new version. */
export async function rejectFact(
  prisma: PrismaClient,
  ref: FactMutationRef & { reason?: string },
): Promise<FactMutationResult> {
  return mutateFact(prisma, ref, async ({ tx, fact }) => {
    if (fact.state === "rejected") return { status: "replayed" as const, fact };
    if (fact.state !== "candidate") return { status: "invalid_state" as const, fact };
    const revision = fact.revision + 1;
    const updated = await tx.memoryFact.update({
      where: { id: fact.id },
      data: { state: "rejected", revision, lastChangedBy: ref.actorUserId },
    });
    await tx.memoryFactRevision.create({
      data: {
        factId: fact.id,
        revision,
        state: "rejected",
        text: fact.text,
        kind: fact.kind,
        changedBy: ref.actorUserId,
        reason: ref.reason ?? "user_rejected",
      },
    });
    return { status: "updated" as const, fact: updated };
  });
}

export type DeleteFactResult = FactMutationResult;

/**
 * User delete: tombstone plus body purge. The fact leaves every read path
 * immediately; revision bodies are erased in the same transaction so no copy
 * of the deleted text survives in the audit trail (ids, actor, revision and
 * the delete action are kept). External index cleanup is queued through the
 * outbox and stays visible/retryable on failure.
 */
export async function deleteFact(
  prisma: PrismaClient,
  ref: FactMutationRef & { reason?: string },
): Promise<DeleteFactResult> {
  return mutateFact(prisma, ref, async ({ tx, fact, scope }) => {
    if (fact.state === "deleted" || fact.state === "reverted") {
      return { status: "replayed" as const, fact };
    }
    const wasVisible = fact.state === "active";
    const revision = fact.revision + 1;
    const updated = await tx.memoryFact.update({
      where: { id: fact.id },
      data: {
        state: "deleted",
        text: "",
        literalValues: Prisma.DbNull,
        revision,
        lastChangedBy: ref.actorUserId,
      },
    });
    await tx.memoryFactRevision.create({
      data: {
        factId: fact.id,
        revision,
        state: "deleted",
        text: null,
        kind: fact.kind,
        changedBy: ref.actorUserId,
        reason: ref.reason ?? "user_deleted",
      },
    });
    // Purge bodies from the historical revisions; keep the audit skeleton.
    await tx.memoryFactRevision.updateMany({
      where: { factId: fact.id, revision: { lt: revision } },
      data: { text: null, literalValues: Prisma.DbNull },
    });
    if (wasVisible) {
      const { shardId } = await lockShardAndBump(tx, scope);
      await enqueueMemoryJobsInTransaction(tx, factChangeOutboxJobs(updated, shardId));
    } else {
      // Candidate/rejected rows never entered the index, but queue cleanup so
      // any projected candidate content is provably removed.
      await enqueueMemoryJobsInTransaction(tx, [
        {
          kind: "index_cleanup",
          spaceId: fact.spaceId,
          targetId: fact.id,
          payload: { factId: fact.id } as Prisma.InputJsonValue,
        },
      ]);
    }
    return { status: "updated" as const, fact: updated };
  });
}

/**
 * Creates the replacement fact and marks the old one superseded in the same
 * transaction. Used when a new proposition (different canonical identity)
 * explicitly replaces an old one; the association is kept on both sides.
 */
export async function supersedeFact(
  prisma: PrismaClient,
  input: CreateFactInput & { supersedesFactId: string },
): Promise<CreateFactResult> {
  return createFact(prisma, { ...input, state: "active" });
}

/**
 * Per-item promotion into the Space scope. Creates a new fact with a source
 * link; the caller must have checked the actor's authority over the target
 * scope. Cross-space promotion does not exist.
 */
export async function promoteFactToSpace(
  prisma: PrismaClient,
  ref: FactMutationRef & { targetBotId?: string | null },
): Promise<FactMutationResult> {
  return mutateFact(prisma, ref, async ({ tx, fact }) => {
    if (fact.state !== "active") return { status: "invalid_state" as const, fact };
    if (fact.scopeKind === "space") return { status: "replayed" as const, fact };
    const targetKey = memoryScopeKey("space", fact.spaceId);
    const existing = await tx.memoryFact.findFirst({
      where: {
        spaceId: fact.spaceId,
        scopeKind: "space",
        scopeKey: targetKey,
        canonicalKey: fact.canonicalKey,
        state: { in: ["active", "candidate"] },
      },
    });
    if (existing) return { status: "replayed" as const, fact: existing };
    const promoted = await tx.memoryFact.create({
      data: {
        spaceId: fact.spaceId,
        ownerUserId: fact.ownerUserId,
        botId: ref.targetBotId ?? fact.botId,
        scopeKind: "space",
        scopeKey: targetKey,
        canonicalKey: fact.canonicalKey,
        kind: fact.kind,
        text: fact.text,
        language: fact.language,
        literalValues: asJsonInput(fact.literalValues),
        origin: fact.origin === "model_candidate" ? "user_confirmed" : fact.origin,
        state: "active",
        revision: 1,
        promotionSourceFactId: fact.id,
        learnedAt: fact.learnedAt,
        validFrom: fact.validFrom,
        expiresAt: fact.expiresAt,
        lastConfirmedAt: new Date(),
        createdBy: ref.actorUserId,
        lastChangedBy: ref.actorUserId,
        sourceRunId: fact.sourceRunId,
      },
    });
    await tx.memoryFactRevision.create({
      data: {
        factId: promoted.id,
        revision: 1,
        state: "active",
        text: promoted.text,
        kind: promoted.kind,
        literalValues: asJsonInput(promoted.literalValues),
        changedBy: ref.actorUserId,
        reason: `promoted_from:${fact.id}`,
      },
    });
    const { shardId } = await lockShardAndBump(tx, {
      spaceId: fact.spaceId,
      scopeKind: "space",
      scopeId: fact.spaceId,
    });
    await enqueueMemoryJobsInTransaction(tx, factChangeOutboxJobs(promoted, shardId));
    return { status: "updated" as const, fact: promoted };
  });
}

export interface AuthorizedFactQuery {
  spaceId: string;
  userId: string;
  botId?: string | null;
  /** Default: active only. Management surfaces may request more states. */
  states?: MemoryFactState[];
  now?: Date;
  /** Include time-expired active facts (management view); read path never does. */
  includeExpired?: boolean;
}

function visibleScopeFilter(query: AuthorizedFactQuery): Prisma.MemoryFactWhereInput {
  // User and bot scopes stay private to their owner (matching the legacy
  // per-user memory document visibility); only per-item promoted space-scope
  // facts are shared with every Space member.
  const scopes: Prisma.MemoryFactWhereInput[] = [
    { scopeKind: "user", scopeKey: memoryScopeKey("user", query.userId), ownerUserId: query.userId },
    { scopeKind: "space", scopeKey: memoryScopeKey("space", query.spaceId) },
  ];
  if (query.botId) {
    scopes.push({
      scopeKind: "bot",
      scopeKey: memoryScopeKey("bot", query.botId),
      ownerUserId: query.userId,
    });
  }
  return { OR: scopes };
}

/**
 * Authorized read of the fact set. Personal facts of other users are never
 * visible; a Space membership alone does not authorize user-scope facts of
 * other members. Expired facts are excluded from the injection read path.
 */
export async function listAuthorizedFacts(
  prisma: PrismaClient,
  query: AuthorizedFactQuery,
): Promise<MemoryFact[]> {
  const now = query.now ?? new Date();
  const states = query.states ?? ["active"];
  return prisma.memoryFact.findMany({
    where: {
      spaceId: query.spaceId,
      state: { in: states },
      ...visibleScopeFilter(query),
      ...(query.includeExpired
        ? {}
        : {
            AND: [
              { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
              { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
            ],
          }),
    },
    orderBy: [{ lastConfirmedAt: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
  });
}

export async function getFactForActor(
  prisma: PrismaClient,
  query: {
    spaceId: string;
    userId: string;
    botId?: string | null;
    factId: string;
    /**
     * Deleted facts are excluded from every read surface by default; only the
     * delete/forget paths may see the tombstone so repeats stay idempotent.
     */
    includeDeleted?: boolean;
  },
): Promise<MemoryFact | null> {
  const fact = await prisma.memoryFact.findFirst({
    where: { id: query.factId, spaceId: query.spaceId },
  });
  if (!fact) return null;
  if ((fact.state === "deleted" || fact.state === "reverted") && !query.includeDeleted) return null;
  // Space-scope facts are shared with every member (they only exist through
  // per-item promotion); user and bot scopes stay private to their owner.
  if (fact.scopeKind !== "space" && fact.ownerUserId !== query.userId) return null;
  if (
    fact.scopeKind === "bot" &&
    query.botId &&
    fact.scopeKey !== memoryScopeKey("bot", query.botId)
  ) {
    return null;
  }
  return fact;
}

export async function listFactEvidence(
  prisma: PrismaClient,
  query: { spaceId: string; factId: string },
): Promise<MemoryEvidence[]> {
  return prisma.memoryEvidence.findMany({
    where: { factId: query.factId, fact: { spaceId: query.spaceId } },
    orderBy: { capturedAt: "asc" },
  });
}

/** Distinct threads with accessible trusted evidence — the candidate display gate. */
export async function countDistinctEvidenceThreads(
  prisma: PrismaClient,
  factId: string,
): Promise<number> {
  const rows = await prisma.memoryEvidence.findMany({
    where: { factId, accessible: true },
    select: { threadId: true },
    distinct: ["threadId"],
  });
  return rows.length;
}

/**
 * Resurrection guard: a deleted/rejected fact whose evidence digests cover the
 * proposed sources blocks automatic re-recommendation. A new explicit user
 * instruction bypasses this check at the call site (origin user_direct).
 */
export async function findBlockingTombstone(
  prisma: PrismaClient,
  query: {
    spaceId: string;
    scopeKind: MemoryScopeKind;
    scopeId: string;
    canonicalKey: string;
    evidenceDigests: string[];
  },
): Promise<{ factId: string; state: string } | null> {
  const tombstones = await prisma.memoryFact.findMany({
    where: {
      spaceId: query.spaceId,
      scopeKind: query.scopeKind,
      scopeKey: memoryScopeKey(query.scopeKind, query.scopeId),
      canonicalKey: query.canonicalKey,
      state: { in: ["deleted", "rejected", "superseded"] },
    },
    select: { id: true, state: true },
  });
  if (tombstones.length === 0) return null;
  if (query.evidenceDigests.length === 0) {
    return { factId: tombstones[0]!.id, state: tombstones[0]!.state };
  }
  for (const tombstone of tombstones) {
    const known = await prisma.memoryEvidence.findMany({
      where: { factId: tombstone.id },
      select: { sourceDigest: true },
    });
    const knownDigests = new Set(known.map((row) => row.sourceDigest));
    if (query.evidenceDigests.every((digest) => knownDigests.has(digest))) {
      return { factId: tombstone.id, state: tombstone.state };
    }
  }
  return null;
}

export async function listShardsForScopes(
  prisma: PrismaClient,
  query: { spaceId: string; scopes: Array<{ scopeKind: MemoryScopeKind; scopeId: string }> },
): Promise<MemoryShard[]> {
  const keys = query.scopes.map((scope) => ({
    scopeKind: scope.scopeKind,
    scopeKey: memoryScopeKey(scope.scopeKind, scope.scopeId),
  }));
  if (keys.length === 0) return [];
  return prisma.memoryShard.findMany({
    where: { spaceId: query.spaceId, OR: keys },
  });
}

/**
 * Deterministic shard profile rebuild. profileVersion must equal version for
 * the projection to be readable; the CAS keeps a stale rebuild from
 * overwriting a newer correction.
 */
export async function rebuildShardProfile(
  prisma: PrismaClient,
  shardId: string,
): Promise<{ rebuilt: boolean; version: number }> {
  const shard = await prisma.memoryShard.findUnique({ where: { id: shardId } });
  if (!shard) return { rebuilt: false, version: -1 };
  const facts = await prisma.memoryFact.findMany({
    where: { spaceId: shard.spaceId, scopeKind: shard.scopeKind, scopeKey: shard.scopeKey, state: "active" },
    orderBy: [{ kind: "asc" }, { text: "asc" }],
  });
  const profile = facts
    .map((fact) => `- [${fact.id}] (${fact.kind}) ${fact.text}`)
    .join("\n");
  const updated = await prisma.memoryShard.updateMany({
    where: { id: shardId, version: shard.version },
    data: {
      profileMarkdown: profile,
      profileVersion: shard.version,
      lastRebuiltAt: new Date(),
    },
  });
  return { rebuilt: updated.count > 0, version: shard.version };
}

export interface SummaryPublishInput {
  spaceId: string;
  recipientUserId: string;
  recipientBotId: string;
  sourceVersions: Record<string, number>;
  content: string;
  summaryModel: string;
  promptVersion: string;
  tokenEstimate: number;
}

/** CAS publish keyed on the exact input shard versions. */
export async function publishContextSummary(
  prisma: PrismaClient,
  input: SummaryPublishInput,
): Promise<ContextSummary> {
  const digest = sourceVersionDigest(input.sourceVersions);
  const published = await prisma.contextSummary.upsert({
    where: {
      spaceId_recipientUserId_recipientBotId_sourceVersionDigest: {
        spaceId: input.spaceId,
        recipientUserId: input.recipientUserId,
        recipientBotId: input.recipientBotId,
        sourceVersionDigest: digest,
      },
    },
    create: {
      spaceId: input.spaceId,
      recipientUserId: input.recipientUserId,
      recipientBotId: input.recipientBotId,
      sourceVersions: input.sourceVersions as Prisma.InputJsonValue,
      sourceVersionDigest: digest,
      content: input.content,
      summaryModel: input.summaryModel,
      promptVersion: input.promptVersion,
      tokenEstimate: input.tokenEstimate,
      status: "ready",
    },
    update: {
      content: input.content,
      summaryModel: input.summaryModel,
      promptVersion: input.promptVersion,
      tokenEstimate: input.tokenEstimate,
      status: "ready",
      generatedAt: new Date(),
    },
  });
  // Only the newest matching row is ever read; drop superseded digests so the
  // table cannot grow per fact change.
  await prisma.contextSummary.deleteMany({
    where: {
      spaceId: input.spaceId,
      recipientUserId: input.recipientUserId,
      recipientBotId: input.recipientBotId,
      sourceVersionDigest: { not: digest },
    },
  });
  return published;
}

/**
 * Read the recipient's summary, validating every recorded source version
 * against the current shards. Any mismatch (fact changed, permission scope
 * changed, shard missing) refuses the stale summary instead of injecting it.
 */
export async function loadValidContextSummary(
  prisma: PrismaClient,
  query: {
    spaceId: string;
    recipientUserId: string;
    recipientBotId: string;
    currentShardVersions: Record<string, number>;
  },
): Promise<{ summary: ContextSummary; stale: boolean } | null> {
  const latest = await prisma.contextSummary.findFirst({
    where: {
      spaceId: query.spaceId,
      recipientUserId: query.recipientUserId,
      recipientBotId: query.recipientBotId,
      status: "ready",
    },
    orderBy: { generatedAt: "desc" },
  });
  if (!latest) return null;
  const recorded = latest.sourceVersions as Record<string, number>;
  const recordedKeys = Object.keys(recorded);
  const currentKeys = Object.keys(query.currentShardVersions);
  const stale =
    recordedKeys.length !== currentKeys.length ||
    recordedKeys.some((shardId) => recorded[shardId] !== query.currentShardVersions[shardId]);
  return { summary: latest, stale };
}

export interface OutboxClaim {
  jobs: MemoryJobOutbox[];
}

/** Claim due outbox rows with SKIP LOCKED; consumers delete on success. */
export async function claimMemoryOutboxJobs(
  prisma: PrismaClient,
  options: { workerId: string; limit: number; now?: Date },
): Promise<MemoryJobOutbox[]> {
  const now = options.now ?? new Date();
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE memory_job_outbox
    SET "claimedBy" = ${options.workerId},
        "claimedAt" = ${now},
        attempts = attempts + 1,
        "updatedAt" = ${now}
    WHERE id IN (
      SELECT id FROM memory_job_outbox
      WHERE "nextAttemptAt" <= ${now}
        AND ("claimedBy" IS NULL OR "claimedAt" < ${new Date(now.getTime() - 10 * 60 * 1000)})
      ORDER BY "nextAttemptAt" ASC
      LIMIT ${options.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;
  if (claimed.length === 0) return [];
  return prisma.memoryJobOutbox.findMany({
    where: { id: { in: claimed.map((row) => row.id) } },
  });
}

export async function completeMemoryOutboxJob(
  prisma: PrismaClient,
  jobId: string,
): Promise<void> {
  await prisma.memoryJobOutbox.deleteMany({ where: { id: jobId } });
}

export async function failMemoryOutboxJob(
  prisma: PrismaClient,
  options: { jobId: string; error: string; nextAttemptAt: Date },
): Promise<void> {
  await prisma.memoryJobOutbox.updateMany({
    where: { id: options.jobId },
    data: {
      lastError: options.error.slice(0, 2000),
      nextAttemptAt: options.nextAttemptAt,
      claimedBy: null,
      claimedAt: null,
    },
  });
}

/** Exponential backoff bound: failures stay visible and keep retrying. */
export function memoryOutboxRetryDelay(attempts: number): number {
  return Math.min(60 * 60 * 1000, 10_000 * 2 ** Math.min(attempts, 8));
}

export async function incrementMemoryModelUsage(
  prisma: PrismaClient,
  usage: {
    spaceId: string;
    userId: string;
    day: Date;
    purpose: string;
    calls?: number;
    promptTokens?: number;
    completionTokens?: number;
  },
): Promise<void> {
  await prisma.memoryModelUsage.upsert({
    where: {
      spaceId_userId_day_purpose: {
        spaceId: usage.spaceId,
        userId: usage.userId,
        day: usage.day,
        purpose: usage.purpose,
      },
    },
    create: {
      spaceId: usage.spaceId,
      userId: usage.userId,
      day: usage.day,
      purpose: usage.purpose,
      calls: usage.calls ?? 1,
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
    },
    update: {
      calls: { increment: usage.calls ?? 1 },
      promptTokens: { increment: usage.promptTokens ?? 0 },
      completionTokens: { increment: usage.completionTokens ?? 0 },
    },
  });
}

export async function getMemoryModelUsage(
  prisma: PrismaClient,
  query: { spaceId: string; userId: string; day: Date },
): Promise<Array<{ purpose: string; calls: number; promptTokens: number; completionTokens: number }>> {
  return prisma.memoryModelUsage.findMany({
    where: query,
    select: { purpose: true, calls: true, promptTokens: true, completionTokens: true },
  });
}

export async function getSpaceMemoryPolicy(
  prisma: PrismaClient,
  spaceId: string,
): Promise<{ autoExtraction: "off" | "on" | "paused" }> {
  const row = await prisma.spaceMemoryPolicy.findUnique({ where: { spaceId } });
  const value = row?.autoExtraction;
  return { autoExtraction: value === "on" || value === "paused" ? value : "off" };
}

export async function setSpaceMemoryPolicy(
  prisma: PrismaClient,
  input: { spaceId: string; autoExtraction: "off" | "on" | "paused"; actorUserId: string },
): Promise<{ autoExtraction: "off" | "on" | "paused" }> {
  await prisma.spaceMemoryPolicy.upsert({
    where: { spaceId: input.spaceId },
    create: { spaceId: input.spaceId, autoExtraction: input.autoExtraction, updatedBy: input.actorUserId },
    update: { autoExtraction: input.autoExtraction, updatedBy: input.actorUserId },
  });
  return { autoExtraction: input.autoExtraction };
}

export interface ExtractionCursor {
  threadId: string;
  threadGeneration: number;
  highWatermarkSeq: number;
}

export async function loadExtractionCursor(
  prisma: PrismaClient,
  threadId: string,
): Promise<ExtractionCursor | null> {
  const row = await prisma.memoryExtractionCursor.findUnique({ where: { threadId } });
  return row
    ? {
        threadId: row.threadId,
        threadGeneration: row.threadGeneration,
        highWatermarkSeq: row.highWatermarkSeq,
      }
    : null;
}

/**
 * CAS watermark advance guarded by generation and the previous watermark, so a
 * late job from an old generation (or a duplicate worker) cannot move it.
 */
export async function advanceExtractionCursor(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    userId: string;
    botId?: string | null;
    threadId: string;
    expectedGeneration: number;
    expectedWatermark: number;
    newWatermark: number;
  },
): Promise<boolean> {
  const existing = await tx.memoryExtractionCursor.findUnique({
    where: { threadId: input.threadId },
  });
  if (!existing) {
    if (input.expectedWatermark !== -1) return false;
    await tx.memoryExtractionCursor.create({
      data: {
        spaceId: input.spaceId,
        userId: input.userId,
        ...(input.botId ? { botId: input.botId } : {}),
        threadId: input.threadId,
        threadGeneration: input.expectedGeneration,
        highWatermarkSeq: input.newWatermark,
        lastRunAt: new Date(),
      },
    });
    return true;
  }
  if (
    existing.threadGeneration !== input.expectedGeneration ||
    existing.highWatermarkSeq !== input.expectedWatermark
  ) {
    return false;
  }
  const updated = await tx.memoryExtractionCursor.updateMany({
    where: {
      threadId: input.threadId,
      threadGeneration: input.expectedGeneration,
      highWatermarkSeq: input.expectedWatermark,
    },
    data: { highWatermarkSeq: input.newWatermark, lastRunAt: new Date() },
  });
  return updated.count > 0;
}

/**
 * Thread clear support: invalidate the thread's evidence and remove model
 * candidates whose entire evidence base just became inaccessible. Confirmed
 * facts survive; their source references become inaccessible instead.
 * Runs inside the caller's clear transaction.
 */
export async function invalidateThreadMemoryEvidence(
  tx: Prisma.TransactionClient,
  input: { threadId: string; newGeneration: number },
): Promise<{ removedCandidateIds: string[] }> {
  await tx.memoryEvidence.updateMany({
    where: { threadId: input.threadId, accessible: true },
    data: { accessible: false },
  });
  const candidates = await tx.memoryFact.findMany({
    where: {
      state: "candidate",
      origin: "model_candidate",
      evidence: { some: { threadId: input.threadId } },
    },
    select: { id: true },
  });
  const removedCandidateIds: string[] = [];
  for (const candidate of candidates) {
    const remaining = await tx.memoryEvidence.count({
      where: { factId: candidate.id, accessible: true },
    });
    if (remaining === 0) {
      await tx.memoryFact.delete({ where: { id: candidate.id } });
      removedCandidateIds.push(candidate.id);
    }
  }
  return { removedCandidateIds };
}

/**
 * Compaction audit chain: insert the revision and CAS-advance the Thread
 * pointer in one transaction. Returns advanced=false when the cursor or
 * generation moved (clear or a winning concurrent worker); nothing is written
 * in that case.
 */
export async function persistCompactionRevision(
  prisma: PrismaClient,
  input: {
    threadId: string;
    expectedCursor: number | null;
    expectedGeneration: number;
    fromSeqExclusive: number;
    toSeqInclusive: number;
    summary: string;
    inputDigest: string;
    sourceRunId?: string | null;
    modelProvider: string;
    modelId: string;
    promptVersion: string;
    includesToolResults?: boolean;
  },
): Promise<{ advanced: boolean; revisionId?: string }> {
  return prisma.$transaction(async (tx) => {
    const previous = await tx.threadCompactionRevision.findFirst({
      where: { threadId: input.threadId, generation: input.expectedGeneration },
      orderBy: { toSeqInclusive: "desc" },
      select: { id: true, toSeqInclusive: true },
    });
    if (previous && previous.toSeqInclusive >= input.toSeqInclusive) {
      // A newer or equal revision already covers this range.
      return { advanced: false };
    }
    const advanced = await tx.thread.updateMany({
      where: {
        id: input.threadId,
        historyCompactedUpToSeq: input.expectedCursor,
        historyCompactionGeneration: input.expectedGeneration,
      },
      data: {
        historyCompactedUpToSeq: input.toSeqInclusive,
        historyCompactionSummary: input.summary,
      },
    });
    if (advanced.count === 0) return { advanced: false };
    const revision = await tx.threadCompactionRevision.create({
      data: {
        threadId: input.threadId,
        generation: input.expectedGeneration,
        fromSeqExclusive: input.fromSeqExclusive,
        toSeqInclusive: input.toSeqInclusive,
        previousRevisionId: previous?.id ?? null,
        summary: input.summary,
        inputDigest: input.inputDigest,
        sourceRunId: input.sourceRunId ?? null,
        modelProvider: input.modelProvider,
        modelId: input.modelId,
        promptVersion: input.promptVersion,
        includesToolResults: input.includesToolResults ?? false,
      },
    });
    return { advanced: true, revisionId: revision.id };
  });
}

/**
 * Explicit undo of a per-item legacy import (review P1-2): the fact leaves
 * every read path (state "reverted", body purged) and the source document
 * becomes injectable again as the legacy-format entry it was. This is the
 * ONLY path that unblocks a migrated document — user deletion does not.
 */
export async function revertLegacyImport(
  prisma: PrismaClient,
  ref: FactMutationRef & { reason?: string },
): Promise<FactMutationResult> {
  return mutateFact(prisma, ref, async ({ tx, fact, scope }) => {
    if (fact.state === "reverted") return { status: "replayed" as const, fact };
    if (fact.origin !== "legacy_import") return { status: "invalid_state" as const, fact };
    const wasVisible = fact.state === "active";
    const revision = fact.revision + 1;
    const updated = await tx.memoryFact.update({
      where: { id: fact.id },
      data: {
        state: "reverted",
        text: "",
        literalValues: Prisma.DbNull,
        revision,
        lastChangedBy: ref.actorUserId,
      },
    });
    await tx.memoryFactRevision.create({
      data: {
        factId: fact.id,
        revision,
        state: "reverted",
        text: null,
        kind: fact.kind,
        changedBy: ref.actorUserId,
        reason: ref.reason ?? "import_reverted",
      },
    });
    await tx.memoryFactRevision.updateMany({
      where: { factId: fact.id, revision: { lt: revision } },
      data: { text: null, literalValues: Prisma.DbNull },
    });
    if (wasVisible) {
      const { shardId } = await lockShardAndBump(tx, scope);
      await enqueueMemoryJobsInTransaction(tx, [
        {
          kind: "shard_profile_rebuild",
          spaceId: fact.spaceId,
          targetId: shardId,
          payload: { shardId } as Prisma.InputJsonValue,
        },
        {
          kind: "summary_rebuild",
          spaceId: fact.spaceId,
          targetId: `shard:${shardId}`,
          payload: { shardId } as Prisma.InputJsonValue,
        },
      ]);
    }
    return { status: "updated" as const, fact: updated };
  });
}

/**
 * Legacy import bookkeeping: document ids whose content was confirmed
 * migrated to a fact. The injection assembler skips those documents so
 * confirmed migrations never inject twice. Only an explicit revert unblocks
 * a document — DELETING the imported fact keeps the block, because "delete
 * this memory" must never resurrect the old document body (review P1-2).
 */
export async function listLegacyImportedDocumentIds(
  prisma: PrismaClient,
  query: { spaceId: string },
): Promise<Set<string>> {
  const rows = await prisma.memoryFact.findMany({
    where: {
      spaceId: query.spaceId,
      sourceDocumentId: { not: null },
      state: { not: "reverted" },
    },
    select: { sourceDocumentId: true },
  });
  return new Set(
    rows.map((row) => row.sourceDocumentId).filter((id): id is string => typeof id === "string"),
  );
}
