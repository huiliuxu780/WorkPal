import { describe, expect, it } from "vitest";
import { ThreadMessagePageSchema, ThreadSnapshotSchema } from "./domain.js";
import {
  ExecutionActivityPageSchema,
  ExecutionSnapshotSchema,
  ExecutionSummarySchema,
  MAX_SUMMARY_ARTIFACTS,
} from "./execution-snapshot.js";

const summary = {
  runId: "run-1",
  threadId: "thread-1",
  botId: "bot-1",
  rev: 41,
  status: "completed" as const,
  trigger: "user" as const,
  title: "Summarize the quarter",
  updatedAt: "2026-10-12T00:05:00.000Z",
  entry: "execution" as const,
  artifacts: [{ id: "artifact-1", name: "quarter.pdf", mimeType: "application/pdf" }],
};

const snapshot = {
  summary,
  plan: undefined,
  steps: { items: [], truncated: false },
  todos: { items: [], truncated: false },
  timeline: [],
  activityPage: { items: [], olderCursor: null, truncated: false },
  interventions: [],
};

describe("ExecutionSummary contract", () => {
  it("parses a minimal and a fully populated summary", () => {
    expect(ExecutionSummarySchema.parse(summary).rev).toBe(41);
    const full = ExecutionSummarySchema.parse({
      ...summary,
      waitKind: "approval",
      outcome: "Here is the summary.",
      failure: "The model timed out.",
      startedAt: "2026-10-12T00:00:00.000Z",
      completedAt: "2026-10-12T00:05:00.000Z",
      durationMs: 300_000,
      counts: { steps: 3, actions: 7, artifacts: MAX_SUMMARY_ARTIFACTS + 5 },
      anchorMessageId: "message-1",
      incompleteSections: ["activity", "artifacts"],
    });
    expect(full.counts?.artifacts).toBe(25);
    expect(full.incompleteSections).toEqual(["activity", "artifacts"]);
    // waitKind is nullable for terminal runs, not absent-by-guess.
    expect(ExecutionSummarySchema.parse({ ...summary, waitKind: null }).waitKind).toBeNull();
  });

  it("rejects unknown fields, invented zero counts, and over-cap artifact lists", () => {
    expect(ExecutionSummarySchema.safeParse({ ...summary, answer: "hunter2" }).success).toBe(false);
    expect(ExecutionSummarySchema.safeParse({ ...summary, rev: -1 }).success).toBe(false);
    expect(ExecutionSummarySchema.safeParse({ ...summary, rev: 1.5 }).success).toBe(false);
    expect(ExecutionSummarySchema.safeParse({ ...summary, entry: "dashboard" }).success).toBe(false);
    expect(ExecutionSummarySchema.safeParse({ ...summary, counts: { steps: 0, extra: 1 } }).success).toBe(
      false,
    );
    const tooMany = Array.from({ length: MAX_SUMMARY_ARTIFACTS + 1 }, (_, i) => ({
      id: `artifact-${i}`,
      name: `f${i}`,
    }));
    expect(ExecutionSummarySchema.safeParse({ ...summary, artifacts: tooMany }).success).toBe(false);
    expect(ExecutionSummarySchema.safeParse({ ...summary, incompleteSections: ["model"] }).success).toBe(
      false,
    );
  });

  it("omits counts rather than reporting unknowns as zero", () => {
    const parsed = ExecutionSummarySchema.parse(summary);
    expect(parsed.counts).toBeUndefined();
    expect(parsed.outcome).toBeUndefined();
    expect(parsed.anchorMessageId).toBeUndefined();
  });
});

describe("ExecutionSnapshot contract", () => {
  it("parses the empty-section detail and a full detail", () => {
    expect(ExecutionSnapshotSchema.parse(snapshot).summary.runId).toBe("run-1");
    const full = ExecutionSnapshotSchema.parse({
      ...snapshot,
      result: {
        messageId: "message-9",
        blocks: [{ kind: "text", text: "Done." }],
        truncated: false,
      },
    });
    expect(full.result?.messageId).toBe("message-9");
    expect(
      ExecutionActivityPageSchema.parse({
        items: [],
        olderCursor: "opaque-cursor-value",
        truncated: true,
      }).olderCursor,
    ).toBe("opaque-cursor-value");
  });

  it("refuses unknown keys and non-message blocks", () => {
    expect(
      ExecutionSnapshotSchema.safeParse({ ...snapshot, secret: "x" }).success,
    ).toBe(false);
    expect(
      ExecutionSnapshotSchema.safeParse({
        ...snapshot,
        result: {
          messageId: "m",
          blocks: [{ kind: "text", text: "ok" }],
          truncated: false,
          request: { token: "raw-effect-request" },
        },
      }).success,
    ).toBe(false);
    expect(
      ExecutionActivityPageSchema.safeParse({
        items: [{ id: "a", botId: "b", threadId: "t", kind: "tool", status: "running", title: "x", rawEvent: {} }],
        olderCursor: null,
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      ExecutionSnapshotSchema.safeParse({ ...snapshot, steps: { items: [], truncated: "yes" } }).success,
    ).toBe(false);
    expect(
      ExecutionActivityPageSchema.safeParse({ items: [], olderCursor: null, truncated: false, total: -2 })
        .success,
    ).toBe(false);
  });

  it("keeps timeline bounded", () => {
    const items = Array.from({ length: 24 }, (_, i) => ({
      id: `tool:${i}`,
      botId: "bot-1",
      threadId: "thread-1",
      kind: "tool" as const,
      status: "completed" as const,
      title: "Ran a tool",
    }));
    expect(ExecutionSnapshotSchema.parse({ ...snapshot, timeline: items }).timeline).toHaveLength(24);
    expect(
      ExecutionSnapshotSchema.safeParse({ ...snapshot, timeline: [...items, items[0]!] }).success,
    ).toBe(false);
  });
});

describe("thread surfaces carry optional executions", () => {
  it("parses old payloads and new summaries side by side", () => {
    const base = {
      threadId: "thread-1",
      cursor: 3,
      messages: [],
      olderCursor: null,
      botId: "bot-1",
      run: null,
    };
    expect(ThreadSnapshotSchema.parse(base).executions).toBeUndefined();
    expect(ThreadSnapshotSchema.parse({ ...base, executions: [summary] }).executions?.[0]?.rev).toBe(41);
    expect(
      ThreadMessagePageSchema.parse({
        threadId: "thread-1",
        messages: [],
        olderCursor: null,
        executions: [summary],
      }).executions?.[0]?.runId,
    ).toBe("run-1");
    expect(
      ThreadSnapshotSchema.safeParse({ ...base, executions: [{ ...summary, unknown: 1 }] }).success,
    ).toBe(false);
  });
});
