import { createHash } from "node:crypto";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { blocksToAgentHistoryText, estimatePromptTokens, promptSegment } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  advanceExtractionCursor,
  createFact,
  getMemoryModelUsage,
  getSpaceMemoryPolicy,
  incrementMemoryModelUsage,
  listAuthorizedFacts,
  memoryEvidenceDigest,
} from "@rakazo/db";
import { isBlockedResurrection, TRUSTED_HUMAN_ORIGIN_KINDS } from "@rakazo/memory";
import { getLogger } from "@rakazo/logging";
import {
  containsOneTimeCode,
  containsSecretLikeContent,
  sharesVerbatimRun,
} from "./memory-content-safety.js";
import { resolveMemoryAuxModel, type MemoryJobsConfig } from "./memory-jobs-config.js";

/**
 * ME-02 M3: automatic candidate extraction. Incremental jobs run after
 * completed human turns; a periodic sweep fills gaps. The model only ever
 * produces strict candidate proposals over bounded trusted user messages —
 * the analysis phase writes nothing. Every candidate is then validated
 * deterministically (actor, generation, secrets, verbatim copies, tombstones)
 * and committed transactionally with keyed-HMAC evidence. Inference never
 * activates: candidates wait for user confirmation, and inferred habits only
 * become visible after four independent threads of trusted evidence.
 */

const EXTRACTION_INSTRUCTIONS = promptSegment("auxiliary/memory-extraction");

export const MEMORY_EXTRACTION_PROMPT_VERSION = `memory-extraction@${createHash("sha256")
  .update(EXTRACTION_INSTRUCTIONS, "utf8")
  .digest("hex")
  .slice(0, 12)}`;

/** Service principal for automatic extraction; never a user id. */
export const EXTRACTION_SERVICE_ACTOR = "service:memory-extraction";

const CANDIDATE_KINDS = new Set([
  "explicit_preference",
  "correction",
  "workflow",
  "stable_fact",
]);

export interface MemoryExtractionDeps {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  config: MemoryJobsConfig;
  digestKey: string;
  env?: NodeJS.ProcessEnv;
}

export type MemoryExtractionOutcome =
  | { status: "processed"; scanned: number; candidates: number; merged: number; rejected: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

interface TrustedMessage {
  id: string;
  seq: number;
  authorUserId: string;
  originKind: string;
  content: string;
}

export function buildMemoryExtractionPrompt(
  knownFacts: Array<{ id: string; scopeKind: string; kind: string; text: string }>,
  messages: TrustedMessage[],
): string {
  const facts = knownFacts
    .map((fact) => `- [${fact.id}] (${fact.scopeKind}, ${fact.kind}) ${escapePromptData(fact.text)}`)
    .join("\n");
  const lines = messages
    .map(
      (message) =>
        `- [msg:${message.id} seq:${message.seq}] ${escapePromptData(message.content)}`,
    )
    .join("\n");
  return `<known_facts>\n${facts}\n</known_facts>\n\n<trusted_user_messages>\n${lines}\n</trusted_user_messages>`;
}

function escapePromptData(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Tolerant strict-JSON parse: models sometimes wrap the payload in fences. */
export function parseExtractionOutput(text: string): unknown[] | null {
  let candidate = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(candidate);
  if (fence) candidate = fence[1]!.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as { candidates?: unknown };
    return Array.isArray(parsed.candidates) ? parsed.candidates : null;
  } catch {
    return null;
  }
}

export async function runMemoryExtraction(
  deps: MemoryExtractionDeps,
  payload: { threadId: string },
): Promise<MemoryExtractionOutcome> {
  if (!deps.config.factsEnabled) return { status: "skipped", reason: "facts_disabled" };
  const startedAt = Date.now();
  const thread = await deps.prisma.thread.findUnique({
    where: { id: payload.threadId },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      botId: true,
      historyCompactionGeneration: true,
      nextMessageSeq: true,
    },
  });
  if (!thread || !thread.botId) return { status: "skipped", reason: "thread_unavailable" };

  const policy = await getSpaceMemoryPolicy(deps.prisma, thread.spaceId);
  if (policy.autoExtraction !== "on") {
    return { status: "skipped", reason: `auto_extraction_${policy.autoExtraction}` };
  }

  const cursor = await deps.prisma.memoryExtractionCursor.findUnique({
    where: { threadId: thread.id },
  });
  let generation = cursor?.threadGeneration ?? thread.historyCompactionGeneration;
  let watermark = cursor?.highWatermarkSeq ?? -1;
  if (cursor && cursor.threadGeneration !== thread.historyCompactionGeneration) {
    // The thread was cleared since the last scan: old messages are gone, so
    // restart from the beginning of the surviving sequence space. Late jobs
    // from the old generation fail the cursor CAS below and write nothing.
    generation = thread.historyCompactionGeneration;
    watermark = -1;
  }

  const scanned = await deps.prisma.message.findMany({
    where: { threadId: thread.id, seq: { gt: watermark } },
    orderBy: { seq: "asc" },
    take: deps.config.extractScanBatchMessages,
    select: { id: true, seq: true, role: true, blocks: true, authorUserId: true, originKind: true },
  });
  if (scanned.length === 0) return { status: "skipped", reason: "no_new_messages" };
  const newWatermark = scanned[scanned.length - 1]!.seq;

  // Trusted human user messages only: role=user is never sufficient, the
  // server-written authorUserId and originKind decide (AG-07).
  const trusted: TrustedMessage[] = [];
  for (const message of scanned) {
    if (message.role !== "user") continue;
    if (!message.authorUserId || message.authorUserId !== thread.userId) continue;
    if (!TRUSTED_HUMAN_ORIGIN_KINDS.has(message.originKind)) continue;
    trusted.push({
      id: message.id,
      seq: message.seq,
      authorUserId: message.authorUserId,
      originKind: message.originKind,
      content: blocksToAgentHistoryText(message.blocks as MessageBlock[]),
    });
  }

  if (trusted.length === 0) {
    // Still advance past untrusted messages so periodic scans do not rescan.
    await advanceCursor(deps, thread, generation, watermark, newWatermark);
    return { status: "processed", scanned: scanned.length, candidates: 0, merged: 0, rejected: 0 };
  }

  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const usage = await getMemoryModelUsage(deps.prisma, {
    spaceId: thread.spaceId,
    userId: thread.userId,
    day,
  });
  const extractionCalls = usage.find((row) => row.purpose === "extraction")?.calls ?? 0;
  const totalTokens = usage.reduce((sum, row) => sum + row.promptTokens + row.completionTokens, 0);
  if (extractionCalls >= deps.config.extractDailyCallsPerUser) {
    getLogger().warn("memory.extract quota reached", {
      "memory.extract.reason": "daily_calls",
      "space.id": thread.spaceId,
      "thread.id": thread.id,
    });
    return { status: "skipped", reason: "quota_daily_calls" };
  }
  if (totalTokens >= deps.config.dailyTokensPerUser) {
    return { status: "skipped", reason: "quota_daily_tokens" };
  }

  const model = resolveMemoryAuxModel("extraction", deps.env);
  if (!model) return { status: "skipped", reason: "no_extraction_model" };
  if (!deps.runtime.describe().capabilities.compaction || model.provider === "scripted") {
    return { status: "skipped", reason: "runtime_cannot_extract" };
  }

  const bounded = trusted.slice(0, deps.config.extractMaxMessagesPerCall);
  const knownFacts = await listAuthorizedFacts(deps.prisma, {
    spaceId: thread.spaceId,
    userId: thread.userId,
    botId: thread.botId,
    states: ["active", "candidate"],
    includeExpired: true,
  });
  let prompt = buildMemoryExtractionPrompt(
    knownFacts.slice(0, deps.config.summaryMaxFacts).map((fact) => ({
      id: fact.id,
      scopeKind: fact.scopeKind,
      kind: fact.kind,
      text: fact.text,
    })),
    bounded,
  );
  if (prompt.length > deps.config.extractMaxInputChars) {
    // Deterministic shrink: halve the message window until it fits.
    let window = bounded;
    while (prompt.length > deps.config.extractMaxInputChars && window.length > 1) {
      window = window.slice(0, Math.ceil(window.length / 2));
      prompt = buildMemoryExtractionPrompt(
        knownFacts.slice(0, deps.config.summaryMaxFacts).map((fact) => ({
          id: fact.id,
          scopeKind: fact.scopeKind,
          kind: fact.kind,
          text: fact.text,
        })),
        window,
      );
    }
    if (prompt.length > deps.config.extractMaxInputChars) {
      return { status: "skipped", reason: "input_exceeds_budget" };
    }
  }
  // Track which messages actually made it into the final bounded prompt so
  // evidence validation can refuse citations of messages the model never saw.
  const analyzed = new Set(
    bounded.filter((message) => prompt.includes(`msg:${message.id}`)).map((message) => message.id),
  );

  let raw = "";
  let runtimeReportedFailure = false;
  let usageTokens: { input: number; output: number } | null = null;
  try {
    for await (const event of deps.runtime.run(
      {
        botId: thread.botId,
        threadId: `memory-extract:${thread.id}`,
        runId: `memory-extract:${thread.id}:${generation}:${watermark}`,
        executionScope: "memory-extraction",
        prompt,
        instructions: EXTRACTION_INSTRUCTIONS,
        history: [],
        tools: [],
        model,
        allowSilentEmpty: true,
      },
      {
        operationId: `memory-extract:${thread.id}:${generation}:${watermark}`,
        traceId: `memory-extract:${thread.id}`,
        spaceId: thread.spaceId,
        userId: thread.userId,
        signal: AbortSignal.timeout(deps.config.auxCallTimeoutMs),
      },
    )) {
      if (event.type === "usage") {
        usageTokens = { input: event.inputTokens, output: event.outputTokens };
      }
      if (event.type === "text" && /^(?:I hit a problem:|Unknown model )/i.test(event.text.trim())) {
        runtimeReportedFailure = true;
      }
      if (event.type === "done" && event.text) {
        const text = event.text.trim();
        if (/^(?:I hit a problem:|Unknown model )/i.test(text)) runtimeReportedFailure = true;
        else raw = text;
      }
    }
  } catch (error) {
    getLogger().error("memory.extract model call failed", error, {
      "memory.extract.model": `${model.provider}/${model.id}`,
      "thread.id": thread.id,
    });
    throw error; // retryable through the job queue
  }
  await incrementMemoryModelUsage(deps.prisma, {
    spaceId: thread.spaceId,
    userId: thread.userId,
    day,
    purpose: "extraction",
    calls: 1,
    promptTokens: usageTokens?.input ?? estimatePromptTokens(prompt),
    completionTokens: usageTokens?.output ?? estimatePromptTokens(raw),
  });
  if (runtimeReportedFailure) {
    return { status: "failed", reason: "runtime_reported_failure" };
  }

  const parsed = parseExtractionOutput(raw);
  if (!parsed) {
    getLogger().warn("memory.extract produced unparsable output", {
      "memory.extract.reason": "unparsable_output",
      "thread.id": thread.id,
    });
    await advanceCursor(deps, thread, generation, watermark, newWatermark);
    return { status: "processed", scanned: scanned.length, candidates: 0, merged: 0, rejected: 0 };
  }

  const byId = new Map(bounded.map((message) => [message.id, message]));
  let committed = 0;
  let merged = 0;
  let rejected = 0;
  for (const candidate of parsed.slice(0, deps.config.extractMaxCandidatesPerCall)) {
    const verdict = await validateAndCommitCandidate(deps, thread, generation, byId, candidate, analyzed);
    if (verdict === "created") committed += 1;
    else if (verdict === "merged") merged += 1;
    else rejected += 1;
  }
  // Extra candidates beyond the cap are rejected without model re-ask.
  rejected += Math.max(0, parsed.length - deps.config.extractMaxCandidatesPerCall);

  await advanceCursor(deps, thread, generation, watermark, newWatermark);
  getLogger().info("memory.extract processed", {
    "memory.extract.scanned": scanned.length,
    "memory.extract.trusted": trusted.length,
    "memory.extract.candidates": committed,
    "memory.extract.merged": merged,
    "memory.extract.rejected": rejected,
    "memory.extract.model": `${model.provider}/${model.id}`,
    "memory.extract.prompt_version": MEMORY_EXTRACTION_PROMPT_VERSION,
    "memory.extract.duration_ms": Date.now() - startedAt,
    "memory.extract.cursor_lag": Math.max(0, thread.nextMessageSeq - 1 - newWatermark),
    "thread.id": thread.id,
    "space.id": thread.spaceId,
  });
  return { status: "processed", scanned: scanned.length, candidates: committed, merged, rejected };
}

async function advanceCursor(
  deps: MemoryExtractionDeps,
  thread: { id: string; spaceId: string; userId: string; botId: string | null },
  generation: number,
  expectedWatermark: number,
  newWatermark: number,
): Promise<void> {
  const advanced = await deps.prisma.$transaction((tx) =>
    advanceExtractionCursor(tx, {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId: thread.botId,
      threadId: thread.id,
      expectedGeneration: generation,
      expectedWatermark,
      newWatermark,
    }),
  );
  if (!advanced) {
    getLogger().info("memory.extract cursor lost its race; result discarded", {
      "memory.extract.reason": "cursor_stale",
      "thread.id": thread.id,
    });
  }
}

async function validateAndCommitCandidate(
  deps: MemoryExtractionDeps,
  thread: { id: string; spaceId: string; userId: string; botId: string | null },
  generation: number,
  byId: Map<string, TrustedMessage>,
  candidate: unknown,
  analyzedMessageIds: Set<string>,
): Promise<"created" | "merged" | "rejected"> {
  if (!candidate || typeof candidate !== "object") return "rejected";
  const proposal = candidate as Record<string, unknown>;
  const text = typeof proposal.text === "string" ? proposal.text.trim() : "";
  const kind = typeof proposal.kind === "string" && CANDIDATE_KINDS.has(proposal.kind) ? proposal.kind : "";
  const scope = proposal.scope === "user" ? "user" : "bot";
  if (!text || !kind) return "rejected";
  if (text.length > 500) return "rejected";

  // Evidence must cite messages this call actually analyzed, and every cited
  // message must be a trusted human message of this thread.
  const citedIds = Array.isArray(proposal.evidenceMessageIds)
    ? proposal.evidenceMessageIds.filter((id): id is string => typeof id === "string")
    : [];
  if (citedIds.length === 0) return "rejected";
  const evidenceMessages: TrustedMessage[] = [];
  for (const id of citedIds) {
    const message = byId.get(id);
    if (!message || !analyzedMessageIds.has(id)) return "rejected";
    evidenceMessages.push(message);
  }

  const literalValues =
    proposal.literalValues && typeof proposal.literalValues === "object" && !Array.isArray(proposal.literalValues)
      ? (proposal.literalValues as Record<string, unknown>)
      : null;

  // Deterministic safety gates: secrets, one-time codes and verbatim
  // transcription of user words are never stored, even as candidates.
  const literalText = literalValues
    ? Object.entries(literalValues)
        .map(([key, value]) => `${key} ${String(value)}`)
        .join(" ")
    : "";
  if (containsSecretLikeContent(`${text} ${literalText}`)) return "rejected";
  if (containsOneTimeCode(`${text} ${literalText}`)) return "rejected";
  if (sharesVerbatimRun(text, evidenceMessages.map((message) => message.content))) return "rejected";

  const scopeKind = scope;
  const scopeId = scope === "user" ? thread.userId : thread.botId!;
  const digests = evidenceMessages.map((message) =>
    memoryEvidenceDigest(deps.digestKey, message.content),
  );
  if (
    await isBlockedResurrection(deps, {
      spaceId: thread.spaceId,
      scopeKind,
      scopeId,
      kind,
      text,
      evidenceDigests: digests,
    })
  ) {
    // A deleted/rejected fact already covers these sources: never re-recommend.
    return "rejected";
  }

  try {
    const result = await createFact(deps.prisma, {
      scope: { spaceId: thread.spaceId, scopeKind, scopeId },
      ownerUserId: thread.userId,
      botId: thread.botId,
      kind,
      text,
      ...(literalValues ? { literalValues } : {}),
      origin: "model_candidate",
      state: "candidate",
      actorUserId: EXTRACTION_SERVICE_ACTOR,
      evidence: evidenceMessages.map((message) => ({
        threadId: thread.id,
        threadGeneration: generation,
        messageId: message.id,
        messageSeq: message.seq,
        authorUserId: message.authorUserId,
        originKind: message.originKind,
        evidenceType: "user_message",
        sourceDigest: memoryEvidenceDigest(deps.digestKey, message.content),
      })),
    });
    if (result.status === "created") return "created";
    if (result.status === "merged") return "merged";
    return "rejected"; // duplicate of an active fact or blocked by a user fact
  } catch (error) {
    getLogger().error("memory.extract candidate commit failed", error, {
      "thread.id": thread.id,
    });
    return "rejected";
  }
}
