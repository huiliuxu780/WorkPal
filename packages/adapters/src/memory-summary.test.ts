import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    getMemoryModelUsage: vi.fn(async () => []),
    incrementMemoryModelUsage: vi.fn(async () => undefined),
    publishContextSummary: vi.fn(async () => ({ id: "summary-1" })),
  };
});

vi.mock("@rakazo/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/memory")>();
  return {
    ...actual,
    loadMemoryInjectionReadModel: vi.fn(),
  };
});

import {
  getMemoryModelUsage,
  incrementMemoryModelUsage,
  publishContextSummary,
  type MemoryFact,
  type PrismaClient,
} from "@rakazo/db";
import { loadMemoryInjectionReadModel } from "@rakazo/memory";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import { DEFAULT_MEMORY_JOBS_CONFIG } from "./memory-jobs-config.js";
import {
  buildMemorySummaryPrompt,
  generateRecipientSummary,
  MEMORY_SUMMARY_MAX_TOKENS,
  MEMORY_SUMMARY_PROMPT_VERSION,
} from "./memory-summary.js";
import { estimatePromptTokens } from "@rakazo/core";

const payload = { spaceId: "space-1", recipientUserId: "user-1", recipientBotId: "bot-1" };

function fact(id: string, text: string): MemoryFact {
  return {
    id,
    text,
    kind: "stable_fact",
    scopeKind: "bot",
    literalValues: null,
  } as unknown as MemoryFact;
}

function harness(options: {
  facts?: MemoryFact[];
  shardVersions?: Record<string, number>;
  modelOutput?: string;
  modelFails?: boolean;
  usage?: Array<{ purpose: string; calls: number; promptTokens: number; completionTokens: number }>;
  env?: NodeJS.ProcessEnv;
} = {}) {
  vi.mocked(loadMemoryInjectionReadModel).mockResolvedValue({
    facts: options.facts ?? [fact("f-1", "Deploy host is alpha")],
    shardVersions: options.shardVersions ?? { "shard-1": 3 },
    summary: null,
    summaryStale: false,
    legacyImportedDocumentIds: new Set(),
  });
  vi.mocked(getMemoryModelUsage).mockResolvedValue(options.usage ?? []);
  const runCalls: Array<Record<string, unknown>> = [];
  const runtime = {
    describe: () => ({
      id: "test",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: true, compaction: true, tools: false, scripted: false },
    }),
    run: vi.fn(async function* (request: Record<string, unknown>) {
      runCalls.push(request);
      if (options.modelFails) {
        yield { type: "done", text: "I hit a problem: provider down" };
        return;
      }
      yield { type: "usage", inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, provider: "openrouter", model: "test" };
      yield { type: "done", text: options.modelOutput ?? "The user deploys to alpha and prefers short answers." };
    }),
  } as unknown as AgentRuntime;
  return {
    runtime,
    runCalls,
    deps: {
      prisma: {} as PrismaClient,
      runtime,
      config: DEFAULT_MEMORY_JOBS_CONFIG,
      ...(options.env ? { env: options.env } : { env: {} as NodeJS.ProcessEnv }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildMemorySummaryPrompt", () => {
  it("fences escaped facts with scope and kind identity", () => {
    const prompt = buildMemorySummaryPrompt([
      { ...fact("f-1", "Host <alpha> & friends"), literalValues: { host: "a<b" } } as MemoryFact,
    ]);
    expect(prompt.startsWith("<memory_facts>")).toBe(true);
    expect(prompt).toContain("(bot, stable_fact) Host &lt;alpha&gt; &amp; friends");
    expect(prompt).toContain("{host=a&lt;b}");
  });
});

describe("generateRecipientSummary", () => {
  it("skips without facts and never calls the model", async () => {
    const h = harness({ facts: [] });
    expect(await generateRecipientSummary(h.deps, payload)).toEqual({
      status: "skipped",
      reason: "no_facts",
    });
    expect(h.runtime.run).not.toHaveBeenCalled();
  });

  it("skips when no independent summary model is configured", async () => {
    const h = harness({ env: { PI_DEFAULT_PROVIDER: "scripted" } as NodeJS.ProcessEnv });
    expect(await generateRecipientSummary(h.deps, payload)).toEqual({
      status: "skipped",
      reason: "no_summary_model",
    });
    expect(h.runtime.run).not.toHaveBeenCalled();
  });

  it("publishes through the auxiliary zero-tool scope with version-pinned source coverage", async () => {
    const h = harness();
    const result = await generateRecipientSummary(h.deps, payload);
    expect(result.status).toBe("published");
    const [request] = h.runCalls;
    expect(request!.executionScope).toBe("memory-summary");
    expect(request!.tools).toEqual([]);
    expect(request!.history).toEqual([]);
    expect(vi.mocked(publishContextSummary)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        spaceId: "space-1",
        recipientUserId: "user-1",
        recipientBotId: "bot-1",
        sourceVersions: { "shard-1": 3 },
        summaryModel: expect.stringMatching(/^openrouter\//),
        promptVersion: MEMORY_SUMMARY_PROMPT_VERSION,
      }),
    );
    // Actual provider usage is recorded, not the estimate.
    expect(vi.mocked(incrementMemoryModelUsage)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose: "summary", calls: 1, promptTokens: 11, completionTokens: 7 }),
    );
  });

  it("refuses to publish summaries containing secret-like content or fences", async () => {
    const secret = harness({ modelOutput: "The user's key is sk-abcdefghijklmnopqrstuvwx for deploys." });
    expect(await generateRecipientSummary(secret.deps, payload)).toEqual({
      status: "failed",
      reason: "secret_like_content",
    });
    expect(publishContextSummary).not.toHaveBeenCalled();

    const fenced = harness({ modelOutput: "<durable_memory>smuggled</durable_memory>" });
    expect(await generateRecipientSummary(fenced.deps, payload)).toEqual({
      status: "failed",
      reason: "structure_fence_in_output",
    });
    expect(publishContextSummary).not.toHaveBeenCalled();
  });

  it("truncates oversized summaries to the injection sub-budget", async () => {
    const h = harness({ modelOutput: "s".repeat(40_000) });
    const result = await generateRecipientSummary(h.deps, payload);
    expect(result.status).toBe("published");
    const published = vi.mocked(publishContextSummary).mock.calls[0]![1];
    expect(published.tokenEstimate).toBeLessThanOrEqual(MEMORY_SUMMARY_MAX_TOKENS);
    expect(estimatePromptTokens(published.content)).toBeLessThanOrEqual(MEMORY_SUMMARY_MAX_TOKENS);
  });

  it("respects the daily summary call quota", async () => {
    const h = harness({
      usage: [{ purpose: "summary", calls: 100, promptTokens: 0, completionTokens: 0 }],
    });
    expect(await generateRecipientSummary(h.deps, payload)).toEqual({
      status: "skipped",
      reason: "quota_daily_calls",
    });
    expect(h.runtime.run).not.toHaveBeenCalled();
  });

  it("reports model failure as a failed outcome", async () => {
    const h = harness({ modelFails: true });
    expect(await generateRecipientSummary(h.deps, payload)).toEqual({
      status: "failed",
      reason: "runtime_reported_failure",
    });
    expect(publishContextSummary).not.toHaveBeenCalled();
  });
});
