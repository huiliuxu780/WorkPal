import {
  type ExecutionEntry,
  type ExecutionResult,
  type ExecutionSection,
  type ExecutionSummary,
  ExecutionSummarySchema,
  MAX_SUMMARY_ARTIFACTS,
  MessageBlock,
  type RunStatus,
  type WaitKind,
} from "@rakazo/contracts";
import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { botMessageContext } from "./bot-messages.js";
import { runFailureError } from "./events.js";
import { parseRunOrchestration } from "./product-harness/orchestration.js";

/**
 * ExecutionSnapshot builders (HISTORY-001). Pure functions over already
 * normalized facts: no Prisma, no clock, no randomness, no model calls.
 * The DB layer collects facts; the API layer authorizes and serializes.
 */

const TITLE_MAX = 120;
const OUTCOME_MAX = 200;
const RESULT_BLOCK_LIMIT = 40;

function snippet(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

/** Triggers whose whole purpose is an out-of-conversation delivery of a result. */
const RESULT_TRIGGERS = new Set([
  "routine",
  "delivery",
  "webhook",
  "messaging",
  "call_end",
  "cloud_agent",
  "spawn",
]);

export function executionEntryFor(input: {
  trigger: string;
  orchestration: unknown;
}): ExecutionEntry {
  const parentRunId = parseRunOrchestration(input.orchestration)?.collaboration?.parentRunId;
  if (input.trigger === "bot_message" || (parentRunId && parentRunId !== ""))
    return "collaboration";
  if (RESULT_TRIGGERS.has(input.trigger)) return "result";
  return "execution";
}

export type ExecutionSummaryFacts = {
  run: {
    id: string;
    threadId: string;
    botId: string;
    status: RunStatus;
    waitKind: string | null;
    trigger: string;
    error: string | null;
    orchestration: unknown;
    startedAt: string | null;
    completedAt: string | null;
    /** Immutable creation time; the updatedAt fallback for Runs without events. */
    createdAt: string;
  };
  /** Highest product event seq for this Run; 0 when none survive (legacy/cleared). */
  rev: number;
  /**
   * Newest surviving event time, ISO. `updatedAt` is derived from this (never
   * from `runs.updatedAt`): invisible row writes such as lease renewals move
   * the row timestamp without moving `rev`, and the contract requires one rev
   * to identify exactly one summary content.
   */
  lastEventAt?: string | null;
  taskPrompt?: string | null;
  /** Source message blocks when trigger is bot_message, for the peer title. */
  peerSourceBlocks?: unknown;
  /** Blocks of the Run's committed result Message, when one exists. */
  outcomeBlocks?: unknown;
  counts?: { steps?: number; actions?: number; agents?: number; artifacts?: number };
  artifacts?: Array<{ id: string; name: string; mimeType?: string }>;
  artifactsTotal?: number;
  anchorMessageId?: string | null;
  /** True when the timeline scan was clipped by its window. */
  activityTruncated?: boolean;
  retryOfRunId?: string | null;
  retrySuccessorRunId?: string | null;
  manualRetry?: ExecutionSummary["manualRetry"];
};

function factsTitle(facts: ExecutionSummaryFacts): string {
  if (facts.run.trigger === "bot_message") {
    const parsed = MessageBlock.array().safeParse(facts.peerSourceBlocks);
    const context = parsed.success ? botMessageContext(parsed.data) : undefined;
    if (context) {
      const name = context.fromBotName.trim() || "Another agent";
      const label =
        context.intent === "result" || context.intent === "status" || context.intent === "fyi"
          ? `Update from ${name}`
          : `${name} asked`;
      return snippet(context.text.trim() ? `${label}: ${context.text}` : label, TITLE_MAX);
    }
  }
  const prompt = facts.taskPrompt?.trim();
  if (prompt) return snippet(prompt, TITLE_MAX);
  const outcome = resultOutcomeText(facts.outcomeBlocks);
  if (outcome) return snippet(outcome, TITLE_MAX);
  return "Run";
}

function resultOutcomeText(blocks: unknown): string | null {
  const parsed = MessageBlock.array().safeParse(blocks);
  if (!parsed.success) return null;
  const text = parsed.data
    .filter((block) => block.kind === "text")
    .map((block) => (block.kind === "text" ? block.text : ""))
    .join(" ")
    .trim();
  return text || null;
}

/**
 * Build one ExecutionSummary. Field semantics are fixed by the contract:
 * unknown counts are omitted (never 0), outcome only ever quotes a real
 * result message, and failure goes through the display-safe mapper.
 */
export function buildExecutionSummary(facts: ExecutionSummaryFacts): ExecutionSummary {
  const { run } = facts;
  const waitKind =
    run.waitKind === "input" || run.waitKind === "approval" || run.waitKind === "takeover"
      ? (run.waitKind as WaitKind)
      : null;
  const artifacts = (facts.artifacts ?? []).slice(0, MAX_SUMMARY_ARTIFACTS);
  const counts: NonNullable<ExecutionSummary["counts"]> = {};
  if (typeof facts.counts?.steps === "number") counts.steps = facts.counts.steps;
  if (typeof facts.counts?.actions === "number") counts.actions = facts.counts.actions;
  if (typeof facts.counts?.agents === "number") counts.agents = facts.counts.agents;
  if (typeof facts.artifactsTotal === "number") counts.artifacts = facts.artifactsTotal;
  else if (typeof facts.counts?.artifacts === "number") counts.artifacts = facts.counts.artifacts;
  const hasCounts = Object.keys(counts).length > 0;
  const incomplete: ExecutionSection[] = [];
  if (facts.activityTruncated) incomplete.push("activity");
  if (typeof facts.artifactsTotal === "number" && facts.artifactsTotal > artifacts.length) {
    incomplete.push("artifacts");
  }
  const outcome = resultOutcomeText(facts.outcomeBlocks);
  const failure =
    run.status === "failed"
      ? runFailureError({ type: "run.failed", payload: { error: run.error ?? undefined } })
      : null;
  const startedAt = run.startedAt ? Date.parse(run.startedAt) : null;
  const completedAt = run.completedAt ? Date.parse(run.completedAt) : null;
  return ExecutionSummarySchema.parse({
    runId: run.id,
    threadId: run.threadId,
    botId: run.botId,
    rev: facts.rev,
    status: run.status,
    ...(waitKind
      ? { waitKind }
      : run.status === "waiting_input" || run.status === "waiting_takeover"
        ? { waitKind: null }
        : {}),
    trigger: run.trigger as ExecutionSummary["trigger"],
    title: factsTitle(facts),
    ...(outcome ? { outcome: snippet(outcome, OUTCOME_MAX) } : {}),
    ...(failure ? { failure } : {}),
    ...(run.startedAt !== null ? { startedAt: run.startedAt } : {}),
    ...(run.completedAt !== null ? { completedAt: run.completedAt } : {}),
    updatedAt: facts.lastEventAt ?? run.createdAt,
    ...(startedAt !== null && completedAt !== null && completedAt >= startedAt
      ? { durationMs: completedAt - startedAt }
      : {}),
    ...(hasCounts ? { counts } : {}),
    artifacts,
    entry: executionEntryFor({ trigger: run.trigger, orchestration: run.orchestration }),
    ...(facts.anchorMessageId ? { anchorMessageId: facts.anchorMessageId } : {}),
    ...(incomplete.length > 0 ? { incompleteSections: incomplete } : {}),
    ...(facts.retryOfRunId ? { retryOfRunId: facts.retryOfRunId } : {}),
    ...(facts.retrySuccessorRunId ? { retrySuccessorRunId: facts.retrySuccessorRunId } : {}),
    ...(facts.manualRetry ? { manualRetry: facts.manualRetry } : {}),
  });
}

/**
 * The Run's committed result, from its real terminal bot message. Ask blocks
 * (Approval/Input cards) never count as a result and are stripped from the
 * payload; an ask-only or absent message yields no result.
 */
export function pickExecutionResult(input: {
  messageId: string;
  blocks: unknown;
}): ExecutionResult | null {
  const parsed = MessageBlock.array().safeParse(input.blocks);
  if (!parsed.success) return null;
  const blocks = parsed.data.filter((block) => block.kind !== "ask");
  if (blocks.length === 0) return null;
  const truncated = blocks.length > RESULT_BLOCK_LIMIT;
  return {
    messageId: input.messageId,
    blocks: (truncated ? blocks.slice(0, RESULT_BLOCK_LIMIT) : blocks) as ExecutionResult["blocks"],
    truncated,
  };
}

/**
 * Compose the Run's snapshot version from its two monotonic sources:
 *
 * - `eventCeiling` — the highest product Event seq attributed to the Run.
 *   Covers every event-driven content change (Activity, results, artifacts,
 *   Interventions, Plan/Step/Todo, lifecycle events).
 * - `rowVersion` — the `runs.snapshotRev` counter a BEFORE UPDATE trigger
 *   increments when a snapshot-visible Run column changes without an event
 *   (claim → leased, promote → running/startedAt, fence reconciliation,
 *   computer requeue). Background-task projection writers also increment it
 *   explicitly when their visible status changes without a Run event. Lease
 *   renewals and other invisible writes never bump.
 *
 * The sum is monotonic within a Thread generation (neither component ever
 * decreases there), deterministic for a committed state, isolated per Run,
 * and built from durable counters only — never a timestamp or a content hash.
 */
export function composeRunRev(input: { eventCeiling: number; rowVersion: number }): number {
  return input.eventCeiling + input.rowVersion;
}

/* ------------------------------------------------------------------ */
/* Activity pagination cursor                                          */
/* ------------------------------------------------------------------ */

export type ExecutionActivityCursor = {
  /** Cursor layout version. */
  v: 1;
  /** Bound to one Run. */
  r: string;
  /** Bound to the Thread's clear generation (thread.cleared event seq). */
  g: number;
  /** Highest event seq observed when the walk started (upper bound). */
  hi: number;
  /** Exclusive upper bound for the NEXT page. */
  nx: number;
};

export function encodeExecutionActivityCursor(cursor: ExecutionActivityCursor): string {
  return base64urlEncode(JSON.stringify(cursor));
}

/** Strict decode: any foreign shape, key, or version is rejected (null). */
export function decodeExecutionActivityCursor(
  value: string | undefined,
): ExecutionActivityCursor | null {
  if (!value) return null;
  const json = base64urlDecode(value);
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "g,hi,nx,r,v") return null;
  if (record.v !== 1) return null;
  if (typeof record.r !== "string" || !record.r) return null;
  for (const key of ["g", "hi", "nx"] as const) {
    const number = record[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < 0) return null;
  }
  const g = record.g as number;
  const hi = record.hi as number;
  const nx = record.nx as number;
  if (nx > hi) return null;
  return { v: 1, r: record.r, g, hi, nx };
}
