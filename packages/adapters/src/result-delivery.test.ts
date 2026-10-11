import { describe, expect, it } from "vitest";
import { buildDeliveryPrompt } from "./result-delivery.js";

describe("background result summary input", () => {
  it("orders merged results by completion and separates failures", () => {
    const records = [
      {
        id: "late",
        kind: "background_task",
        backgroundTaskId: "task-late",
        createdAt: new Date("2026-10-12T00:00:00Z"),
      },
      {
        id: "failed",
        kind: "background_task",
        backgroundTaskId: "task-failed",
        createdAt: new Date("2026-10-12T00:00:01Z"),
      },
      {
        id: "early",
        kind: "background_task",
        backgroundTaskId: "task-early",
        createdAt: new Date("2026-10-12T00:00:02Z"),
      },
    ];
    const tasks = new Map([
      [
        "task-late",
        {
          status: "completed",
          agentId: "late-agent",
          result: "late result",
          error: null,
          finishedAt: new Date("2026-10-12T00:00:20Z"),
        },
      ],
      [
        "task-failed",
        {
          status: "failed",
          agentId: "failed-agent",
          result: null,
          error: "provider failed",
          finishedAt: new Date("2026-10-12T00:00:10Z"),
        },
      ],
      [
        "task-early",
        {
          status: "completed",
          agentId: "early-agent",
          result: "early result",
          error: null,
          finishedAt: new Date("2026-10-12T00:00:05Z"),
        },
      ],
    ]);
    const prompt = buildDeliveryPrompt(records, tasks);
    expect(prompt.indexOf("early result")).toBeLessThan(prompt.indexOf("late result"));
    expect(
      prompt.slice(prompt.indexOf("Completed:"), prompt.indexOf("Failed or cancelled:")),
    ).not.toContain("provider failed");
    expect(prompt.slice(prompt.indexOf("Failed or cancelled:"))).toContain("provider failed");
    expect(prompt).toContain("untrusted data");
  });

  it("includes the actual failure reason for a scheduled Run result", () => {
    const prompt = buildDeliveryPrompt(
      [{
        id: "budget-result",
        runId: "run-budget",
        kind: "run_result",
        backgroundTaskId: null,
        createdAt: new Date("2026-10-12T00:00:00Z"),
      }],
      new Map(),
      new Map([["run-budget", { status: "failed", error: "budget_exceeded:duration_sec" }]]),
    );
    expect(prompt).toContain("Scheduled run: budget_exceeded:duration_sec");
    expect(prompt.slice(prompt.indexOf("Failed or cancelled:"))).toContain("budget_exceeded:duration_sec");
  });
});
