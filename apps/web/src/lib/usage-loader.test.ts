import { describe, expect, it, vi } from "vitest";
import type { UsageRange, UsageSummary } from "@rakazo/contracts";
import { createUsageLoader, type UsageLoadState } from "./usage-loader";

const summary = (calls: number): UsageSummary => ({
  calls,
  inputTokens: calls * 10,
  outputTokens: calls * 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  byModel: [],
});

function setup() {
  const states: UsageLoadState[] = [];
  const fetchers = new Map<UsageRange, () => Promise<UsageSummary>>();
  const loader = createUsageLoader((range) => {
    const fetcher = fetchers.get(range);
    if (!fetcher) throw new Error(`unexpected range ${range}`);
    return fetcher();
  }, (state) => states.push(state));
  return { loader, states, fetchers };
}

describe("usage loader request fence", () => {
  it("drops a late response from an earlier range", async () => {
    const { loader, states, fetchers } = setup();
    let resolveWeek: (value: UsageSummary) => void = () => {};
    let resolveMonth: (value: UsageSummary) => void = () => {};
    fetchers.set("7d", () => new Promise((resolve) => (resolveWeek = resolve)));
    fetchers.set("30d", () => new Promise((resolve) => (resolveMonth = resolve)));

    const week = loader.load("7d");
    const month = loader.load("30d");
    // The newer range resolves first; the stale week response arrives later.
    resolveMonth(summary(30));
    await month;
    resolveWeek(summary(7));
    await week;

    const last = states.at(-1)!;
    expect(last.range).toBe("30d");
    expect(last.summary?.calls).toBe(30);
    expect(last.loading).toBe(false);
    expect(states.some((state) => state.summary?.calls === 7)).toBe(false);
  });

  it("clears the summary and reports the error of the current request", async () => {
    const { loader, states, fetchers } = setup();
    fetchers.set("all", () => Promise.resolve(summary(3)));
    await loader.load("all");
    expect(states.at(-1)?.summary?.calls).toBe(3);

    fetchers.set("7d", () => Promise.reject(new Error("network down")));
    await loader.load("7d");
    const last = states.at(-1)!;
    expect(last.range).toBe("7d");
    expect(last.error).toBe(true);
    expect(last.loading).toBe(false);
    expect(last.summary).toBeNull();
  });

  it("ignores a late success after a newer request already failed", async () => {
    const { loader, states, fetchers } = setup();
    let resolveWeek: (value: UsageSummary) => void = () => {};
    fetchers.set("7d", () => new Promise((resolve) => (resolveWeek = resolve)));
    fetchers.set("30d", () => Promise.reject(new Error("down")));

    const week = loader.load("7d");
    await loader.load("30d");
    expect(states.at(-1)?.error).toBe(true);
    resolveWeek(summary(7));
    await week;
    const last = states.at(-1)!;
    expect(last.range).toBe("30d");
    expect(last.summary).toBeNull();
    expect(last.error).toBe(true);
  });

  it("reports loading only for the in-flight request", async () => {
    const { loader, states, fetchers } = setup();
    const onChange = vi.fn();
    fetchers.set("all", () => Promise.resolve(summary(1)));
    onChange.mockClear();
    const pending = loader.load("all");
    expect(loader.state.loading).toBe(true);
    expect(states.at(-1)?.loading).toBe(true);
    await pending;
    expect(loader.state.loading).toBe(false);
  });
});
