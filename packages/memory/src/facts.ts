import type {
  MemoryFactDto,
  MemoryFactEvidenceDto,
  MemoryFactMutationResult,
  MemoryFactState,
} from "@rakazo/contracts";
import type { MemoryEvidence, MemoryFact, PrismaClient } from "@rakazo/db";
import {
  canonicalKeyFor,
  confirmFact,
  correctFact,
  countDistinctEvidenceThreads,
  createFact,
  deleteFact,
  findBlockingTombstone,
  getFactForActor,
  listAuthorizedFacts,
  listFactEvidence,
  listLegacyImportedDocumentIds,
  listShardsForScopes,
  loadValidContextSummary,
  memoryEvidenceDigest,
  memoryScopeKey,
  promoteFactToSpace,
  rejectFact,
  type CreateFactResult,
  type FactScope,
  type MemoryScopeKind,
} from "@rakazo/db";
import { blocksToAgentHistoryText } from "@rakazo/core";
import type { MessageBlock } from "@rakazo/contracts";

/**
 * First-party memory fact service (ME-01/ME-02). Every write path — Knowledge
 * UI, the remember/save_memory tools, trusted messaging entries and the
 * extraction worker — goes through this service, so per-item delete, revision
 * CAS, evidence governance and shard/outbox bookkeeping cannot be bypassed.
 * Model calls never happen in here.
 */

export interface FactServiceDeps {
  prisma: PrismaClient;
  /** Server-keyed HMAC key material for evidence digests. */
  digestKey: string;
}

export interface FactActor {
  userId: string;
  spaceId: string;
}

/** Trusted human entry points per the AG-07 provenance catalog. Webhook,
 * automation, bot, system and unknown origins never count as user intent. */
export const TRUSTED_HUMAN_ORIGIN_KINDS = new Set([
  "human_web",
  "human_messaging",
  "messaging_external",
]);

/** Candidate display gate for inferred habits: four independent threads. */
export const CANDIDATE_DISPLAY_EVIDENCE_THREADS = 4;

export interface FactView extends MemoryFactDto {}

export interface FactWithCounts {
  fact: MemoryFact;
  evidenceCount: number;
  evidenceThreadCount: number;
  indexCleanupPending: boolean;
}

export function factToDto(
  fact: MemoryFact,
  counts: { evidenceCount: number; evidenceThreadCount: number; indexCleanupPending: boolean },
  now = new Date(),
): FactView {
  const scopeId = fact.scopeKey.slice(fact.scopeKind.length + 1);
  return {
    id: fact.id,
    scopeKind: fact.scopeKind as MemoryFactDto["scopeKind"],
    scopeId,
    kind: fact.kind,
    text: fact.text,
    literalValues:
      fact.literalValues && typeof fact.literalValues === "object"
        ? (fact.literalValues as Record<string, string>)
        : null,
    language: fact.language,
    origin: fact.origin as MemoryFactDto["origin"],
    state: fact.state as MemoryFactState,
    revision: fact.revision,
    ownerUserId: fact.ownerUserId,
    botId: fact.botId,
    validFrom: fact.validFrom ? fact.validFrom.toISOString() : null,
    expiresAt: fact.expiresAt ? fact.expiresAt.toISOString() : null,
    expired: fact.expiresAt !== null && fact.expiresAt.getTime() <= now.getTime(),
    learnedAt: fact.learnedAt.toISOString(),
    lastConfirmedAt: fact.lastConfirmedAt ? fact.lastConfirmedAt.toISOString() : null,
    updatedAt: fact.updatedAt.toISOString(),
    evidenceThreadCount: counts.evidenceThreadCount,
    evidenceCount: counts.evidenceCount,
    supersedesFactId: fact.supersedesFactId,
    promotionSourceFactId: fact.promotionSourceFactId,
    sourceDocumentId: fact.sourceDocumentId,
    indexCleanupPending: counts.indexCleanupPending,
  };
}

export function evidenceToDto(evidence: MemoryEvidence): MemoryFactEvidenceDto {
  return {
    id: evidence.id,
    threadId: evidence.threadId ?? "",
    messageId: evidence.messageId,
    messageSeq: evidence.messageSeq ?? -1,
    threadGeneration: evidence.threadGeneration,
    authorUserId: evidence.authorUserId,
    originKind: evidence.originKind,
    evidenceType: evidence.evidenceType,
    accessible: evidence.accessible,
    capturedAt: evidence.capturedAt.toISOString(),
  };
}

/** Batch-loads evidence counts and pending index-cleanup flags. */
export async function loadFactCounts(
  prisma: PrismaClient,
  factIds: string[],
): Promise<Map<string, { evidenceCount: number; evidenceThreadCount: number; indexCleanupPending: boolean }>> {
  const counts = new Map<
    string,
    { evidenceCount: number; evidenceThreadCount: number; indexCleanupPending: boolean }
  >();
  if (factIds.length === 0) return counts;
  const evidenceRows = await prisma.$queryRaw<
    Array<{ factId: string; total: number; threads: number }>
  >`
    SELECT "factId",
           COUNT(*)::int AS total,
           COUNT(DISTINCT "threadId") FILTER (WHERE accessible AND "threadId" IS NOT NULL)::int AS threads
    FROM memory_evidence
    WHERE "factId" = ANY(${factIds}::text[])
    GROUP BY "factId"
  `;
  for (const row of evidenceRows) {
    counts.set(row.factId, {
      evidenceCount: row.total,
      evidenceThreadCount: row.threads,
      indexCleanupPending: false,
    });
  }
  for (const factId of factIds) {
    if (!counts.has(factId)) {
      counts.set(factId, {
        evidenceCount: 0,
        evidenceThreadCount: 0,
        indexCleanupPending: false,
      });
    }
  }
  const cleanupRows = await prisma.memoryJobOutbox.findMany({
    where: { kind: "index_cleanup", targetId: { in: factIds } },
    select: { targetId: true },
  });
  for (const row of cleanupRows) {
    const entry = counts.get(row.targetId);
    if (entry) entry.indexCleanupPending = true;
  }
  return counts;
}

export async function loadFactViews(
  prisma: PrismaClient,
  facts: MemoryFact[],
  now = new Date(),
): Promise<FactView[]> {
  const counts = await loadFactCounts(
    prisma,
    facts.map((fact) => fact.id),
  );
  return facts.map((fact) => factToDto(fact, counts.get(fact.id)!, now));
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export interface FactListQuery {
  actor: FactActor;
  botId?: string | null;
  states?: MemoryFactState[];
  includeExpired?: boolean;
}

/**
 * Authorized management listing. Model-inferred candidates below the
 * four-thread display gate stay hidden: they are evidence accumulation, not
 * user-facing suggestions yet.
 */
export async function listFactsForActor(
  deps: FactServiceDeps,
  query: FactListQuery,
): Promise<FactView[]> {
  const facts = await listAuthorizedFacts(deps.prisma, {
    spaceId: query.actor.spaceId,
    userId: query.actor.userId,
    ...(query.botId ? { botId: query.botId } : {}),
    ...(query.states ? { states: query.states } : {}),
    includeExpired: query.includeExpired ?? false,
  });
  const views = await loadFactViews(deps.prisma, facts);
  return views.filter(
    (view) =>
      view.origin !== "model_candidate" ||
      view.state !== "candidate" ||
      view.evidenceThreadCount >= CANDIDATE_DISPLAY_EVIDENCE_THREADS,
  );
}

export async function getFactForActorWithEvidence(
  deps: FactServiceDeps,
  query: { actor: FactActor; botId?: string | null; factId: string },
): Promise<{ fact: FactView; evidence: MemoryFactEvidenceDto[] } | null> {
  const fact = await getFactForActor(deps.prisma, {
    spaceId: query.actor.spaceId,
    userId: query.actor.userId,
    ...(query.botId ? { botId: query.botId } : {}),
    factId: query.factId,
  });
  if (!fact) return null;
  const [views, evidence] = await Promise.all([
    loadFactViews(deps.prisma, [fact]),
    listFactEvidence(deps.prisma, { spaceId: query.actor.spaceId, factId: fact.id }),
  ]);
  return { fact: views[0]!, evidence: evidence.map(evidenceToDto) };
}

/**
 * Deterministic first-party recall for the recall_memory tool: authorized
 * active facts scored by token overlap with the query, newest confirmation
 * first on ties. No model call, no external dependency.
 */
export async function recallFactsForActor(
  deps: FactServiceDeps,
  query: { actor: FactActor; botId?: string | null; text: string; limit: number },
): Promise<MemoryFact[]> {
  const facts = await listAuthorizedFacts(deps.prisma, {
    spaceId: query.actor.spaceId,
    userId: query.actor.userId,
    ...(query.botId ? { botId: query.botId } : {}),
  });
  const queryTokens = tokenize(query.text);
  const scored = facts.map((fact) => {
    const haystack = new Set([
      ...tokenize(fact.text),
      ...tokenize(fact.kind),
      ...tokenize(literalText(fact.literalValues)),
    ]);
    let score = 0;
    for (const token of queryTokens) {
      if (haystack.has(token)) score += 1;
    }
    return { fact, score };
  });
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      (right.fact.lastConfirmedAt?.getTime() ?? 0) - (left.fact.lastConfirmedAt?.getTime() ?? 0),
  );
  return scored.slice(0, query.limit).map((entry) => entry.fact);
}

function literalText(literalValues: MemoryFact["literalValues"]): string {
  if (!literalValues || typeof literalValues !== "object") return "";
  return Object.entries(literalValues as Record<string, unknown>)
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(" ");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
}

/**
 * Injection read model: authorized active facts (expiry-filtered), the shard
 * versions covering them and the recipient's summary with its validity check.
 * One function so executor injection, summary.get and the worker agree.
 */
export interface MemoryInjectionReadModel {
  facts: MemoryFact[];
  shardVersions: Record<string, number>;
  summary: { content: string; tokenEstimate: number; generatedAt: Date; summaryModel: string; promptVersion: string } | null;
  summaryStale: boolean;
  legacyImportedDocumentIds: Set<string>;
}

/**
 * Cross-scope conflict resolution for one canonical identity (ME-01): the
 * same proposition can legitimately exist in several scopes (a promotion
 * keeps the original). The read path injects it once — an explicit bot-scope
 * fact wins over the generic space/user copies, newest confirmation breaks
 * remaining ties. User corrections always travel with their own fact row and
 * are never overridden by model-origin copies (those cannot be active
 * without confirmation in the first place).
 */
export function dedupeFactsByCanonicalKey(facts: MemoryFact[]): MemoryFact[] {
  const scopePriority: Record<string, number> = { bot: 3, space: 2, user: 1 };
  const byKey = new Map<string, MemoryFact>();
  for (const fact of facts) {
    const existing = byKey.get(fact.canonicalKey);
    if (!existing) {
      byKey.set(fact.canonicalKey, fact);
      continue;
    }
    const existingPriority = scopePriority[existing.scopeKind] ?? 0;
    const candidatePriority = scopePriority[fact.scopeKind] ?? 0;
    const existingConfirmed = existing.lastConfirmedAt?.getTime() ?? 0;
    const candidateConfirmed = fact.lastConfirmedAt?.getTime() ?? 0;
    if (
      candidatePriority > existingPriority ||
      (candidatePriority === existingPriority && candidateConfirmed > existingConfirmed)
    ) {
      byKey.set(fact.canonicalKey, fact);
    }
  }
  return [...byKey.values()];
}

export async function loadMemoryInjectionReadModel(
  deps: Pick<FactServiceDeps, "prisma">,
  query: { spaceId: string; userId: string; botId: string | null },
): Promise<MemoryInjectionReadModel> {
  const scopes: Array<{ scopeKind: MemoryScopeKind; scopeId: string }> = [
    { scopeKind: "user", scopeId: query.userId },
    { scopeKind: "space", scopeId: query.spaceId },
  ];
  if (query.botId) scopes.push({ scopeKind: "bot", scopeId: query.botId });
  const [allFacts, shards, importedIds] = await Promise.all([
    listAuthorizedFacts(deps.prisma, {
      spaceId: query.spaceId,
      userId: query.userId,
      botId: query.botId,
    }),
    listShardsForScopes(deps.prisma, { spaceId: query.spaceId, scopes }),
    listLegacyImportedDocumentIds(deps.prisma, { spaceId: query.spaceId }),
  ]);
  const facts = dedupeFactsByCanonicalKey(allFacts);
  const shardVersions: Record<string, number> = {};
  for (const shard of shards) shardVersions[shard.id] = shard.version;
  let summary: MemoryInjectionReadModel["summary"] = null;
  let summaryStale = false;
  if (query.botId) {
    const loaded = await loadValidContextSummary(deps.prisma, {
      spaceId: query.spaceId,
      recipientUserId: query.userId,
      recipientBotId: query.botId,
      currentShardVersions: shardVersions,
    });
    if (loaded) {
      summaryStale = loaded.stale;
      if (!loaded.stale) {
        summary = {
          content: loaded.summary.content,
          tokenEstimate: loaded.summary.tokenEstimate,
          generatedAt: loaded.summary.generatedAt,
          summaryModel: loaded.summary.summaryModel,
          promptVersion: loaded.summary.promptVersion,
        };
      }
    }
  }
  return { facts, shardVersions, summary, summaryStale, legacyImportedDocumentIds: importedIds };
}

// ---------------------------------------------------------------------------
// Write paths
// ---------------------------------------------------------------------------

function countSentences(text: string): number {
  return text
    .split(/[.!?。！？;；\n]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

/** A single clear proposition activates once; multi-statement blobs are ambiguous. */
export function isAmbiguousMemoryText(text: string): boolean {
  return text.length > 200 || countSentences(text) > 2;
}

export interface RunMemoryInput {
  runId: string;
  text: string;
  kind?: string;
  literalValues?: unknown;
  /** "bot" (default, matches the legacy remember tool) or "user". */
  scopeKind?: "bot" | "user";
}

export type RunMemoryResult =
  | { status: "remembered"; factId: string }
  | { status: "candidate"; factId: string; reason: "untrusted_source" | "ambiguous" }
  | { status: "duplicate"; factId: string }
  | { status: "blocked"; factId: string }
  | { status: "invalid"; reason: string };

/**
 * Unified tool entry (remember / save_memory). A single explicit instruction
 * from a trusted human turn activates once; anything from a non-human trigger,
 * an unlinked sender or an ambiguous multi-proposition blob becomes a
 * candidate for user confirmation. Automatic inference never takes the
 * single-activation shortcut.
 */
export async function recordMemoryFromRun(
  deps: FactServiceDeps,
  input: RunMemoryInput,
): Promise<RunMemoryResult> {
  const text = input.text.trim();
  if (!text) return { status: "invalid", reason: "empty_content" };
  const run = await deps.prisma.run.findUnique({
    where: { id: input.runId },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      botId: true,
      threadId: true,
      trigger: true,
      sourceMessageId: true,
    },
  });
  if (!run) return { status: "invalid", reason: "run_not_found" };

  let trusted = false;
  let evidenceContent: string | null = null;
  let evidenceMessage: { id: string; seq: number; authorUserId: string; originKind: string } | null =
    null;
  if (run.sourceMessageId) {
    const message = await deps.prisma.message.findUnique({
      where: { id: run.sourceMessageId },
      select: {
        id: true,
        seq: true,
        role: true,
        blocks: true,
        authorUserId: true,
        originKind: true,
        threadId: true,
      },
    });
    if (
      message &&
      message.threadId === run.threadId &&
      message.role === "user" &&
      message.authorUserId === run.userId &&
      TRUSTED_HUMAN_ORIGIN_KINDS.has(message.originKind)
    ) {
      trusted = true;
      evidenceContent = blocksToAgentHistoryText(message.blocks as MessageBlock[]);
      evidenceMessage = {
        id: message.id,
        seq: message.seq,
        authorUserId: message.authorUserId,
        originKind: message.originKind,
      };
    }
  }
  const ambiguous = isAmbiguousMemoryText(text);
  const activate = trusted && !ambiguous;

  const scopeKind = input.scopeKind ?? "bot";
  const scope: FactScope =
    scopeKind === "user"
      ? { spaceId: run.spaceId, scopeKind: "user", scopeId: run.userId }
      : { spaceId: run.spaceId, scopeKind: "bot", scopeId: run.botId };
  const kind = input.kind ?? "explicit_preference";
  const thread = await deps.prisma.thread.findUnique({
    where: { id: run.threadId },
    select: { historyCompactionGeneration: true },
  });

  const evidence =
    trusted && evidenceMessage && evidenceContent !== null
      ? [
          {
            threadId: run.threadId,
            threadGeneration: thread?.historyCompactionGeneration ?? 0,
            messageId: evidenceMessage.id,
            messageSeq: evidenceMessage.seq,
            authorUserId: evidenceMessage.authorUserId,
            originKind: evidenceMessage.originKind,
            evidenceType: "explicit_instruction",
            sourceDigest: memoryEvidenceDigest(deps.digestKey, evidenceContent),
          },
        ]
      : [];

  const result: CreateFactResult = await createFact(deps.prisma, {
    scope,
    ownerUserId: run.userId,
    botId: run.botId,
    kind,
    text,
    ...(input.literalValues !== undefined ? { literalValues: input.literalValues } : {}),
    origin: activate ? "user_direct" : "model_candidate",
    state: activate ? "active" : "candidate",
    actorUserId: run.userId,
    sourceRunId: run.id,
    evidence,
  });
  switch (result.status) {
    case "created":
      return activate
        ? { status: "remembered", factId: result.fact.id }
        : {
            status: "candidate",
            factId: result.fact.id,
            reason: trusted ? "ambiguous" : "untrusted_source",
          };
    case "duplicate":
      return { status: "duplicate", factId: result.fact.id };
    case "merged":
      return { status: "candidate", factId: result.fact.id, reason: "untrusted_source" };
    case "blocked_by_user_fact":
      return { status: "blocked", factId: result.fact.id };
  }
}

/** Direct Knowledge-UI creation: an authenticated user edit activates once. */
export async function recordMemoryFromEdit(
  deps: FactServiceDeps,
  input: {
    actor: FactActor;
    scopeKind: "bot" | "user" | "space";
    scopeId: string;
    botId?: string | null;
    text: string;
    kind?: string;
    literalValues?: unknown;
  },
): Promise<CreateFactResult> {
  assertScopeAuthority(input.actor, input.scopeKind, input.scopeId);
  return createFact(deps.prisma, {
    scope: { spaceId: input.actor.spaceId, scopeKind: input.scopeKind, scopeId: input.scopeId },
    ownerUserId: input.actor.userId,
    ...(input.botId ? { botId: input.botId } : {}),
    kind: input.kind ?? "explicit_preference",
    text: input.text,
    ...(input.literalValues !== undefined ? { literalValues: input.literalValues } : {}),
    origin: "user_direct",
    state: "active",
    actorUserId: input.actor.userId,
  });
}

/** scopeKey is only ever built from backend-validated entity ids. */
export function assertScopeAuthority(
  actor: FactActor,
  scopeKind: MemoryScopeKind,
  scopeId: string,
): void {
  if (scopeKind === "user" && scopeId !== actor.userId) {
    throw new Error("Cannot write memory facts into another user's scope");
  }
  if (scopeKind === "space" && scopeId !== actor.spaceId) {
    throw new Error("Cannot write memory facts into another space's scope");
  }
  if (!scopeId) throw new Error("Memory scope entity id is required");
}

async function requireVisibleFact(
  deps: FactServiceDeps,
  actor: FactActor,
  factId: string,
  botId?: string | null,
  includeDeleted?: boolean,
): Promise<MemoryFact | null> {
  return getFactForActor(deps.prisma, {
    spaceId: actor.spaceId,
    userId: actor.userId,
    ...(botId ? { botId } : {}),
    factId,
    ...(includeDeleted ? { includeDeleted: true } : {}),
  });
}

function toMutationResult(
  result: Awaited<ReturnType<typeof confirmFact>>,
  countsLoader: (fact: MemoryFact) => Promise<FactView>,
): Promise<MemoryFactMutationResult> {
  return (async () => {
    switch (result.status) {
      case "updated":
        return { status: "updated" as const, fact: await countsLoader(result.fact) };
      case "replayed":
        return { status: "replayed" as const, fact: await countsLoader(result.fact) };
      case "conflict":
        return {
          status: "conflict" as const,
          currentRevision: result.currentRevision,
          fact: result.fact ? await countsLoader(result.fact) : null,
        };
      case "invalid_state":
        return { status: "invalid_state" as const, fact: await countsLoader(result.fact) };
      case "not_found":
        throw new FactNotFoundError();
    }
  })();
}

export class FactNotFoundError extends Error {
  constructor() {
    super("Memory fact not found");
    this.name = "FactNotFoundError";
  }
}

export class FactForbiddenError extends Error {
  constructor(message = "Not authorized for this memory fact") {
    super(message);
    this.name = "FactForbiddenError";
  }
}

export class EmptyImportError extends Error {
  constructor() {
    super("Legacy document is empty; nothing to import");
    this.name = "EmptyImportError";
  }
}

export async function confirmFactAsActor(
  deps: FactServiceDeps,
  actor: FactActor,
  input: { factId: string; expectedRevision: number },
): Promise<MemoryFactMutationResult> {
  const fact = await requireVisibleFact(deps, actor, input.factId);
  if (!fact) throw new FactNotFoundError();
  const result = await confirmFact(deps.prisma, {
    spaceId: actor.spaceId,
    actorUserId: actor.userId,
    factId: input.factId,
    expectedRevision: input.expectedRevision,
  });
  return toMutationResult(result, (row) => loadSingleView(deps, row));
}

export async function correctFactAsActor(
  deps: FactServiceDeps,
  actor: FactActor,
  input: {
    factId: string;
    expectedRevision: number;
    text?: string;
    literalValues?: unknown;
    expiresAt?: Date | null;
    reason?: string;
  },
): Promise<MemoryFactMutationResult> {
  const fact = await requireVisibleFact(deps, actor, input.factId);
  if (!fact) throw new FactNotFoundError();
  const result = await correctFact(deps.prisma, {
    spaceId: actor.spaceId,
    actorUserId: actor.userId,
    factId: input.factId,
    expectedRevision: input.expectedRevision,
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.literalValues !== undefined ? { literalValues: input.literalValues } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    reason: input.reason ?? "user_correction",
  });
  return toMutationResult(result, (row) => loadSingleView(deps, row));
}

export async function rejectFactAsActor(
  deps: FactServiceDeps,
  actor: FactActor,
  input: { factId: string; expectedRevision: number; reason?: string },
): Promise<MemoryFactMutationResult> {
  const fact = await requireVisibleFact(deps, actor, input.factId);
  if (!fact) throw new FactNotFoundError();
  const result = await rejectFact(deps.prisma, {
    spaceId: actor.spaceId,
    actorUserId: actor.userId,
    factId: input.factId,
    expectedRevision: input.expectedRevision,
    ...(input.reason ? { reason: input.reason } : {}),
  });
  return toMutationResult(result, (row) => loadSingleView(deps, row));
}

export async function deleteFactAsActor(
  deps: FactServiceDeps,
  actor: FactActor,
  input: { factId: string; expectedRevision: number },
): Promise<MemoryFactMutationResult> {
  // The tombstone stays reachable for delete/forget only, so a repeated
  // delete replays idempotently instead of turning into NOT_FOUND.
  const fact = await requireVisibleFact(deps, actor, input.factId, null, true);
  if (!fact) throw new FactNotFoundError();
  const result = await deleteFact(deps.prisma, {
    spaceId: actor.spaceId,
    actorUserId: actor.userId,
    factId: input.factId,
    expectedRevision: input.expectedRevision,
    reason: "user_deleted",
  });
  return toMutationResult(result, (row) => loadSingleView(deps, row));
}

/** Per-item promotion into the Space scope; caller verified space authority. */
export async function promoteFactAsActor(
  deps: FactServiceDeps,
  actor: FactActor,
  input: { factId: string; expectedRevision: number },
): Promise<MemoryFactMutationResult> {
  const fact = await requireVisibleFact(deps, actor, input.factId);
  if (!fact) throw new FactNotFoundError();
  if (fact.ownerUserId !== actor.userId) {
    throw new FactForbiddenError("Only the owner can promote a personal fact");
  }
  const result = await promoteFactToSpace(deps.prisma, {
    spaceId: actor.spaceId,
    actorUserId: actor.userId,
    factId: input.factId,
    expectedRevision: input.expectedRevision,
  });
  return toMutationResult(result, (row) => loadSingleView(deps, row));
}

async function loadSingleView(deps: FactServiceDeps, fact: MemoryFact): Promise<FactView> {
  const views = await loadFactViews(deps.prisma, [fact]);
  return views[0]!;
}

/**
 * Per-item legacy document import. The document itself is never auto-split
 * into high-confidence facts; the user confirms one item at a time and the
 * imported fact records the source document so the assembler stops injecting
 * the same content twice. Reverting = deleting the imported fact.
 */
export async function importLegacyDocumentAsFact(
  deps: FactServiceDeps,
  actor: FactActor,
  input: { documentId: string; text?: string },
): Promise<MemoryFactMutationResult> {
  const document = await deps.prisma.memoryDocument.findFirst({
    where: { id: input.documentId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!document) throw new FactNotFoundError();
  const text = (input.text ?? document.content).trim();
  if (!text) throw new EmptyImportError();
  const scopeKind: "bot" | "user" = document.scope === "bot" && document.botId ? "bot" : "user";
  const scopeId = scopeKind === "bot" ? document.botId! : actor.userId;
  const result = await createFact(deps.prisma, {
    scope: { spaceId: actor.spaceId, scopeKind, scopeId },
    ownerUserId: actor.userId,
    ...(document.botId ? { botId: document.botId } : {}),
    kind: "legacy_document",
    text,
    origin: "legacy_import",
    state: "active",
    actorUserId: actor.userId,
    sourceDocumentId: document.id,
    evidence: [
      {
        threadId: null,
        threadGeneration: 0,
        messageId: null,
        messageSeq: null,
        authorUserId: actor.userId,
        originKind: "legacy_document",
        evidenceType: "legacy_document",
        sourceDigest: memoryEvidenceDigest(deps.digestKey, document.content),
      },
    ],
  });
  if (result.status === "duplicate" || result.status === "merged") {
    return { status: "replayed", fact: await loadSingleView(deps, result.fact) };
  }
  if (result.status === "blocked_by_user_fact") {
    return { status: "invalid_state", fact: await loadSingleView(deps, result.fact) };
  }
  return { status: "updated", fact: await loadSingleView(deps, result.fact) };
}

/**
 * Extraction-commit guard shared with the worker: a deleted/rejected fact
 * whose evidence covers the proposed sources blocks automatic
 * re-recommendation. Explicit user instructions bypass this at the call site.
 */
export async function isBlockedResurrection(
  deps: FactServiceDeps,
  query: {
    spaceId: string;
    scopeKind: MemoryScopeKind;
    scopeId: string;
    kind: string;
    text: string;
    evidenceDigests: string[];
  },
): Promise<boolean> {
  const tombstone = await findBlockingTombstone(deps.prisma, {
    spaceId: query.spaceId,
    scopeKind: query.scopeKind,
    scopeId: query.scopeId,
    canonicalKey: canonicalKeyFor(query.kind, query.text),
    evidenceDigests: query.evidenceDigests,
  });
  return tombstone !== null;
}

export { countDistinctEvidenceThreads, memoryScopeKey };
