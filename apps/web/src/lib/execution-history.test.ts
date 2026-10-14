// @vitest-environment jsdom
import type {
  ActivityItem,
  ExecutionActivityPage,
  ExecutionSnapshot,
  ExecutionSummary,
  Run,
} from "@rakazo/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendExecutionActivityPage,
  executionDataForRun,
  executionRunState,
  expansionLogShape,
  forceOpenExpansion,
  installExecutionDetail,
  isExpansionOpen,
  mergeActivityPages,
  planExpansionDefaults,
  readExecutionExpansions,
  resolveExecutionAnchor,
  selectCachedDetailEntry,
  summariesByRun,
  toggleExpansion,
} from "./execution-history.js";

function activityItem(id: string, status: ActivityItem["status"] = "completed"): ActivityItem {
  return {
    id,
    runId: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    kind: "tool",
    status,
    title: "Ran a tool",
  };
}

function detailSnapshot(
  activityPageItems: ActivityItem[],
  timeline: ActivityItem[],
): ExecutionSnapshot {
  return {
    summary: summary(),
    steps: { items: [], truncated: false },
    todos: { items: [], truncated: false },
    timeline,
    activityPage: { items: activityPageItems, olderCursor: null, truncated: false },
    interventions: [],
  } as ExecutionSnapshot;
}

function summary(overrides: Partial<ExecutionSummary> = {}): ExecutionSummary {
  return {
    runId: "run-1",
    threadId: "thread-1",
    botId: "bot-1",
    rev: 5,
    status: "completed",
    trigger: "user",
    title: "Summarize the quarter",
    updatedAt: "2026-10-12T00:01:00.000Z",
    artifacts: [],
    entry: "execution",
    anchorMessageId: "message-anchor",
    ...overrides,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("summariesByRun / resolveExecutionAnchor", () => {
  it("keeps the legacy path when the server has no executions", () => {
    expect(summariesByRun(null)).toBeNull();
    expect(summariesByRun({})).toBeNull();
    expect(summariesByRun({ executions: [summary()] })?.get("run-1")?.title).toBe(
      "Summarize the quarter",
    );
  });

  it("uses the server anchor and falls back only without one", () => {
    expect(resolveExecutionAnchor({ summary: summary(), legacyAnchorMessageId: "legacy" })).toBe(
      "message-anchor",
    );
    expect(
      resolveExecutionAnchor({
        summary: summary({ anchorMessageId: undefined }),
        legacyAnchorMessageId: "legacy",
      }),
    ).toBe("legacy");
    expect(resolveExecutionAnchor({ legacyAnchorMessageId: "legacy" })).toBe("legacy");
    // A paged-out anchor must not hide the shell — fall back until loaded.
    expect(
      resolveExecutionAnchor({
        summary: summary(),
        legacyAnchorMessageId: "__tail",
        anchorIsLoaded: false,
      }),
    ).toBe("__tail");
  });
});

describe("execution data resolution", () => {
  it("prefers the fetched detail snapshot", () => {
    const data = executionDataForRun({
      runId: "run-1",
      detail: detailSnapshot([], []),
      legacy: { steps: [{ runId: "run-1" } as never], activity: [] },
    });
    expect(data.steps).toEqual([]);
    expect(data.summary?.rev).toBe(5);
  });

  it("renders the full first Activity page, never just the short timeline", () => {
    const pageItems = Array.from({ length: 50 }, (_, i) => activityItem(`tool:run-1:e${i}`));
    const timeline = pageItems.slice(-24);
    const data = executionDataForRun({
      runId: "run-1",
      detail: detailSnapshot(pageItems, timeline),
      legacy: {},
    });
    // The regression: timeline-only rendering silently dropped items 0..25.
    expect(data.activity.map((item) => item.id)).toEqual(pageItems.map((item) => item.id));
    expect(data.activity).toHaveLength(50);
  });

  it("falls back to the legacy arrays per Run without leaking other Runs", () => {
    const data = executionDataForRun({
      runId: "run-1",
      legacy: {
        plans: [{ runId: "other" } as never],
        steps: [{ runId: "run-1", title: "mine" } as never, { runId: "other" } as never],
        todos: [],
        activity: [{ runId: "run-1", id: "a" } as never],
      },
    });
    expect(data.plan).toBeUndefined();
    expect(data.steps).toHaveLength(1);
    expect(data.activity).toHaveLength(1);
  });
});

describe("mergeActivityPages", () => {
  it("covers every id exactly once and keeps the newer status", () => {
    const newer = [activityItem("tool:a", "completed"), activityItem("tool:b", "completed")];
    const older = [activityItem("tool:c", "completed"), activityItem("tool:a", "running")];
    const merged = mergeActivityPages(newer, older);
    expect(merged.map((item) => item.id)).toEqual(["tool:c", "tool:a", "tool:b"]);
    expect(merged.find((item) => item.id === "tool:a")?.status).toBe("completed");
    // 120+ items across three pages: no gap, no duplicate.
    const p1 = Array.from({ length: 50 }, (_, i) => activityItem(`t${100 + i}`));
    const p2 = Array.from({ length: 50 }, (_, i) => activityItem(`t${50 + i}`));
    const p3 = Array.from({ length: 50 }, (_, i) => activityItem(`t${i}`));
    const all = mergeActivityPages(mergeActivityPages(p1, p2), p3);
    expect(all).toHaveLength(150);
    expect(new Set(all.map((item) => item.id)).size).toBe(150);
  });
});

describe("rev-versioned detail cache", () => {
  function snapshotAt(
    rev: number,
    firstPage: ActivityItem[] = [],
    olderCursor: string | null = null,
  ): ExecutionSnapshot {
    return {
      ...detailSnapshot(firstPage, []),
      summary: summary({ rev }),
      activityPage: { items: firstPage, olderCursor, truncated: false },
    } as ExecutionSnapshot;
  }
  const page = (items: ActivityItem[], olderCursor: string | null): ExecutionActivityPage =>
    ({ items, olderCursor, truncated: false }) as ExecutionActivityPage;

  it("serves a detail newer than a stale live summary, but not an older detail", () => {
    const cache = installExecutionDetail({}, "run-1", snapshotAt(5));
    expect(selectCachedDetailEntry(cache, "run-1", 5)?.snapshot.summary.rev).toBe(5);
    expect(selectCachedDetailEntry(cache, "run-1", 6)).toBeUndefined();
    expect(selectCachedDetailEntry(cache, "run-1", 4)?.snapshot.summary.rev).toBe(5);
    expect(selectCachedDetailEntry(cache, "run-2", 5)).toBeUndefined();
    // Legacy server without summaries keeps the cache usable.
    expect(selectCachedDetailEntry(cache, "run-1", null)).toBeDefined();
  });

  it("restores status from a page summary and prefers a genuinely fresher detail", () => {
    const staleRun = { id: "run-1", status: "running", waitKind: null } as Run;
    const initial = summary({ rev: 5, status: "running" });
    const fresh = { ...snapshotAt(6), summary: summary({ rev: 6, status: "completed" }) };
    expect(executionRunState({ run: null, summary: summary({ status: "failed" }) })).toEqual({
      id: "run-1",
      status: "failed",
      waitKind: null,
    });
    expect(executionRunState({ run: staleRun, summary: initial, detail: fresh })).toEqual({
      id: "run-1",
      status: "completed",
      waitKind: null,
    });
    // A thread summary can lag a live Run; absent a newer detail, keep the
    // Run's observed status instead of replacing it with the older summary.
    expect(
      executionRunState({ run: staleRun, summary: summary({ rev: 5, status: "queued" }) }),
    ).toBe(staleRun);
  });

  it("replaces detail, cursor and loaded pages together on a newer rev", () => {
    let cache = installExecutionDetail({}, "run-1", snapshotAt(5, [activityItem("a5")], "c5-next"));
    cache = appendExecutionActivityPage(cache, "run-1", 5, page([activityItem("a4")], "c5-older"));
    expect(cache["run-1"]!.olderActivity.map((item) => item.id)).toEqual(["a4"]);

    cache = installExecutionDetail(cache, "run-1", snapshotAt(6, [activityItem("a6")], "c6-next"));
    const entry = cache["run-1"]!;
    expect(entry.rev).toBe(6);
    expect(entry.olderCursor).toBe("c6-next");
    expect(entry.olderActivity).toEqual([]);
    expect(entry.snapshot.activityPage.items.map((item) => item.id)).toEqual(["a6"]);
  });

  it("drops an out-of-order older response whole — cursor and pages keep the newer version", () => {
    let cache = installExecutionDetail({}, "run-1", snapshotAt(6, [activityItem("a6")], "c6-next"));
    cache = appendExecutionActivityPage(cache, "run-1", 6, page([activityItem("a5")], "c6-older"));
    const settled = cache;

    // The rev-5 fetch was in flight while rev 6 landed; its late response
    // must not touch the detail, the cursor, or the loaded older pages.
    const after = installExecutionDetail(
      cache,
      "run-1",
      snapshotAt(5, [activityItem("a5-stale-first")], "c5-stale"),
    );
    expect(after).toBe(settled);
    expect(after["run-1"]!.rev).toBe(6);
    expect(after["run-1"]!.olderCursor).toBe("c6-older");
    expect(after["run-1"]!.olderActivity.map((item) => item.id)).toEqual(["a5"]);
    expect(after["run-1"]!.snapshot.activityPage.items.map((item) => item.id)).toEqual(["a6"]);
  });

  it("keeps loaded pages when a duplicate response for the same rev arrives", () => {
    let cache = installExecutionDetail({}, "run-1", snapshotAt(5, [], "c5-next"));
    cache = appendExecutionActivityPage(cache, "run-1", 5, page([activityItem("older")], null));
    const after = installExecutionDetail(cache, "run-1", snapshotAt(5, [], "c5-next"));
    expect(after).toBe(cache);
    expect(after["run-1"]!.olderActivity.map((item) => item.id)).toEqual(["older"]);
  });

  it("discards a load-more page whose detail version moved on in flight", () => {
    let cache = installExecutionDetail({}, "run-1", snapshotAt(5, [activityItem("a5")], "c5-next"));
    cache = installExecutionDetail(
      cache,
      "run-1",
      snapshotAt(6, [activityItem("a6"), activityItem("a5", "running")], "c6-next"),
    );

    const stale = appendExecutionActivityPage(
      cache,
      "run-1",
      5,
      page([activityItem("a4")], "c5-older"),
    );
    expect(stale).toBe(cache);
    expect(stale["run-1"]!.olderCursor).toBe("c6-next");
    expect(stale["run-1"]!.olderActivity).toEqual([]);

    // The matching version merges, drops ids the newer first page already
    // covers (the render-side merge keeps the newer status), and adopts the
    // page's cursor.
    const fresh = appendExecutionActivityPage(
      cache,
      "run-1",
      6,
      page([activityItem("a5"), activityItem("a4")], "c6-older"),
    );
    expect(fresh["run-1"]!.olderActivity.map((item) => item.id)).toEqual(["a4"]);
    expect(fresh["run-1"]!.olderCursor).toBe("c6-older");
  });

  it("ignores a page for a Run that is not cached", () => {
    const cache = installExecutionDetail({}, "run-1", snapshotAt(5));
    expect(appendExecutionActivityPage(cache, "run-2", 5, page([activityItem("x")], null))).toBe(
      cache,
    );
  });
});

describe("expansion sessionStorage", () => {
  it("drops a stored decision once the rev moved", () => {
    const entries = toggleExpansion({
      entries: {},
      threadId: "thread-1",
      runId: "run-1",
      rev: 5,
      currentlyOpen: false,
    });
    expect(
      isExpansionOpen({
        entries,
        threadId: "thread-1",
        runId: "run-1",
        rev: 5,
        defaultOpen: false,
      }),
    ).toBe(true);
    expect(
      isExpansionOpen({
        entries,
        threadId: "thread-1",
        runId: "run-1",
        rev: 6,
        defaultOpen: false,
      }),
    ).toBe(false);
    expect(
      isExpansionOpen({ entries, threadId: "thread-1", runId: "run-1", rev: 5, defaultOpen: true }),
    ).toBe(true);
  });

  it("keeps at most one Run open per thread", () => {
    let entries = toggleExpansion({
      entries: {},
      threadId: "t",
      runId: "a",
      rev: 1,
      currentlyOpen: false,
    });
    entries = toggleExpansion({ entries, threadId: "t", runId: "b", rev: 1, currentlyOpen: false });
    expect(
      isExpansionOpen({ entries, threadId: "t", runId: "a", rev: 1, defaultOpen: false }),
    ).toBe(false);
    expect(
      isExpansionOpen({ entries, threadId: "t", runId: "b", rev: 1, defaultOpen: false }),
    ).toBe(true);
    entries = toggleExpansion({ entries, threadId: "t", runId: "b", rev: 1, currentlyOpen: true });
    expect(
      isExpansionOpen({ entries, threadId: "t", runId: "b", rev: 1, defaultOpen: false }),
    ).toBe(false);
  });

  it("never touches another Thread's stored expansions", () => {
    let entries = toggleExpansion({
      entries: {},
      threadId: "thread-A",
      runId: "a1",
      rev: 1,
      currentlyOpen: false,
    });
    entries = toggleExpansion({
      entries,
      threadId: "thread-B",
      runId: "b1",
      rev: 1,
      currentlyOpen: false,
    });
    // Opening thread-B's run must not close thread-A's.
    expect(
      isExpansionOpen({ entries, threadId: "thread-A", runId: "a1", rev: 1, defaultOpen: false }),
    ).toBe(true);
    expect(
      isExpansionOpen({ entries, threadId: "thread-B", runId: "b1", rev: 1, defaultOpen: false }),
    ).toBe(true);
    // Within thread A, opening a second run closes the first.
    entries = toggleExpansion({
      entries,
      threadId: "thread-A",
      runId: "a2",
      rev: 1,
      currentlyOpen: false,
    });
    expect(
      isExpansionOpen({ entries, threadId: "thread-A", runId: "a1", rev: 1, defaultOpen: false }),
    ).toBe(false);
    expect(
      isExpansionOpen({ entries, threadId: "thread-A", runId: "a2", rev: 1, defaultOpen: false }),
    ).toBe(true);
    expect(
      isExpansionOpen({ entries, threadId: "thread-B", runId: "b1", rev: 1, defaultOpen: false }),
    ).toBe(true);
  });

  it("persists only the four expansion fields and never snapshot payloads", () => {
    toggleExpansion({ entries: {}, threadId: "t", runId: "r", rev: 2, currentlyOpen: false });
    const stored = window.sessionStorage.getItem("rk:execution-expansion") ?? "";
    expect(stored).not.toBe("");
    expect(stored).not.toContain("Summarize");
    expect(stored).not.toContain("sk-live");
    const parsed = JSON.parse(stored) as Record<string, Record<string, unknown>>;
    for (const entry of Object.values(parsed)) {
      expect(Object.keys(entry).sort()).toEqual(["open", "rev", "runId", "threadId"]);
    }
    expect(expansionLogShape(readExecutionExpansions())).toHaveLength(1);
  });

  it("ignores garbage in storage", () => {
    window.sessionStorage.setItem("rk:execution-expansion", "not-json");
    expect(readExecutionExpansions()).toEqual({});
    window.sessionStorage.setItem("rk:execution-expansion", JSON.stringify({ x: { threadId: 1 } }));
    expect(readExecutionExpansions()).toEqual({});
  });
});

describe("planExpansionDefaults", () => {
  const run = (runId: string, status: string, rev = 1) => ({ runId, rev, status });

  it("opens at most one detail for two concurrent waiting Runs", () => {
    const plan = planExpansionDefaults({
      entries: {},
      threadId: "t",
      runs: [run("w1", "waiting_input"), run("w2", "waiting_takeover")],
    });
    const opens = [...plan.values()].filter(Boolean);
    expect(opens).toHaveLength(1);
    expect(plan.get("w1")).toBe(true);
    expect(plan.get("w2")).toBe(false);
  });

  it("opens at most one detail for two active Runs and keeps failed behind them", () => {
    const plan = planExpansionDefaults({
      entries: {},
      threadId: "t",
      runs: [run("f1", "failed"), run("a1", "running"), run("a2", "running")],
    });
    expect(plan.get("a1")).toBe(true);
    expect(plan.get("a2")).toBe(false);
    expect(plan.get("f1")).toBe(false);
  });

  it("lets a failed Run take the slot when nothing else is open", () => {
    const plan = planExpansionDefaults({
      entries: {},
      threadId: "t",
      runs: [run("c1", "completed"), run("f1", "failed")],
    });
    expect(plan.get("f1")).toBe(true);
    expect(plan.get("c1")).toBe(false);
  });

  it("keeps terminal Runs collapsed", () => {
    const plan = planExpansionDefaults({
      entries: {},
      threadId: "t",
      runs: [run("c1", "completed"), run("c2", "cancelled")],
    });
    expect([...plan.values()].filter(Boolean)).toHaveLength(0);
  });

  it("honors a stored collapse for a waiting Run", () => {
    const plan = planExpansionDefaults({
      entries: {
        "t:w1": { threadId: "t", runId: "w1", rev: 1, open: false },
      },
      threadId: "t",
      runs: [run("w1", "waiting_input"), run("a1", "running")],
    });
    expect(plan.get("w1")).toBe(false);
    expect(plan.get("a1")).toBe(true);
  });

  it("honors a stored open and denies the default to a new active Run", () => {
    const plan = planExpansionDefaults({
      entries: {
        "t:c1": { threadId: "t", runId: "c1", rev: 3, open: true },
      },
      threadId: "t",
      runs: [run("c1", "completed", 3), run("a1", "running")],
    });
    expect(plan.get("c1")).toBe(true);
    expect(plan.get("a1")).toBe(false);
  });

  it("discards stored decisions whose rev moved and re-applies defaults", () => {
    const plan = planExpansionDefaults({
      entries: {
        "t:c1": { threadId: "t", runId: "c1", rev: 1, open: false },
      },
      threadId: "t",
      runs: [run("c1", "failed", 2)],
    });
    expect(plan.get("c1")).toBe(true);
  });
  it("normalizes duplicate stored open entries to exactly one open detail", () => {
    const plan = planExpansionDefaults({
      entries: {
        "t:w1": { threadId: "t", runId: "w1", rev: 1, open: true },
        "t:w2": { threadId: "t", runId: "w2", rev: 1, open: true },
      },
      threadId: "t",
      runs: [run("w1", "waiting_input"), run("w2", "waiting_takeover")],
    });
    // Deterministic winner: first in priority order (both are active waits,
    // so input order decides).
    expect(plan.get("w1")).toBe(true);
    expect(plan.get("w2")).toBe(false);
    expect([...plan.values()].filter(Boolean)).toHaveLength(1);
  });

  it("gives the single stored-open slot by priority across status classes", () => {
    const plan = planExpansionDefaults({
      entries: {
        "t:c1": { threadId: "t", runId: "c1", rev: 2, open: true },
        "t:a1": { threadId: "t", runId: "a1", rev: 2, open: true },
      },
      threadId: "t",
      runs: [run("c1", "completed", 2), run("a1", "running", 2)],
    });
    expect(plan.get("a1")).toBe(true);
    expect(plan.get("c1")).toBe(false);
    expect([...plan.values()].filter(Boolean)).toHaveLength(1);
  });
});

describe("forceOpenExpansion (Task Center return navigation)", () => {
  it("opens the target Run and closes every other open entry of the same Thread", () => {
    const entries = {
      "t:other": { threadId: "t", runId: "other", rev: 3, open: true },
      "t2:elsewhere": { threadId: "t2", runId: "elsewhere", rev: 1, open: true },
    };
    const next = forceOpenExpansion({ entries, threadId: "t", runId: "target", rev: 7 });
    expect(next["t:target"]).toEqual({ threadId: "t", runId: "target", rev: 7, open: true });
    expect(next["t:other"]!.open).toBe(false);
    // Other Threads' stored decisions are never touched.
    expect(next["t2:elsewhere"]!.open).toBe(true);
    expect(
      Object.values(next).filter((entry) => entry.open && entry.threadId === "t"),
    ).toHaveLength(1);
  });

  it("is idempotent and rev-pinned for the plan authority", () => {
    const once = forceOpenExpansion({ entries: {}, threadId: "t", runId: "r", rev: 5 });
    const twice = forceOpenExpansion({ entries: once, threadId: "t", runId: "r", rev: 5 });
    expect(twice).toEqual(once);
    // The stored entry feeds planExpansionDefaults as the authoritative open.
    const plan = planExpansionDefaults({
      entries: twice,
      threadId: "t",
      runs: [
        { runId: "r", rev: 5, status: "completed" },
        { runId: "live", rev: 1, status: "running" },
      ],
    });
    expect(plan.get("r")).toBe(true);
    expect(plan.get("live")).toBe(false);
  });
});
