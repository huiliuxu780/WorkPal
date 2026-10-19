import { describe, expect, it, vi } from "vitest";
import {
  availableHistoryBudgetTokens,
  compactionMarginsFromEnv,
  compactionModeForTurn,
  compactionModeFromEnv,
  CONTEXT_OVERFLOW_MESSAGE,
  DEFAULT_COMPACTION_MARGINS,
  decideCompactionTrigger,
  detectContextOverflow,
  ensureHistoryCompacted,
  validateCompactionMargins,
} from "./compaction-mode.js";

describe("validateCompactionMargins", () => {
  it("rejects persist margins that would fire before start", () => {
    expect(() =>
      validateCompactionMargins({
        ...DEFAULT_COMPACTION_MARGINS,
        persistMarginTokens: DEFAULT_COMPACTION_MARGINS.startMarginTokens + 1,
      }),
    ).toThrow(/persist margins must not exceed start margins/);
    expect(() =>
      validateCompactionMargins({ ...DEFAULT_COMPACTION_MARGINS, persistMarginRatio: 0.5 }),
    ).toThrow(/persist margins must not exceed start margins/);
    expect(() =>
      validateCompactionMargins({ ...DEFAULT_COMPACTION_MARGINS, startMarginTokens: -1 }),
    ).toThrow(/non-negative/);
  });

  it("reads overrides from env with documented fallbacks", () => {
    const margins = compactionMarginsFromEnv({
      WORKPAL_COMPACTION_START_MARGIN_TOKENS: "9000",
      WORKPAL_COMPACTION_PERSIST_MARGIN_RATIO: "0.04",
    } as NodeJS.ProcessEnv);
    expect(margins.startMarginTokens).toBe(9000);
    expect(margins.persistMarginRatio).toBe(0.04);
    expect(margins.outputReserveTokens).toBe(DEFAULT_COMPACTION_MARGINS.outputReserveTokens);
  });
});

describe("availableHistoryBudgetTokens", () => {
  it("subtracts system prompt, tool schemas, input, reserve and margin from the window", () => {
    const budget = availableHistoryBudgetTokens({
      contextWindowTokens: 128_000,
      systemPromptTokens: 3_000,
      toolSchemaTokens: 2_000,
      currentInputTokens: 1_000,
      margins: DEFAULT_COMPACTION_MARGINS,
    });
    // 128000 - 3000 - 2000 - 1000 - 4000(reserve) - max(8000, 12800) = 105200
    expect(budget).toBe(105_200);
  });

  it("is honestly null when the window is unknown", () => {
    expect(
      availableHistoryBudgetTokens({
        contextWindowTokens: undefined,
        systemPromptTokens: 0,
        toolSchemaTokens: 0,
        currentInputTokens: 0,
        margins: DEFAULT_COMPACTION_MARGINS,
      }),
    ).toBeNull();
  });

  it("persist budget is larger than start budget (persist fires later)", () => {
    const base = {
      contextWindowTokens: 128_000,
      systemPromptTokens: 3_000,
      toolSchemaTokens: 2_000,
      currentInputTokens: 1_000,
      margins: DEFAULT_COMPACTION_MARGINS,
    };
    const start = availableHistoryBudgetTokens(base)!;
    const persist = availableHistoryBudgetTokens({ ...base, persist: true })!;
    expect(persist).toBeGreaterThan(start);
  });
});

describe("decideCompactionTrigger", () => {
  const base = {
    windowSize: 50,
    batchSize: 50,
    startBudgetTokens: 10_000,
    persistBudgetTokens: 14_000,
  };

  it("fires the token rule with an honest reason", () => {
    const startOnly = decideCompactionTrigger({
      ...base,
      nextMessageSeq: 60,
      historyCompactedUpToSeq: null,
      estimatedUncompactedTokens: 12_000,
    });
    // Between the start (10k) and persist (14k) budgets: start only.
    expect(startOnly).toEqual({ shouldStart: true, shouldPersist: false, reason: "token_budget" });

    const both = decideCompactionTrigger({
      ...base,
      nextMessageSeq: 60,
      historyCompactedUpToSeq: null,
      estimatedUncompactedTokens: 15_000,
    });
    expect(both).toEqual({ shouldStart: true, shouldPersist: true, reason: "token_budget" });
  });

  it("falls back to the message-count rule when the window is unknown", () => {
    const decision = decideCompactionTrigger({
      ...base,
      startBudgetTokens: null,
      persistBudgetTokens: null,
      nextMessageSeq: 100,
      historyCompactedUpToSeq: null,
      estimatedUncompactedTokens: null,
    });
    expect(decision).toEqual({
      shouldStart: true,
      shouldPersist: false,
      reason: "window_unknown_message_threshold",
    });
  });

  it("stays quiet below both rules", () => {
    const decision = decideCompactionTrigger({
      ...base,
      nextMessageSeq: 40,
      historyCompactedUpToSeq: null,
      estimatedUncompactedTokens: 2_000,
    });
    expect(decision.shouldStart).toBe(false);
  });
});

describe("compactionModeForTurn", () => {
  it("maps decisions to modes and honors the env override", () => {
    expect(
      compactionModeForTurn({ decision: { shouldStart: true, shouldPersist: false }, envOverride: null }),
    ).toBe("background_nowait");
    expect(
      compactionModeForTurn({ decision: { shouldStart: true, shouldPersist: true }, envOverride: null }),
    ).toBe("background_wait_if_needed");
    expect(
      compactionModeForTurn({ decision: { shouldStart: false, shouldPersist: false }, envOverride: null }),
    ).toBe("disabled");
    expect(
      compactionModeForTurn({ decision: { shouldStart: true, shouldPersist: true }, envOverride: "disabled" }),
    ).toBe("disabled");
    expect(compactionModeFromEnv({ WORKPAL_HISTORY_COMPACTION_MODE: "sync" })).toBe("sync");
    expect(compactionModeFromEnv({ WORKPAL_HISTORY_COMPACTION_MODE: "bogus" })).toBeNull();
  });
});

describe("ensureHistoryCompacted", () => {
  function threadState(cursor: number | null, generation = 0) {
    return {
      historyCompactedUpToSeq: cursor,
      historyCompactionSummary: cursor === null ? null : "summary",
      historyCompactionGeneration: generation,
      nextMessageSeq: 200,
    };
  }

  it("disabled never enqueues or waits", async () => {
    const enqueue = vi.fn();
    const result = await ensureHistoryCompacted(
      {
        loadThread: async () => threadState(10),
        enqueueBackground: enqueue,
        compactOnce: async () => undefined,
      },
      "disabled",
      { generation: 0, neededUpToSeq: 60 },
    );
    expect(result.compacted).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("background_nowait enqueues once and returns immediately", async () => {
    const enqueue = vi.fn(async () => undefined);
    const compactOnce = vi.fn();
    const result = await ensureHistoryCompacted(
      {
        loadThread: async () => threadState(10),
        enqueueBackground: enqueue,
        compactOnce,
      },
      "background_nowait",
      { generation: 0, neededUpToSeq: 60 },
    );
    expect(enqueue).toHaveBeenCalledOnce();
    expect(compactOnce).not.toHaveBeenCalled();
    expect(result.compacted).toBe(false);
    expect(result.waitedMs).toBe(0);
  });

  it("sync loops bounded rescues until the needed range is compacted", async () => {
    let cursor = 10;
    const compactOnce = vi.fn(async () => {
      cursor += 50;
    });
    const result = await ensureHistoryCompacted(
      {
        loadThread: async () => threadState(cursor),
        enqueueBackground: vi.fn(),
        compactOnce,
      },
      "sync",
      { generation: 0, neededUpToSeq: 110 },
    );
    expect(compactOnce).toHaveBeenCalledTimes(2);
    expect(result.compacted).toBe(true);
    expect(result.syncRescues).toBe(2);
  });

  it("sync stops at the generation fence instead of drifting a cleared cursor", async () => {
    const compactOnce = vi.fn(async () => undefined);
    const result = await ensureHistoryCompacted(
      {
        // The thread was cleared mid-loop: generation moved on.
        loadThread: async () => threadState(10, 3),
        enqueueBackground: vi.fn(),
        compactOnce,
      },
      "sync",
      { generation: 0, neededUpToSeq: 110 },
    );
    expect(compactOnce).not.toHaveBeenCalled();
    expect(result.compacted).toBe(false);
  });

  it("wait_if_needed escalates to a sync rescue when the background job stalls", async () => {
    let clock = 0;
    let cursor = 10;
    let rescued = false;
    const result = await ensureHistoryCompacted(
      {
        loadThread: async () => threadState(cursor),
        enqueueBackground: vi.fn(async () => undefined),
        compactOnce: async () => {
          rescued = true;
          cursor = 120;
        },
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
      "background_wait_if_needed",
      { generation: 0, neededUpToSeq: 60, waitTimeoutMs: 3_000, pollIntervalMs: 1_000 },
    );
    expect(rescued).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.syncRescues).toBe(1);
    expect(result.waitedMs).toBeGreaterThanOrEqual(3_000);
  });
});

describe("detectContextOverflow", () => {
  it("never fabricates a failure for unknown windows", () => {
    expect(
      detectContextOverflow({
        contextWindowTokens: undefined,
        estimatedRequestTokens: 10_000_000,
        margins: DEFAULT_COMPACTION_MARGINS,
      }),
    ).toBeNull();
  });

  it("fails with actionable guidance when the request exceeds the proportional reserve", () => {
    const message = detectContextOverflow({
      contextWindowTokens: 8_192,
      estimatedRequestTokens: 7_500,
      margins: DEFAULT_COMPACTION_MARGINS,
    });
    expect(message).toBe(CONTEXT_OVERFLOW_MESSAGE);
    expect(message).toContain("new thread");
  });

  it("keeps normal small-window requests running", () => {
    expect(
      detectContextOverflow({
        contextWindowTokens: 8_192,
        estimatedRequestTokens: 3_000,
        margins: DEFAULT_COMPACTION_MARGINS,
      }),
    ).toBeNull();
  });
});
