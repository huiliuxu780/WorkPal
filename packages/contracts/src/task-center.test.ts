import { describe, expect, it } from "vitest";
import {
  TASK_CENTER_MAX_LIMIT,
  TaskCenterItemSchema,
  TaskCenterPageSchema,
  TaskCenterTargetSchema,
} from "./task-center.js";

const summary = {
  runId: "run-1",
  threadId: "thread-1",
  botId: "bot-1",
  rev: 3,
  status: "running",
  trigger: "user",
  title: "Summarize the quarter",
  updatedAt: "2026-10-12T00:01:00.000Z",
  artifacts: [],
  entry: "execution",
};

describe("TaskCenterTargetSchema", () => {
  it("accepts exactly one authorized navigation target kind", () => {
    expect(TaskCenterTargetSchema.parse({ kind: "bot", botId: "bot-1" })).toEqual({
      kind: "bot",
      botId: "bot-1",
    });
    expect(TaskCenterTargetSchema.parse({ kind: "group", groupId: "group-1" })).toEqual({
      kind: "group",
      groupId: "group-1",
    });
  });

  it("rejects unknown kinds and extra fields", () => {
    expect(TaskCenterTargetSchema.safeParse({ kind: "thread", threadId: "t" }).success).toBe(false);
    expect(
      TaskCenterTargetSchema.safeParse({ kind: "bot", botId: "bot-1", groupId: "g" }).success,
    ).toBe(false);
  });
});

describe("TaskCenterPageSchema", () => {
  const page = {
    items: [{ summary, target: { kind: "bot", botId: "bot-1" } }],
    nextCursor: null,
    activeCount: 1,
  };

  it("accepts a well-formed page", () => {
    expect(TaskCenterPageSchema.parse(page)).toEqual(page);
  });

  it("is strict: unknown fields never ride along", () => {
    expect(TaskCenterPageSchema.safeParse({ ...page, percentage: 42 }).success).toBe(false);
    expect(
      TaskCenterItemSchema.safeParse({ ...page.items[0], progress: { processed: 1, total: 2 } })
        .success,
    ).toBe(false);
    expect(
      TaskCenterPageSchema.safeParse({
        ...page,
        items: [{ summary: { ...summary, percent: 10 }, target: { kind: "bot", botId: "b" } }],
      }).success,
    ).toBe(false);
  });

  it("rejects negative or fractional activeCount and requires a nullable cursor", () => {
    expect(TaskCenterPageSchema.safeParse({ ...page, activeCount: -1 }).success).toBe(false);
    expect(TaskCenterPageSchema.safeParse({ ...page, activeCount: 1.5 }).success).toBe(false);
    expect(TaskCenterPageSchema.safeParse({ ...page, nextCursor: undefined }).success).toBe(false);
    expect(TaskCenterPageSchema.parse({ ...page, nextCursor: "opaque-cursor" }).nextCursor).toBe(
      "opaque-cursor",
    );
  });

  it("keeps ExecutionSummary as the only status source (no parallel fields)", () => {
    // An item without the summary is invalid; there is no alternative shape.
    expect(
      TaskCenterItemSchema.safeParse({ target: { kind: "bot", botId: "bot-1" } }).success,
    ).toBe(false);
    expect(
      TaskCenterItemSchema.safeParse({
        summary: { ...summary, status: "paused" },
        target: { kind: "bot", botId: "b" },
      }).success,
    ).toBe(false);
  });

  it("bounds the page limit vocabulary", () => {
    expect(TASK_CENTER_MAX_LIMIT).toBe(100);
  });
});
