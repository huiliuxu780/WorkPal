import { describe, expect, it } from "vitest";
import {
  buildExecutionSummary,
  decodeExecutionActivityCursor,
  type ExecutionSummaryFacts,
  encodeExecutionActivityCursor,
  executionEntryFor,
  pickExecutionResult,
} from "./execution-snapshot.js";

const run = (
  overrides: Partial<ExecutionSummaryFacts["run"]> = {},
): ExecutionSummaryFacts["run"] => ({
  id: "run-1",
  threadId: "thread-1",
  botId: "bot-1",
  status: "completed",
  waitKind: null,
  trigger: "user",
  error: null,
  orchestration: null,
  startedAt: "2026-10-12T00:00:00.000Z",
  completedAt: "2026-10-12T00:01:00.000Z",
  createdAt: "2026-10-11T23:59:00.000Z",
  ...overrides,
});

const facts = (overrides: Partial<ExecutionSummaryFacts> = {}): ExecutionSummaryFacts => ({
  run: run(),
  rev: 12,
  taskPrompt: "Summarize   the\nquarter in one line",
  ...overrides,
});

describe("buildExecutionSummary", () => {
  it("derives the title from the Task prompt without inventing content", () => {
    const summary = buildExecutionSummary(facts());
    expect(summary.title).toBe("Summarize the quarter in one line");
    expect(summary.durationMs).toBe(60_000);
    expect(summary.rev).toBe(12);
    expect(summary.entry).toBe("execution");
  });

  it("derives updatedAt from recorded event time, never a row timestamp", () => {
    // Without surviving events the immutable creation time is the only stable
    // fact; with events the newest event time wins. Lease renewals and other
    // invisible row writes have no representation here by construction.
    expect(buildExecutionSummary(facts()).updatedAt).toBe("2026-10-11T23:59:00.000Z");
    expect(
      buildExecutionSummary(facts({ lastEventAt: "2026-10-12T00:05:00.000Z" })).updatedAt,
    ).toBe("2026-10-12T00:05:00.000Z");
  });

  it("omits unknown counts and does not fabricate outcome or counts", () => {
    const summary = buildExecutionSummary(facts());
    expect(summary.counts).toBeUndefined();
    expect(summary.outcome).toBeUndefined();
    expect(summary.artifacts).toEqual([]);
    expect(summary.incompleteSections).toBeUndefined();
  });

  it("quotes outcome only from the real result message", () => {
    const summary = buildExecutionSummary(
      facts({ outcomeBlocks: [{ kind: "text", text: "Quarter closed at 4.2M." }] }),
    );
    expect(summary.outcome).toBe("Quarter closed at 4.2M.");
  });

  it("maps failures through the display-safe clamp", () => {
    const long = `HTTP 500 ${"x".repeat(400)}`;
    const summary = buildExecutionSummary(
      facts({ run: run({ status: "failed", error: long, completedAt: null }) }),
    );
    expect(summary.failure).toBe(`${long.slice(0, 300)}…`);
    expect(summary.durationMs).toBeUndefined();
    // Cancelled rows keep their internal cancel reason out of `failure`.
    expect(
      buildExecutionSummary(facts({ run: run({ status: "cancelled", error: "wait_timeout" }) }))
        .failure,
    ).toBeUndefined();
  });

  it("passes trusted counts through and flags artifact overflow", () => {
    const summary = buildExecutionSummary(
      facts({
        counts: { steps: 3, actions: 5 },
        artifacts: Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, name: `f${i}` })),
        artifactsTotal: 25,
      }),
    );
    expect(summary.counts).toEqual({ steps: 3, actions: 5, artifacts: 25 });
    expect(summary.artifacts).toHaveLength(20);
    expect(summary.incompleteSections).toEqual(["artifacts"]);
  });

  it("carries the durable source-message link only when recorded", () => {
    expect(buildExecutionSummary(facts()).sourceMessageId).toBeUndefined();
    expect(
      buildExecutionSummary(facts({ run: run({ sourceMessageId: "message-1" }) })).sourceMessageId,
    ).toBe("message-1");
    expect(
      buildExecutionSummary(facts({ run: run({ sourceMessageId: null }) })).sourceMessageId,
    ).toBeUndefined();
  });

  it("is deterministic and never mixes two Runs' facts", () => {
    const left = buildExecutionSummary(facts({ run: run({ id: "run-a" }), rev: 3 }));
    const right = buildExecutionSummary(
      facts({ run: run({ id: "run-b", trigger: "bot_message" }), rev: 9, taskPrompt: null }),
    );
    expect([left.runId, left.rev]).toEqual(["run-a", 3]);
    expect([right.runId, right.rev]).toEqual(["run-b", 9]);
    // Same facts replay byte-identical (live vs re-read).
    expect(buildExecutionSummary(facts())).toEqual(buildExecutionSummary(facts()));
  });

  it("titles peer runs from the source message, not the model", () => {
    const summary = buildExecutionSummary(
      facts({
        run: run({ trigger: "bot_message" }),
        taskPrompt: null,
        peerSourceBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "Scout",
            intent: "question",
            text: "Which region?",
          },
        ],
      }),
    );
    expect(summary.entry).toBe("collaboration");
    expect(summary.title).toContain("Scout asked");
    expect(summary.title).toContain("Which region?");
  });

  it("carries manual-retry lineage when the facts include it", () => {
    const summary = buildExecutionSummary(
      facts({
        retryOfRunId: "run-0",
        retrySuccessorRunId: "run-2",
        manualRetry: { allowed: false, reason: "already_active" },
      }),
    );
    expect(summary.retryOfRunId).toBe("run-0");
    expect(summary.retrySuccessorRunId).toBe("run-2");
    expect(summary.manualRetry).toEqual({ allowed: false, reason: "already_active" });
  });

  it("carries the triggering message identity and omits it when none (PD-01 D9)", () => {
    const withSource = buildExecutionSummary(facts({ sourceMessageId: "msg-9" }));
    expect(withSource.sourceMessageId).toBe("msg-9");

    const without = buildExecutionSummary(facts({ sourceMessageId: null }));
    expect(without.sourceMessageId).toBeUndefined();
    expect(buildExecutionSummary(facts()).sourceMessageId).toBeUndefined();
  });

  it("carries amendment follow-up lineage separately from retry lineage", () => {
    const summary = buildExecutionSummary(
      facts({
        followUpOfRunId: "run-original",
        followUpSuccessorRunId: "run-review",
      }),
    );
    expect(summary.followUpOfRunId).toBe("run-original");
    expect(summary.followUpSuccessorRunId).toBe("run-review");
    expect(summary.retryOfRunId).toBeUndefined();
  });
});

describe("executionEntryFor", () => {
  it("classifies triggers without inventing a hierarchy", () => {
    expect(executionEntryFor({ trigger: "user", orchestration: null })).toBe("execution");
    expect(executionEntryFor({ trigger: "routine", orchestration: null })).toBe("result");
    expect(executionEntryFor({ trigger: "webhook", orchestration: "junk" })).toBe("result");
    expect(executionEntryFor({ trigger: "bot_message", orchestration: null })).toBe(
      "collaboration",
    );
    expect(
      executionEntryFor({
        trigger: "user",
        orchestration: {
          version: "v1",
          routing: { kind: "bot_message" },
          ownership: { mode: "support", ownerBotId: "bot-1" },
          responseMode: "single",
          collaboration: {
            role: "support",
            source: "bot_message",
            fromBotId: "bot-2",
            parentRunId: "run-p",
            handoffDepth: 0,
            messageHop: 0,
          },
        },
      }),
    ).toBe("collaboration");
  });
});

describe("pickExecutionResult", () => {
  it("strips Ask blocks and refuses to present a card as a result", () => {
    expect(
      pickExecutionResult({
        messageId: "m-1",
        blocks: [{ kind: "ask", text: "Approve?", approvalEffectId: "e-1" }],
      }),
    ).toBeNull();
    const result = pickExecutionResult({
      messageId: "m-1",
      blocks: [
        { kind: "ask", text: "Approve?" },
        { kind: "text", text: "Sent." },
      ],
    });
    expect(result?.blocks).toEqual([{ kind: "text", text: "Sent." }]);
    expect(result?.truncated).toBe(false);
  });

  it("caps oversized block lists with an explicit truncated flag", () => {
    const blocks = Array.from({ length: 45 }, (_, i) => ({ kind: "text" as const, text: `t${i}` }));
    const result = pickExecutionResult({ messageId: "m", blocks });
    expect(result?.blocks).toHaveLength(40);
    expect(result?.truncated).toBe(true);
  });
});

describe("activity cursor", () => {
  const cursor = { v: 1 as const, r: "run-1", g: 400, hi: 1200, nx: 1150 };

  it("round-trips and stays opaque", () => {
    const encoded = encodeExecutionActivityCursor(cursor);
    expect(encoded).not.toContain("run-1");
    expect(decodeExecutionActivityCursor(encoded)).toEqual(cursor);
  });

  it("rejects foreign shapes, key edits, and impossible bounds", () => {
    expect(decodeExecutionActivityCursor(undefined)).toBeNull();
    expect(decodeExecutionActivityCursor("!!!not-base64!!!")).toBeNull();
    expect(decodeExecutionActivityCursor(btoa(JSON.stringify({ hello: "world" })))).toBeNull();
    const tampered = { ...cursor, extra: 1 };
    expect(
      decodeExecutionActivityCursor(
        btoa(JSON.stringify(tampered)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      ),
    ).toBeNull();
    expect(
      decodeExecutionActivityCursor(
        btoa(JSON.stringify({ v: 1, r: "run-1", g: 400, hi: 1150, nx: 1200 }))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, ""),
      ),
    ).toBeNull();
    expect(
      decodeExecutionActivityCursor(
        btoa(JSON.stringify({ ...cursor, v: 2 }))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, ""),
      ),
    ).toBeNull();
  });
});
