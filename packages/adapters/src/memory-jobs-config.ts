import { resolveDeploymentModel } from "./deployment-model.js";

/**
 * ME-02 server-side configuration for the memory jobs (extraction, summary,
 * outbox). Every value is a server config with an env override, an actual
 * default and a documented unit — the worker never reads process.env inline
 * for these. Automatic inference additionally requires the per-space policy
 * row to be "on" (default "off"); this config bounds cost when it is.
 */

export interface MemoryJobsConfig {
  /** Rollback switch: false disables new-layer reads AND all memory jobs. */
  factsEnabled: boolean;
  /** Messages scanned per extraction job (count). */
  extractScanBatchMessages: number;
  /** Trusted messages handed to one extraction model call (count). */
  extractMaxMessagesPerCall: number;
  /** Escaped transcript cap per extraction call (characters). */
  extractMaxInputChars: number;
  /** Candidates accepted from one extraction call (count). */
  extractMaxCandidatesPerCall: number;
  /** Extraction model calls per user per UTC day (calls/day). */
  extractDailyCallsPerUser: number;
  /** Summary model calls per user per UTC day (calls/day). */
  summaryDailyCallsPerUser: number;
  /** Estimated prompt+completion tokens per user per UTC day across memory
   * auxiliaries (estimated tokens/day; no billing data exists, so cost is
   * bounded through tokens and calls). */
  dailyTokensPerUser: number;
  /** Facts handed to one summary call (count). */
  summaryMaxFacts: number;
  /** Escaped fact list cap per summary call (characters). */
  summaryMaxInputChars: number;
  /** Outbox rows claimed per drain job (count). */
  outboxBatchSize: number;
  /** Outbox drain sweep interval (milliseconds). */
  outboxSweepMs: number;
  /** Periodic extraction gap-scan interval (milliseconds). */
  scanSweepMs: number;
  /** Recipients fanned out per changed shard (count). */
  summaryFanoutLimit: number;
  /** Auxiliary model timeout (milliseconds). */
  auxCallTimeoutMs: number;
}

export const DEFAULT_MEMORY_JOBS_CONFIG: MemoryJobsConfig = {
  factsEnabled: true,
  extractScanBatchMessages: 200,
  extractMaxMessagesPerCall: 50,
  extractMaxInputChars: 20_000,
  extractMaxCandidatesPerCall: 5,
  extractDailyCallsPerUser: 50,
  summaryDailyCallsPerUser: 100,
  dailyTokensPerUser: 200_000,
  summaryMaxFacts: 200,
  summaryMaxInputChars: 12_000,
  outboxBatchSize: 20,
  outboxSweepMs: 30_000,
  scanSweepMs: 300_000,
  summaryFanoutLimit: 20,
  auxCallTimeoutMs: 120_000,
};

function positiveInt(source: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = source[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function memoryJobsConfigFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): MemoryJobsConfig {
  const defaults = DEFAULT_MEMORY_JOBS_CONFIG;
  return {
    // Rollback switch (P4 §7): off keeps the new tables for repair but stops
    // new reads and every memory job.
    factsEnabled: source.WORKPAL_MEMORY_FACTS_ENABLED?.trim() !== "false",
    extractScanBatchMessages: positiveInt(source, "WORKPAL_MEMORY_EXTRACT_SCAN_BATCH", defaults.extractScanBatchMessages),
    extractMaxMessagesPerCall: positiveInt(source, "WORKPAL_MEMORY_EXTRACT_MAX_MESSAGES", defaults.extractMaxMessagesPerCall),
    extractMaxInputChars: positiveInt(source, "WORKPAL_MEMORY_EXTRACT_MAX_INPUT_CHARS", defaults.extractMaxInputChars),
    extractMaxCandidatesPerCall: positiveInt(source, "WORKPAL_MEMORY_EXTRACT_MAX_CANDIDATES", defaults.extractMaxCandidatesPerCall),
    extractDailyCallsPerUser: positiveInt(source, "WORKPAL_MEMORY_EXTRACT_DAILY_CALLS", defaults.extractDailyCallsPerUser),
    summaryDailyCallsPerUser: positiveInt(source, "WORKPAL_MEMORY_SUMMARY_DAILY_CALLS", defaults.summaryDailyCallsPerUser),
    dailyTokensPerUser: positiveInt(source, "WORKPAL_MEMORY_DAILY_TOKENS", defaults.dailyTokensPerUser),
    summaryMaxFacts: positiveInt(source, "WORKPAL_MEMORY_SUMMARY_MAX_FACTS", defaults.summaryMaxFacts),
    summaryMaxInputChars: positiveInt(source, "WORKPAL_MEMORY_SUMMARY_MAX_INPUT_CHARS", defaults.summaryMaxInputChars),
    outboxBatchSize: positiveInt(source, "WORKPAL_MEMORY_OUTBOX_BATCH", defaults.outboxBatchSize),
    outboxSweepMs: positiveInt(source, "WORKPAL_MEMORY_OUTBOX_SWEEP_MS", defaults.outboxSweepMs),
    scanSweepMs: positiveInt(source, "WORKPAL_MEMORY_SCAN_SWEEP_MS", defaults.scanSweepMs),
    summaryFanoutLimit: positiveInt(source, "WORKPAL_MEMORY_SUMMARY_FANOUT", defaults.summaryFanoutLimit),
    auxCallTimeoutMs: positiveInt(source, "WORKPAL_MEMORY_AUX_TIMEOUT_MS", defaults.auxCallTimeoutMs),
  };
}

/**
 * Extraction and summary models are configured separately from the main chat
 * model. Format "provider/modelId"; the deployment key for that provider is
 * reused (no new secret material). An unresolvable configuration fails the
 * job visibly instead of silently swapping in the chat model.
 */
export function resolveMemoryAuxModel(
  purpose: "extraction" | "summary",
  env: NodeJS.ProcessEnv = process.env,
): { provider: string; id: string; apiKey?: string } | null {
  const configured = (
    purpose === "extraction" ? env.WORKPAL_MEMORY_EXTRACTION_MODEL : env.WORKPAL_MEMORY_SUMMARY_MODEL
  )?.trim();
  if (configured) {
    const slash = configured.indexOf("/");
    if (slash <= 0 || slash === configured.length - 1) return null;
    const provider = configured.slice(0, slash);
    const id = configured.slice(slash + 1);
    // Resolve the key for exactly this provider through the deployment table.
    const deployment = resolveDeploymentModel({ ...env, PI_DEFAULT_PROVIDER: provider, PI_DEFAULT_MODEL: id });
    if (deployment.provider !== provider) return null;
    return { provider, id, ...(deployment.key ? { apiKey: deployment.key } : {}) };
  }
  const deployment = resolveDeploymentModel(env);
  if (deployment.provider === "scripted") return null;
  return {
    provider: deployment.provider,
    id: deployment.model,
    ...(deployment.key ? { apiKey: deployment.key } : {}),
  };
}
