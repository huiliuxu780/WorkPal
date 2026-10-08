import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { activityNotificationsEnabled, activityPromptSnippet, listSpaceRuns } from "./runs.js";

describe("run activity copy", () => {
  it("presents structured agent messages instead of their internal wake prompt", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] A message just arrived from another bot with internal routing data",
        sourceBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "maya",
            fromBotName: "Maya",
            text: "Please check the release workflow.",
            intent: "request",
          },
        ],
      }),
    ).toBe("Maya asked: Please check the release workflow.");
  });

  it("fails closed when an agent message has no valid structured source", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] private internal routing envelope",
        sourceBlocks: [{ kind: "text", text: "not a peer message" }],
      }),
    ).toBe("Message from another agent");
  });
});

describe("run activity notification preference", () => {
  it("silences only direct messages", () => {
    expect(activityNotificationsEnabled(null, false)).toBe(false);
    expect(activityNotificationsEnabled("group-1", false)).toBe(true);
  });
});

describe("listSpaceRuns activity projection (§28)", () => {
  const runRow = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    status: "running",
    trigger: "user",
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-10-09T00:00:00.000Z"),
    updatedAt: new Date("2026-10-09T00:01:00.000Z"),
    bot: { name: "Alice", archivedAt: null, notifyOnFinish: true },
    task: { prompt: "refactor the auth module" },
    sourceMessage: null,
    thread: { groupId: null, group: null },
  };
  const actor = { spaceId: "workspace-1", userId: "user-1" } as never;

  it("projects the current activity line for active runs", async () => {
    const prisma = {
      run: { findMany: vi.fn().mockResolvedValue([runRow]) },
      event: {
        findMany: vi.fn().mockResolvedValue([
          {
            type: "thread.progress",
            botId: "bot-1",
            seq: 9,
            createdAt: new Date("2026-10-09T00:00:30.000Z"),
            runId: "run-1",
            payload: { text: "plan_enter", activity: true },
          },
        ]),
      },
    } as unknown as PrismaClient;

    const rows = await listSpaceRuns(prisma, actor, "active");
    expect(rows[0]?.activity).toEqual({ kind: "planning", text: "Planning" });
  });

  it("falls back to a status-derived line without events and skips recent rows", async () => {
    const prisma = {
      run: { findMany: vi.fn().mockResolvedValue([runRow]) },
      event: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    const rows = await listSpaceRuns(prisma, actor, "active");
    // A running run with no events still seeds the generic working line.
    expect(rows[0]?.activity).toEqual({ kind: "working", text: "Working" });

    const recent = await listSpaceRuns(prisma, actor, "recent");
    expect(recent[0]?.activity).toBeUndefined();
    expect(prisma.event.findMany).toHaveBeenCalledTimes(1);
  });
});
