export type AutomaticRetryReason = "llm_timeout" | "network_error" | "provider_5xx" | "lease_lost";

/** Delays after the first and second failed execution attempts. */
export const RUN_RETRY_DELAYS_MS = [5_000, 30_000] as const;

export function automaticRetryDelayMs(input: {
  completedAutoRetries: number;
  reason: AutomaticRetryReason;
  hasCommittedOrUncertainEffect: boolean;
  hasToolCall: boolean;
}): number | null {
  if (input.hasCommittedOrUncertainEffect || input.hasToolCall) return null;
  return RUN_RETRY_DELAYS_MS[input.completedAutoRetries] ?? null;
}
