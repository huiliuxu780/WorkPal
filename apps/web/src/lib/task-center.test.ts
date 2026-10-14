import type { TaskCenterItem, TaskCenterPage } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));

import { i18n } from "@lingui/core";
import { deriveExecutionStatus } from "./execution-status";
import {
  applyTaskCenterAppend,
  applyTaskCenterRefresh,
  clearTaskCenterNavIntent,
  emptyTaskCenterList,
  peekTaskCenterNavIntent,
  setTaskCenterNavIntent,
  type TaskCenterListState,
  taskCenterVerb,
} from "./task-center";

i18n.load("en", {});
i18n.activate("en");

function item(runId: string, overrides: Partial<TaskCenterItem["summary"]> = {}): TaskCenterItem {
  return {
    summary: {
      runId,
      threadId: `thread-${runId}`,
      botId: `bot-${runId}`,
      rev: 1,
      status: "running",
      trigger: "user",
      title: `Task ${runId}`,
      updatedAt: "2026-10-12T00:00:00.000Z",
      artifacts: [],
      entry: "execution",
      ...overrides,
    },
    target: { kind: "bot", botId: `bot-${runId}` },
  };
}

function page(items: TaskCenterItem[], overrides: Partial<TaskCenterPage> = {}): TaskCenterPage {
  return { items, nextCursor: null, activeCount: items.length, ...overrides };
}

describe("applyTaskCenterRefresh", () => {
  it("replaces the list with the authoritative window", () => {
    const state: TaskCenterListState = {
      ...emptyTaskCenterList,
      items: [item("a"), item("b")],
      appliedRequest: 1,
      epoch: 1,
    };
    const next = applyTaskCenterRefresh(state, page([item("b"), item("c")]), 2);
    expect(next.items.map((entry) => entry.summary.runId)).toEqual(["b", "c"]);
    expect(next.epoch).toBe(2);
  });

  it("drops items the fresh window no longer carries (cleared Runs disappear)", () => {
    const state = applyTaskCenterRefresh(emptyTaskCenterList, page([item("a"), item("b")]), 1);
    const next = applyTaskCenterRefresh(state, page([item("b")]), 2);
    expect(next.items.map((entry) => entry.summary.runId)).toEqual(["b"]);
  });

  it("keeps the higher rev when the same Run exists on both sides", () => {
    const state: TaskCenterListState = {
      ...emptyTaskCenterList,
      items: [item("a", { rev: 7, status: "completed" })],
      appliedRequest: 1,
      epoch: 1,
    };
    const next = applyTaskCenterRefresh(state, page([item("a", { rev: 5 })]), 2);
    expect(next.items[0]!.summary.rev).toBe(7);
    expect(next.items[0]!.summary.status).toBe("completed");
  });

  it("discards out-of-order and duplicate responses whole", () => {
    const state = applyTaskCenterRefresh(emptyTaskCenterList, page([item("a", { rev: 9 })]), 5);
    const stale = applyTaskCenterRefresh(state, page([item("a", { rev: 2 }), item("z")]), 4);
    expect(stale).toBe(state);
    const duplicate = applyTaskCenterRefresh(state, page([]), 5);
    expect(duplicate).toBe(state);
  });

  it("never lets a stale refresh regress the count", () => {
    const state = applyTaskCenterRefresh(
      emptyTaskCenterList,
      page([item("a")], { activeCount: 3 }),
      2,
    );
    const stale = applyTaskCenterRefresh(state, page([], { activeCount: 0 }), 1);
    expect(stale.activeCount).toBe(3);
  });
});

describe("applyTaskCenterAppend", () => {
  const first = applyTaskCenterRefresh(
    emptyTaskCenterList,
    page([item("a"), item("b")], { nextCursor: "cursor-1", activeCount: 2 }),
    1,
  );

  it("appends new pages without duplicating a Run", () => {
    const next = applyTaskCenterAppend(
      first,
      page([item("b"), item("c")], { nextCursor: null }),
      2,
      first.epoch,
    );
    expect(next.items.map((entry) => entry.summary.runId)).toEqual(["a", "b", "c"]);
    expect(next.nextCursor).toBeNull();
  });

  it("lets the higher rev win in place during a merge", () => {
    const next = applyTaskCenterAppend(
      first,
      page([item("b", { rev: 4, status: "completed" })], { activeCount: 1 }),
      2,
      first.epoch,
    );
    const merged = next.items.find((entry) => entry.summary.runId === "b")!;
    expect(merged.summary.rev).toBe(4);
    expect(next.items.filter((entry) => entry.summary.runId === "b")).toHaveLength(1);
    const stale = applyTaskCenterAppend(next, page([item("b", { rev: 2 })]), 3, next.epoch);
    expect(stale.items.find((entry) => entry.summary.runId === "b")!.summary.rev).toBe(4);
  });

  it("discards an append whose epoch moved on (refresh landed in flight)", () => {
    const refreshed = applyTaskCenterRefresh(first, page([item("a")]), 2);
    const lateAppend = applyTaskCenterAppend(refreshed, page([item("ghost")]), 3, first.epoch);
    expect(lateAppend).toBe(refreshed);
    expect(lateAppend.items.map((entry) => entry.summary.runId)).toEqual(["a"]);
  });

  it("discards out-of-order appends", () => {
    const applied = applyTaskCenterAppend(first, page([item("c")]), 4, first.epoch);
    expect(applyTaskCenterAppend(applied, page([item("d")]), 3, applied.epoch)).toBe(applied);
  });
});

describe("taskCenterVerb", () => {
  const view = (status: Parameters<typeof deriveExecutionStatus>[0]) =>
    deriveExecutionStatus(status, []);

  it("maps waiting states to the handling verb", () => {
    expect(taskCenterVerb(view({ id: "r", status: "waiting_input", waitKind: "approval" }))).toBe(
      "Handle now",
    );
    expect(taskCenterVerb(view({ id: "r", status: "waiting_input", waitKind: "input" }))).toBe(
      "Handle now",
    );
    expect(
      taskCenterVerb(view({ id: "r", status: "waiting_takeover", waitKind: "takeover" })),
    ).toBe("Handle now");
  });

  it("maps done to the result verb and failed to the execution verb", () => {
    expect(taskCenterVerb(view({ id: "r", status: "completed", waitKind: null }))).toBe(
      "View result",
    );
    expect(taskCenterVerb(view({ id: "r", status: "failed", waitKind: null }))).toBe(
      "View execution",
    );
  });

  it("maps every ordinary state to the return verb", () => {
    for (const status of ["queued", "leased", "running", "cancelled"] as const) {
      expect(taskCenterVerb(view({ id: "r", status, waitKind: null }))).toBe(
        "Back to conversation",
      );
    }
  });
});

describe("navigation intent handoff", () => {
  it("lives in module memory only and clears on take", () => {
    clearTaskCenterNavIntent();
    expect(peekTaskCenterNavIntent()).toBeNull();
    const intent = { threadId: "thread-1", runId: "run-1", rev: 4, attention: true };
    setTaskCenterNavIntent(intent);
    expect(peekTaskCenterNavIntent()).toEqual(intent);
    clearTaskCenterNavIntent();
    expect(peekTaskCenterNavIntent()).toBeNull();
  });
});
