import type { UsageRange, UsageSummary } from "@rakazo/contracts";

export type UsageLoadState = {
  range: UsageRange;
  summary: UsageSummary | null;
  loading: boolean;
  error: boolean;
};

/**
 * Range switching for the settings Usage panel with a request-version fence:
 * only the newest request may commit its response, so a slow earlier range can
 * never overwrite a newer one, and a failed request clears the summary instead
 * of leaving stale numbers under the new range label.
 */
export function createUsageLoader(
  fetchSummary: (range: UsageRange) => Promise<UsageSummary>,
  onChange: (state: UsageLoadState) => void,
) {
  let current = 0;
  let state: UsageLoadState = { range: "all", summary: null, loading: false, error: false };
  const emit = (patch: Partial<UsageLoadState>) => {
    state = { ...state, ...patch };
    onChange(state);
  };
  return {
    get state(): UsageLoadState {
      return state;
    },
    load(range: UsageRange): Promise<void> {
      const requestId = ++current;
      emit({ range, loading: true, error: false });
      return fetchSummary(range).then(
        (summary) => {
          if (requestId !== current) return;
          emit({ summary, loading: false });
        },
        () => {
          if (requestId !== current) return;
          emit({ summary: null, loading: false, error: true });
        },
      );
    },
  };
}

export type UsageLoader = ReturnType<typeof createUsageLoader>;
