import type { AdapterContext, MemoryStore } from "@rakazo/adapter-kit";
import type { MemoryFact } from "@rakazo/db";
import { estimatePromptTokens, promptSegment } from "@rakazo/core";
import {
  loadMemoryInjectionReadModel,
  type FactServiceDeps,
  type MemoryInjectionReadModel,
} from "@rakazo/memory";
import {
  byteLength,
  loadLegacyMemoryDocuments,
  sortLegacyMemoryDocuments,
  truncateUtf8,
  type ScopedMemoryDocument,
} from "./memory-context.js";

/**
 * ME-02 unified memory injection assembly. ONE function performs selection,
 * truncation, escaping, source identity and selected/omitted statistics for
 * every injected memory layer — legacy Markdown documents, the version-
 * matched ContextSummary and supplemental confirmed facts. No second cap is
 * stacked elsewhere (executor, memory-context or Java); the 32 KiB constant
 * in memory-context.ts remains a read guard only.
 *
 * Budgets are ESTIMATED tokens (estimatePromptTokens, ~4 chars/token, CJK
 * ~1 char/token) — never exact counts. Sub-budgets do not borrow from each
 * other: unused summary budget does not extend the fact list.
 *
 * The assembled block keeps the durable-memory preamble and
 * <durable_memory> fence and rides in conversation history as untrusted
 * application context (AG-06/AG-07 boundary preserved).
 */

export const MAX_AGENT_MEMORY_READ_GUARD_BYTES = 32 * 1024;

export interface MemoryInjectionBudgets {
  /** Hard total for legacy + new content during the migration period. */
  totalTokens: number;
  /** Legacy Markdown documents. */
  legacyTokens: number;
  /** ContextSummary section. */
  summaryTokens: number;
  /** Supplemental confirmed facts section. */
  factTokens: number;
  /** Supplemental fact count cap. */
  maxFacts: number;
}

/** Migration period: legacy documents still auto-inject beside the new layers. */
export const MIGRATION_MEMORY_BUDGETS: MemoryInjectionBudgets = {
  totalTokens: 4_000,
  legacyTokens: 2_000,
  summaryTokens: 1_200,
  factTokens: 800,
  maxFacts: 10,
};

/** After legacy documents retire from automatic injection. */
export const POST_MIGRATION_MEMORY_BUDGETS: MemoryInjectionBudgets = {
  totalTokens: 2_000,
  legacyTokens: 0,
  summaryTokens: 1_200,
  factTokens: 800,
  maxFacts: 10,
};

/**
 * Fraction of the model context window the memory block may occupy. Full-size
 * windows (>= total/fraction) keep the configured budgets; smaller windows
 * shrink every sub-budget proportionally so memory never crowds out recent
 * user messages or tool execution.
 */
export const MEMORY_WINDOW_FRACTION = 0.05;

export function scaleMemoryBudgetsToWindow(
  budgets: MemoryInjectionBudgets,
  contextWindowTokens: number | undefined,
): MemoryInjectionBudgets {
  if (!contextWindowTokens || contextWindowTokens <= 0) return budgets;
  const allowance = Math.floor(contextWindowTokens * MEMORY_WINDOW_FRACTION);
  if (allowance >= budgets.totalTokens) return budgets;
  const scale = Math.max(0, allowance / budgets.totalTokens);
  return {
    totalTokens: allowance,
    legacyTokens: Math.floor(budgets.legacyTokens * scale),
    summaryTokens: Math.floor(budgets.summaryTokens * scale),
    factTokens: Math.floor(budgets.factTokens * scale),
    maxFacts: Math.max(0, Math.floor(budgets.maxFacts * scale)),
  };
}

export interface MemoryInjectionInput {
  legacyDocuments: ScopedMemoryDocument[];
  /** Version-matched summary only; a stale summary must never be passed in. */
  summary: { content: string } | null;
  /** Authorized, active, unexpired facts (the read model filters expiry). */
  facts: MemoryFact[];
  /** Documents already confirmed-migrated to facts: never inject twice. */
  legacyImportedDocumentIds?: ReadonlySet<string>;
}

export interface MemoryInjectionStats {
  summaryIncluded: boolean;
  selectedFactIds: string[];
  omittedFactCount: number;
  selectedLegacyPaths: string[];
  omittedLegacyCount: number;
  estimatedTokens: number;
  budgets: MemoryInjectionBudgets;
}

export interface MemoryInjectionResult {
  content: string | undefined;
  stats: MemoryInjectionStats;
}

function escapePromptData(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
}

function literalSuffix(fact: MemoryFact): string {
  const values = fact.literalValues;
  if (!values || typeof values !== "object" || Array.isArray(values)) return "";
  const pairs = Object.entries(values as Record<string, unknown>)
    .filter(([, value]) => typeof value === "string")
    .map(([key, value]) => `${escapePromptData(key)}=${escapePromptData(String(value))}`);
  return pairs.length > 0 ? ` {${pairs.join("; ")}}` : "";
}

/** Deterministic relevance: task-token overlap first, newest confirmation second. */
export function selectSupplementalFacts(
  facts: MemoryFact[],
  taskText: string | undefined,
  maxFacts: number,
): { selected: MemoryFact[]; omitted: number } {
  if (facts.length <= maxFacts) return { selected: facts, omitted: 0 };
  const taskTokens = new Set(tokenize(taskText ?? ""));
  const scored = facts.map((fact) => {
    let score = 0;
    if (taskTokens.size > 0) {
      for (const token of new Set(tokenize(`${fact.text} ${fact.kind}`))) {
        if (taskTokens.has(token)) score += 1;
      }
    }
    return { fact, score, confirmedAt: fact.lastConfirmedAt?.getTime() ?? 0 };
  });
  scored.sort(
    (left, right) =>
      right.score - left.score || right.confirmedAt - left.confirmedAt || left.fact.id.localeCompare(right.fact.id),
  );
  return {
    selected: scored.slice(0, maxFacts).map((entry) => entry.fact),
    omitted: facts.length - maxFacts,
  };
}

/**
 * The single assembly function. Truncation priority inside the memory block:
 * confirmed new facts (summary first, then facts) > legacy documents. Every
 * layer is escaped data with source identity; omission counts are returned
 * for honest metrics, never silently dropped.
 */
export function assembleMemoryInjection(
  input: MemoryInjectionInput,
  budgets: MemoryInjectionBudgets,
  options: { taskText?: string } = {},
): MemoryInjectionResult {
  const stats: MemoryInjectionStats = {
    summaryIncluded: false,
    selectedFactIds: [],
    omittedFactCount: 0,
    selectedLegacyPaths: [],
    omittedLegacyCount: 0,
    estimatedTokens: 0,
    budgets,
  };

  const preamble = `${promptSegment("context/durable-memory-preamble")}\n\n<durable_memory>\n`;
  const closing = "\n</durable_memory>";

  const sections: string[] = [];

  // 1. Version-matched summary (new content, highest injection priority).
  if (input.summary && budgets.summaryTokens > 0) {
    const label = `${promptSegment("context/memory-summary-label")}\n`;
    const summaryTokens = estimatePromptTokens(input.summary.content);
    if (summaryTokens <= budgets.summaryTokens) {
      sections.push(`${label}${escapePromptData(input.summary.content)}`);
      stats.summaryIncluded = true;
    } else {
      // Over budget: truncate deterministically at the token estimate rather
      // than dropping the whole summary.
      const kept = truncateToEstimatedTokens(input.summary.content, budgets.summaryTokens);
      if (kept.trim()) {
        sections.push(`${label}${escapePromptData(kept)}`);
        stats.summaryIncluded = true;
      }
    }
  }

  // 2. Supplemental confirmed facts, capped by count AND token sub-budget.
  const { selected, omitted } = selectSupplementalFacts(input.facts, options.taskText, budgets.maxFacts);
  stats.omittedFactCount += omitted;
  const factLines: string[] = [];
  let factTokens = 0;
  for (const fact of selected) {
    const line = `- ${escapePromptData(fact.text)}${literalSuffix(fact)} [id: ${escapePromptData(fact.id)}] (${escapePromptData(fact.scopeKind)}, ${escapePromptData(fact.kind)})`;
    const lineTokens = estimatePromptTokens(line);
    if (factTokens + lineTokens > budgets.factTokens) {
      // Everything from here on is omitted by the token sub-budget.
      stats.omittedFactCount += selected.length - factLines.length;
      break;
    }
    factLines.push(line);
    factTokens += lineTokens;
    stats.selectedFactIds.push(fact.id);
  }
  if (factLines.length > 0) {
    sections.push(`${promptSegment("context/memory-facts-label")}\n${factLines.join("\n")}`);
  }

  // 3. Legacy Markdown documents (old format compatibility entry). Documents
  //    already confirmed-migrated to facts are skipped: one injection per
  //    confirmed content.
  const legacyDocuments = input.legacyDocuments.filter(
    (document) => !input.legacyImportedDocumentIds?.has(document.id),
  );
  sortLegacyMemoryDocuments(legacyDocuments);
  let legacyTokens = 0;
  const legacyParts: string[] = [];
  for (const document of legacyDocuments) {
    if (budgets.legacyTokens <= 0) {
      stats.omittedLegacyCount += 1;
      continue;
    }
    const heading = `${legacyParts.length === 0 ? "" : "\n\n"}## ${document.scope}: ${document.path} (revision ${document.revision})\n`;
    const headingTokens = estimatePromptTokens(heading);
    if (legacyTokens + headingTokens > budgets.legacyTokens) {
      stats.omittedLegacyCount += 1;
      continue;
    }
    const remainingTokens = budgets.legacyTokens - legacyTokens - headingTokens;
    const documentTokens = estimatePromptTokens(document.content);
    const content =
      documentTokens <= remainingTokens
        ? document.content
        : truncateToEstimatedTokens(document.content, remainingTokens);
    legacyParts.push(heading);
    legacyParts.push(content);
    legacyTokens += headingTokens + estimatePromptTokens(content);
    stats.selectedLegacyPaths.push(`${document.scope}:${document.path}`);
    if (documentTokens > remainingTokens) {
      // Truncated tail counts as omitted for honest metrics.
      stats.omittedLegacyCount += 1;
    }
  }
  if (legacyParts.length > 0) {
    sections.push(legacyParts.join(""));
  }

  if (sections.length === 0) {
    return { content: undefined, stats };
  }

  let content = `${preamble}${sections.join("\n\n")}${closing}`;
  stats.estimatedTokens = estimatePromptTokens(content);

  // Read guard (not an injection budget): never hand the runtime a runaway
  // block even if estimates drift.
  if (byteLength(content) > MAX_AGENT_MEMORY_READ_GUARD_BYTES) {
    content = truncateUtf8(content, MAX_AGENT_MEMORY_READ_GUARD_BYTES - byteLength(closing)) + closing;
  }
  return { content, stats };
}

export interface MemoryInjectionInputs {
  legacyDocuments: ScopedMemoryDocument[];
  readModel: MemoryInjectionReadModel;
}

/**
 * Loads every injection input in parallel: legacy Markdown documents through
 * the existing MemoryStore and the first-party read model (facts, shard
 * versions, version-validated summary, legacy-import guard). Assembly happens
 * later, once the model's context window is known.
 */
export async function loadMemoryInjectionInputs(
  memory: MemoryStore,
  factStore: Pick<FactServiceDeps, "prisma">,
  botId: string,
  scope: { spaceId: string; userId: string },
  context: AdapterContext,
): Promise<MemoryInjectionInputs> {
  const [legacyDocuments, readModel] = await Promise.all([
    loadLegacyMemoryDocuments(memory, botId, context),
    loadMemoryInjectionReadModel(factStore, {
      spaceId: scope.spaceId,
      userId: scope.userId,
      botId,
    }),
  ]);
  return { legacyDocuments, readModel };
}

/** Character-safe deterministic truncation to an estimated-token budget. */
export function truncateToEstimatedTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimatePromptTokens(text) <= maxTokens) return text;
  // Binary search on the character prefix; estimator is monotone in length.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimatePromptTokens(text.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  // Never split a surrogate pair.
  let cut = low;
  if (cut > 0 && cut < text.length) {
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  }
  return text.slice(0, cut);
}
