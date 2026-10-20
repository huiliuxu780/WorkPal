import type { AgentRuntime } from "@rakazo/adapter-kit";
import { createHash } from "node:crypto";
import { containsSecretLikeContent, estimatePromptTokens, promptSegment } from "@rakazo/core";
import type { MemoryFact, PrismaClient } from "@rakazo/db";
import {
  incrementMemoryModelUsage,
  getMemoryModelUsage,
  publishContextSummary,
} from "@rakazo/db";
import { loadMemoryInjectionReadModel } from "@rakazo/memory";
import { getLogger } from "@rakazo/logging";

import { truncateToEstimatedTokens } from "./memory-injection.js";
import { resolveMemoryAuxModel, type MemoryJobsConfig } from "./memory-jobs-config.js";

/**
 * ME-02 M2: ContextSummary generation. One auxiliary AgentScope execution
 * (zero tools, zero history) summarizes exactly the active facts visible to
 * one recipient; the result passes structure, sensitive-content and budget
 * validation, then publishes with a version CAS so a concurrent fact change
 * can never be overwritten by a stale summary. The generation model is
 * configured separately from the main chat model.
 */

const SUMMARY_INSTRUCTIONS = promptSegment("auxiliary/memory-summary");

/** Prompt version = digest of the exact instruction bytes (AG-04: git is the
 * version tracker; the digest makes the recorded identity unambiguous). */
export const MEMORY_SUMMARY_PROMPT_VERSION = `memory-summary@${createHash("sha256")
  .update(SUMMARY_INSTRUCTIONS, "utf8")
  .digest("hex")
  .slice(0, 12)}`;

/** Summary hard cap mirrors the injection sub-budget (estimated tokens). */
export const MEMORY_SUMMARY_MAX_TOKENS = 1_200;

export interface MemorySummaryDeps {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  config: MemoryJobsConfig;
  env?: NodeJS.ProcessEnv;
}

export function buildMemorySummaryPrompt(facts: MemoryFact[]): string {
  const lines = facts.map((fact) => {
    const literals =
      fact.literalValues && typeof fact.literalValues === "object" && !Array.isArray(fact.literalValues)
        ? Object.entries(fact.literalValues as Record<string, unknown>)
            .filter(([, value]) => typeof value === "string")
            .map(([key, value]) => `${key}=${String(value)}`)
            .join("; ")
        : "";
    const scope = `${fact.scopeKind}`;
    return `- (${scope}, ${fact.kind}) ${escapePromptData(fact.text)}${literals ? ` {${escapePromptData(literals)}}` : ""}`;
  });
  return `<memory_facts>\n${lines.join("\n")}\n</memory_facts>`;
}

function escapePromptData(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export type MemorySummaryOutcome =
  | { status: "published"; tokenEstimate: number; model: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export async function generateRecipientSummary(
  deps: MemorySummaryDeps,
  payload: { spaceId: string; recipientUserId: string; recipientBotId: string },
): Promise<MemorySummaryOutcome> {
  if (!deps.config.factsEnabled) return { status: "skipped", reason: "facts_disabled" };
  const startedAt = Date.now();
  const readModel = await loadMemoryInjectionReadModel(
    { prisma: deps.prisma },
    {
      spaceId: payload.spaceId,
      userId: payload.recipientUserId,
      botId: payload.recipientBotId,
    },
  );
  if (readModel.facts.length === 0) {
    return { status: "skipped", reason: "no_facts" };
  }
  const shardIds = Object.keys(readModel.shardVersions);
  if (shardIds.length === 0) {
    return { status: "skipped", reason: "no_shards" };
  }

  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const usage = await getMemoryModelUsage(deps.prisma, {
    spaceId: payload.spaceId,
    userId: payload.recipientUserId,
    day,
  });
  const summaryCalls = usage.find((row) => row.purpose === "summary")?.calls ?? 0;
  const totalTokens = usage.reduce(
    (sum, row) => sum + row.promptTokens + row.completionTokens,
    0,
  );
  if (summaryCalls >= deps.config.summaryDailyCallsPerUser) {
    getLogger().warn("memory.summary quota reached", {
      "memory.summary.reason": "daily_calls",
      "space.id": payload.spaceId,
    });
    return { status: "skipped", reason: "quota_daily_calls" };
  }
  if (totalTokens >= deps.config.dailyTokensPerUser) {
    getLogger().warn("memory.summary quota reached", {
      "memory.summary.reason": "daily_tokens",
      "space.id": payload.spaceId,
    });
    return { status: "skipped", reason: "quota_daily_tokens" };
  }

  const model = resolveMemoryAuxModel("summary", deps.env);
  if (!model) return { status: "skipped", reason: "no_summary_model" };
  if (!deps.runtime.describe().capabilities.compaction || model.provider === "scripted") {
    // Same rule as history compaction: the scripted runtime answers with canned
    // text; publishing that as a summary would fabricate memory content.
    return { status: "skipped", reason: "runtime_cannot_summarize" };
  }

  const facts = readModel.facts.slice(0, deps.config.summaryMaxFacts);
  const prompt = buildMemorySummaryPrompt(facts);
  if (prompt.length > deps.config.summaryMaxInputChars) {
    return { status: "skipped", reason: "input_exceeds_budget" };
  }

  const modelIdentity = `${model.provider}/${model.id}`;
  let summary = "";
  let runtimeReportedFailure = false;
  let usageTokens: { input: number; output: number } | null = null;
  try {
    for await (const event of deps.runtime.run(
      {
        botId: payload.recipientBotId,
        // Synthetic identity: auxiliary executions are keyed by scope+runId in
        // the runtime and never touch a product thread.
        threadId: `memory-summary:${payload.recipientBotId}`,
        runId: `memory-summary:${payload.recipientUserId}:${payload.recipientBotId}`,
        executionScope: "memory-summary",
        prompt,
        instructions: SUMMARY_INSTRUCTIONS,
        history: [],
        tools: [],
        model,
        allowSilentEmpty: true,
      },
      {
        operationId: `memory-summary:${payload.spaceId}:${payload.recipientUserId}:${payload.recipientBotId}`,
        traceId: `memory-summary:${payload.spaceId}`,
        spaceId: payload.spaceId,
        userId: payload.recipientUserId,
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
        else summary = text;
      }
    }
  } catch (error) {
    getLogger().error("memory.summary model call failed", error, {
      "memory.summary.model": modelIdentity,
    });
    throw error; // retryable through the job queue
  }
  if (runtimeReportedFailure || !summary) {
    return { status: "failed", reason: runtimeReportedFailure ? "runtime_reported_failure" : "empty_summary" };
  }

  // Structure and safety validation before anything is published.
  if (containsSecretLikeContent(summary)) {
    getLogger().error("memory.summary refused: secret-like content in summary", {
      "memory.summary.reason": "secret_like_content",
      "space.id": payload.spaceId,
    });
    return { status: "failed", reason: "secret_like_content" };
  }
  if (/<\/?[a-z_]+>/i.test(summary)) {
    // Fences belong to the assembler, never to summary prose.
    return { status: "failed", reason: "structure_fence_in_output" };
  }
  const capped = truncateToEstimatedTokens(summary, MEMORY_SUMMARY_MAX_TOKENS);
  const tokenEstimate = estimatePromptTokens(capped);

  const published = await publishContextSummary(deps.prisma, {
    spaceId: payload.spaceId,
    recipientUserId: payload.recipientUserId,
    recipientBotId: payload.recipientBotId,
    sourceVersions: readModel.shardVersions,
    content: capped,
    summaryModel: modelIdentity,
    promptVersion: MEMORY_SUMMARY_PROMPT_VERSION,
    tokenEstimate,
  });
  await incrementMemoryModelUsage(deps.prisma, {
    spaceId: payload.spaceId,
    userId: payload.recipientUserId,
    day,
    purpose: "summary",
    calls: 1,
    promptTokens: usageTokens?.input ?? estimatePromptTokens(prompt),
    completionTokens: usageTokens?.output ?? tokenEstimate,
  });
  getLogger().info("memory.summary published", {
    "memory.summary.id": published.id,
    "memory.summary.model": modelIdentity,
    "memory.summary.prompt_version": MEMORY_SUMMARY_PROMPT_VERSION,
    "memory.summary.token_estimate": tokenEstimate,
    "memory.summary.fact_count": facts.length,
    "memory.summary.duration_ms": Date.now() - startedAt,
    "space.id": payload.spaceId,
  });
  return { status: "published", tokenEstimate, model: modelIdentity };
}
