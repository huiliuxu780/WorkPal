import { estimatePromptTokens } from "@rakazo/core";

/**
 * ME-02 M4: application-layer compaction scheduling. One server-selected mode
 * per call site instead of scattered boolean branches:
 *
 * - disabled: rollback/experiments off; no enqueue, no wait, no sync.
 * - background_nowait: normal interactive turns. The job is enqueued and the
 *   turn proceeds; raw PostgreSQL messages are always committed first — the
 *   chat record never waits for a summary.
 * - background_wait_if_needed: the next turn is predicted to exceed the
 *   available history budget. Bounded wait for the same-generation job, then
 *   a synchronous rescue when the wait is not enough.
 * - sync: internal paths that must hold the summary before trimming agent
 *   working context or handing execution state over.
 *
 * All token numbers here are ESTIMATES (estimatePromptTokens); when the model
 * window is unknown the decision falls back to the existing conservative
 * message-count threshold and says so through `reason`.
 */

export type CompactionMode =
  | "disabled"
  | "background_nowait"
  | "background_wait_if_needed"
  | "sync";

export interface CompactionMargins {
  /** Absolute head-room subtracted from the window when starting compaction (estimated tokens). */
  startMarginTokens: number;
  /** Proportional head-room (0..1 of window) when starting compaction. */
  startMarginRatio: number;
  /** Absolute head-room for the persist/escalation threshold (estimated tokens). */
  persistMarginTokens: number;
  /** Proportional head-room (0..1 of window) for the persist threshold. */
  persistMarginRatio: number;
  /** Reserved completion size (estimated tokens). */
  outputReserveTokens: number;
}

export const DEFAULT_COMPACTION_MARGINS: CompactionMargins = {
  startMarginTokens: 8_000,
  startMarginRatio: 0.1,
  persistMarginTokens: 4_000,
  persistMarginRatio: 0.05,
  outputReserveTokens: 4_000,
};

/**
 * Margins must keep the documented coverage semantics: `start` fires earlier
 * (bigger margin ⇒ smaller usable budget) than `persist`, so persist is never
 * reached before start. Configuration violating this is rejected, not clamped
 * silently.
 */
export function validateCompactionMargins(margins: CompactionMargins): CompactionMargins {
  for (const [key, value] of Object.entries(margins)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Compaction margin ${key} must be a non-negative finite number`);
    }
  }
  if (margins.startMarginRatio > 0.9 || margins.persistMarginRatio > 0.9) {
    throw new Error("Compaction margin ratios must stay below 0.9 of the window");
  }
  if (
    margins.persistMarginTokens > margins.startMarginTokens ||
    margins.persistMarginRatio > margins.startMarginRatio
  ) {
    throw new Error("persist margins must not exceed start margins (persist may not fire before start)");
  }
  return margins;
}

export function compactionMarginsFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): CompactionMargins {
  const fallback = DEFAULT_COMPACTION_MARGINS;
  const num = (key: string, def: number) => {
    const raw = source[key]?.trim();
    if (!raw) return def;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : def;
  };
  return validateCompactionMargins({
    startMarginTokens: num("WORKPAL_COMPACTION_START_MARGIN_TOKENS", fallback.startMarginTokens),
    startMarginRatio: num("WORKPAL_COMPACTION_START_MARGIN_RATIO", fallback.startMarginRatio),
    persistMarginTokens: num("WORKPAL_COMPACTION_PERSIST_MARGIN_TOKENS", fallback.persistMarginTokens),
    persistMarginRatio: num("WORKPAL_COMPACTION_PERSIST_MARGIN_RATIO", fallback.persistMarginRatio),
    outputReserveTokens: num("WORKPAL_COMPACTION_OUTPUT_RESERVE_TOKENS", fallback.outputReserveTokens),
  });
}

export function compactionModeFromEnv(source: NodeJS.ProcessEnv = process.env): CompactionMode | null {
  const raw = source.WORKPAL_HISTORY_COMPACTION_MODE?.trim();
  if (!raw) return null;
  return raw === "disabled" ||
    raw === "background_nowait" ||
    raw === "background_wait_if_needed" ||
    raw === "sync"
    ? raw
    : null;
}

/** Usable history budget for one threshold, or null when the window is unknown. */
export function availableHistoryBudgetTokens(input: {
  contextWindowTokens: number | undefined | null;
  systemPromptTokens: number;
  toolSchemaTokens: number;
  currentInputTokens: number;
  margins: Pick<CompactionMargins, "startMarginTokens" | "startMarginRatio" | "outputReserveTokens">;
  persist?: boolean;
}): number | null {
  const window = input.contextWindowTokens;
  if (!window || window <= 0) return null;
  const marginTokens = input.persist
    ? (input.margins as CompactionMargins).persistMarginTokens
    : input.margins.startMarginTokens;
  const marginRatio = input.persist
    ? (input.margins as CompactionMargins).persistMarginRatio
    : input.margins.startMarginRatio;
  const margin = Math.max(marginTokens, Math.floor(window * marginRatio));
  return Math.max(
    0,
    window - input.systemPromptTokens - input.toolSchemaTokens - input.currentInputTokens - input.margins.outputReserveTokens - margin,
  );
}

export interface CompactionTriggerDecision {
  shouldStart: boolean;
  shouldPersist: boolean;
  reason: "token_budget" | "message_threshold" | "window_unknown_message_threshold";
}

/**
 * Trigger decision at a turn boundary. Token budget applies when the model
 * window is known and the uncompacted estimate is available; the historical
 * message-count rule (windowSize + batchSize) always remains as the fallback
 * bound, and the reason field states honestly which rule fired.
 */
export function decideCompactionTrigger(input: {
  nextMessageSeq: number;
  historyCompactedUpToSeq: number | null;
  windowSize: number;
  batchSize: number;
  estimatedUncompactedTokens: number | null;
  startBudgetTokens: number | null;
  persistBudgetTokens: number | null;
}): CompactionTriggerDecision {
  const compactedUpTo = input.historyCompactedUpToSeq ?? -1;
  const uncompactedCount = input.nextMessageSeq - compactedUpTo - 1;
  const messageRule = uncompactedCount >= input.windowSize + input.batchSize;
  const startBudgetHit =
    input.estimatedUncompactedTokens !== null &&
    input.startBudgetTokens !== null &&
    input.estimatedUncompactedTokens >= input.startBudgetTokens;
  const persistBudgetHit =
    input.estimatedUncompactedTokens !== null &&
    input.persistBudgetTokens !== null &&
    input.estimatedUncompactedTokens >= input.persistBudgetTokens;
  if (startBudgetHit || persistBudgetHit) {
    return { shouldStart: true, shouldPersist: persistBudgetHit, reason: "token_budget" };
  }
  if (messageRule) {
    return {
      shouldStart: true,
      shouldPersist: false,
      reason:
        input.startBudgetTokens === null ? "window_unknown_message_threshold" : "message_threshold",
    };
  }
  return { shouldStart: false, shouldPersist: false, reason: "message_threshold" };
}

/** Mode selection for one turn boundary (server-side, per call scenario). */
export function compactionModeForTurn(input: {
  decision: Pick<CompactionTriggerDecision, "shouldStart" | "shouldPersist">;
  envOverride: CompactionMode | null;
}): CompactionMode {
  if (input.envOverride) return input.envOverride;
  if (!input.decision.shouldStart) return "disabled";
  return input.decision.shouldPersist ? "background_wait_if_needed" : "background_nowait";
}

export interface EnsureCompactedResult {
  compacted: boolean;
  summary: string | null;
  historyCompactedUpToSeq: number | null;
  generation: number;
  mode: CompactionMode;
  waitedMs: number;
  syncRescues: number;
}

export interface EnsureCompactedDeps {
  loadThread(): Promise<{
    historyCompactedUpToSeq: number | null;
    historyCompactionSummary: string | null;
    historyCompactionGeneration: number;
    nextMessageSeq: number;
  }>;
  enqueueBackground(): Promise<void>;
  /** One bounded synchronous compaction attempt (same process). */
  compactOnce(): Promise<void>;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

/**
 * Executes the four modes against one thread and generation. `neededUpToSeq`
 * is the cursor the caller needs (usually nextMessageSeq-1 or the batch tail);
 * waits and sync rescues stop at the generation fence, so a concurrent clear
 * ends the loop instead of drifting the cursor.
 */
export async function ensureHistoryCompacted(
  deps: EnsureCompactedDeps,
  mode: CompactionMode,
  options: {
    generation: number;
    neededUpToSeq: number;
    waitTimeoutMs?: number;
    pollIntervalMs?: number;
    maxSyncRescues?: number;
  },
): Promise<EnsureCompactedResult> {
  const waitTimeoutMs = options.waitTimeoutMs ?? 45_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const maxSyncRescues = options.maxSyncRescues ?? 4;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  let syncRescues = 0;

  const snapshot = async () => {
    const thread = await deps.loadThread();
    return thread;
  };

  if (mode === "disabled") {
    const thread = await snapshot();
    return {
      compacted: false,
      summary: thread.historyCompactionSummary,
      historyCompactedUpToSeq: thread.historyCompactedUpToSeq,
      generation: thread.historyCompactionGeneration,
      mode,
      waitedMs: 0,
      syncRescues: 0,
    };
  }

  if (mode === "background_nowait") {
    await deps.enqueueBackground();
    const thread = await snapshot();
    return {
      compacted: (thread.historyCompactedUpToSeq ?? -1) >= options.neededUpToSeq,
      summary: thread.historyCompactionSummary,
      historyCompactedUpToSeq: thread.historyCompactedUpToSeq,
      generation: thread.historyCompactionGeneration,
      mode,
      waitedMs: 0,
      syncRescues: 0,
    };
  }

  if (mode === "sync") {
    let thread = await snapshot();
    while (
      (thread.historyCompactedUpToSeq ?? -1) < options.neededUpToSeq &&
      thread.historyCompactionGeneration === options.generation &&
      syncRescues < maxSyncRescues
    ) {
      await deps.compactOnce();
      syncRescues += 1;
      thread = await snapshot();
    }
    return {
      compacted:
        thread.historyCompactionGeneration === options.generation &&
        (thread.historyCompactedUpToSeq ?? -1) >= options.neededUpToSeq,
      summary: thread.historyCompactionSummary,
      historyCompactedUpToSeq: thread.historyCompactedUpToSeq,
      generation: thread.historyCompactionGeneration,
      mode,
      waitedMs: now() - startedAt,
      syncRescues,
    };
  }

  // background_wait_if_needed: enqueue, bounded wait on the same generation,
  // then synchronous rescue when the background job is not enough.
  await deps.enqueueBackground();
  let thread = await snapshot();
  const deadline = startedAt + waitTimeoutMs;
  while (
    (thread.historyCompactedUpToSeq ?? -1) < options.neededUpToSeq &&
    thread.historyCompactionGeneration === options.generation &&
    now() < deadline
  ) {
    await sleep(pollIntervalMs);
    thread = await snapshot();
  }
  if (
    (thread.historyCompactedUpToSeq ?? -1) < options.neededUpToSeq &&
    thread.historyCompactionGeneration === options.generation
  ) {
    const rescued = await ensureHistoryCompacted(deps, "sync", {
      generation: options.generation,
      neededUpToSeq: options.neededUpToSeq,
      maxSyncRescues,
    });
    syncRescues = rescued.syncRescues;
    thread = await snapshot();
  }
  return {
    compacted:
      thread.historyCompactionGeneration === options.generation &&
      (thread.historyCompactedUpToSeq ?? -1) >= options.neededUpToSeq,
    summary: thread.historyCompactionSummary,
    historyCompactedUpToSeq: thread.historyCompactedUpToSeq,
    generation: thread.historyCompactionGeneration,
    mode,
    waitedMs: now() - startedAt,
    syncRescues,
  };
}

/** Convenience estimator callers can use for request-size math. */
export function estimateRequestTokens(parts: Array<string | undefined | null>): number {
  let total = 0;
  for (const part of parts) {
    if (part) total += estimatePromptTokens(part);
  }
  return total;
}

export const CONTEXT_OVERFLOW_MESSAGE =
  "This conversation no longer fits the model's context window even after compaction. Shorten the input, switch this bot to a model with a larger window, or start a new thread — the original messages are preserved and nothing was deleted.";

/**
 * Post-compaction overflow guard (ME-02 M4): a hard, honest failure only
 * when the estimated request cannot fit the RAW known window at all. The
 * estimator is deliberately conservative (CJK counts ~1 token/char and can
 * overestimate real tokenizer counts), so margins are NOT subtracted here —
 * they belong to the trigger decisions, and subtracting them would kill
 * runnable long CJK conversations. Unknown windows never fabricate a
 * failure; the provider remains the final authority for borderline sizes.
 */
export function detectContextOverflow(input: {
  contextWindowTokens: number | undefined | null;
  estimatedRequestTokens: number;
}): string | null {
  const window = input.contextWindowTokens;
  if (!window || window <= 0) return null;
  if (input.estimatedRequestTokens > window) {
    return CONTEXT_OVERFLOW_MESSAGE;
  }
  return null;
}
