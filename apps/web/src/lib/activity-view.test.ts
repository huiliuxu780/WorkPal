import type { ActivityItem, ThreadSnapshot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  activityLineText,
  backgroundActivityItems,
  inlineActivityItems,
  liveActivityItems,
} from "./activity-view";

function item(overrides: Partial<ActivityItem> & { id: string }): ActivityItem {
  return {
    botId: "bot-a",
    threadId: "thread-1",
    kind: "working",
    status: "running",
    title: "Working",
    ...overrides,
  } as ActivityItem;
}

function snapshot(activity: ActivityItem[], activeRunIds: string[] = ["run-1"]): ThreadSnapshot {
  return {
    threadId: "thread-1",
    cursor: 10,
    messages: [],
    olderCursor: null,
    run: null,
    activeRuns: activeRunIds.map((id) => ({
      id,
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "user",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-10-09T00:00:00.000Z",
    })),
    activity,
  } as ThreadSnapshot;
}

describe("activity selectors", () => {
  it("keeps only items of still-active runs inline", () => {
    const items = [
      item({ id: "a", runId: "run-1" }),
      item({ id: "b", runId: "run-old", kind: "completed", status: "completed" }),
    ];
    expect(liveActivityItems(snapshot(items)).map((i) => i.id)).toEqual(["a"]);
    expect(liveActivityItems(null)).toEqual([]);
  });

  it("surfaces background cards regardless of parent run liveness (§14/§38)", () => {
    const items = [
      item({ id: "bg:task-1", runId: "run-old", kind: "background", title: "Working in background" }),
      item({ id: "a", runId: "run-1" }),
    ];
    expect(backgroundActivityItems(snapshot(items, [])).map((i) => i.id)).toEqual(["bg:task-1"]);
  });

  it("never duplicates tools, handoffs or inline helpers in the strip (§22/§46)", () => {
    const items = [
      item({ id: "t", kind: "tool", title: "Reading file" }),
      item({ id: "h", kind: "handoff", title: "Handed this to Finance" }),
      item({ id: "r", kind: "research", title: "Researching" }),
      item({ id: "c", kind: "delegation", title: "Asked Finance for help" }),
    ];
    expect(inlineActivityItems(items).map((i) => i.id)).toEqual(["c"]);
  });

  it("prefers projected activity over the prompt snippet in the sidebar (§27)", () => {
    expect(
      activityLineText({
        activity: { kind: "planning", text: "Planning" },
        promptSnippet: "refactor the auth module",
      }),
    ).toBe("Planning");
    expect(
      activityLineText({ activity: { kind: "working", text: "  " }, promptSnippet: "snippet" }),
    ).toBe("snippet");
    expect(activityLineText({ promptSnippet: "snippet" })).toBe("snippet");
  });
});
