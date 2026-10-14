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

  it("keeps an oversized window bounded and reports hidden items honestly", () => {
    const records = Array.from({ length: 405 }, (_, index) => ({
      id: `record-${index}`,
      runId: `run-${index}`,
      kind: "run_result" as const,
      backgroundTaskId: null,
      createdAt: new Date(Date.UTC(2026, 9, 12, 0, 0, index)),
    }));
    const sourceRuns = new Map(
      records.map((record, index) => [
        record.runId!,
        {
          // 205 completions then 200 failures; the oldest 200 are listed.
          status: index < 205 ? "completed" : "failed",
          error: index === 3 ? `detail-${index}-${"x".repeat(500)}` : `detail-${index}`,
        },
      ]),
    );
    const prompt = buildDeliveryPrompt(records, new Map(), sourceRuns);
    // The prompt never grows with the window: 200 items are listed individually.
    expect(prompt.match(/^- Item /gm)).toHaveLength(200);
    expect(prompt.length).toBeLessThan(60_000);
    // The 205 hidden items are counted exactly, split by outcome, and are
    // never presented as absent.
    expect(prompt).toContain("5 more completed items");
    expect(prompt).toContain("200 more failed or cancelled items");
    expect(prompt).toContain("not listed individually");
    expect(prompt).toContain("detail-0");
    expect(prompt).toContain("detail-199");
    expect(prompt).not.toContain("detail-200");
    // Per-item truncation stays explicitly marked.
    expect(prompt).toContain("[truncated]");
  });
});
