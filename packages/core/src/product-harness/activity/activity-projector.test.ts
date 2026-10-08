import { describe, expect, it } from "vitest";
import {
  foldAdjacentTools,
  groupActivity,
  summarizeRunActivity,
  windowActivity,
} from "./grouping.js";
import {
  currentActivityLine,
  projectActivity,
  reduceActivity,
  seedActivityFromContext,
} from "./projector.js";
import type { ActivityItem, ActivityProjectionContext, ActivitySourceEvent } from "./types.js";

const context: ActivityProjectionContext = {
  threadId: "thread-1",
  botNames: { "bot-a": "Alice", "bot-b": "Finance", "bot-c": "Coding" },
};

let seq = 0;
function event(
  type: string,
  payload: Record<string, unknown> = {},
  overrides: { runId?: string | null; botId?: string } = {},
): ActivitySourceEvent {
  seq += 1;
  return {
    type,
    botId: overrides.botId ?? "bot-a",
    seq,
    createdAt: `2026-10-09T00:00:${String(seq).padStart(2, "0")}Z`,
    runId: overrides.runId === undefined ? "run-1" : overrides.runId,
    payload,
  };
}

const FORBIDDEN_INTERNALS = [
  "plan_enter",
  "plan_write",
  "plan_exit",
  "agent_spawn",
  "agent_send",
  "task_output",
  "task_cancel",
  "message_bot",
  "handoff_to_bot",
  "run_subagent",
  "thread.collaboration",
  "thread.turn",
  "subagent.",
  "bot_message",
  "_",
];

function expectNoInternals(items: readonly ActivityItem[]) {
  for (const item of items) {
    for (const field of [item.title, item.detail]) {
      if (!field) continue;
      for (const forbidden of FORBIDDEN_INTERNALS) {
        expect(field, `${field} must not leak internals`).not.toContain(forbidden);
      }
    }
  }
}

describe("projectActivity (§49)", () => {
  it("replay equals live reduction (case 1 + 15)", () => {
    const events = [
      event("run.started", { trigger: "user" }),
      event("thread.progress", { text: "plan_enter", activity: true }),
      event("agent.tool.called", { name: "read_file", executionId: "t1" }),
      event("agent.tool.completed", { name: "read_file", executionId: "t1", durationMs: 40, outcome: "succeeded" }),
      event("thread.collaboration.requested", {
        fromBotId: "bot-a",
        toBotId: "bot-b",
        fromRunId: "run-1",
        toRunId: "run-2",
        intent: "request",
      }),
      event("thread.collaboration.result", {
        fromBotId: "bot-b",
        toBotId: "bot-a",
        fromRunId: "run-2",
        toRunId: "run-3",
        intent: "result",
      }),
      event("run.completed", {}),
    ];
    const replayed = projectActivity(events, context);
    // Live: a client that snapshotted mid-run and then reduced the rest.
    const partial = projectActivity(events.slice(0, 4), context);
    const live = events
      .slice(4)
      .reduce((items, e) => reduceActivity(items, e, context), partial);
    expect(live).toEqual(replayed);
    // Deterministic across reloads.
    expect(projectActivity(events, context)).toEqual(replayed);
    expectNoInternals(replayed);
  });

  it("projects planning without runtime vocabulary (case 2)", () => {
    const items = projectActivity(
      [event("thread.progress", { text: "plan_enter", activity: true })],
      context,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "planning", status: "running", title: "Planning" });
  });

  it("groups repeated tool calls into folded activity (case 3)", () => {
    const events = [
      event("agent.tool.called", { name: "read_file", executionId: "t1" }),
      event("agent.tool.completed", { executionId: "t1", outcome: "succeeded", durationMs: 10 }),
      event("agent.tool.called", { name: "read_file", executionId: "t2" }),
      event("agent.tool.completed", { executionId: "t2", outcome: "succeeded", durationMs: 12 }),
      event("agent.tool.called", { name: "read_file", executionId: "t3" }),
      event("agent.tool.completed", { executionId: "t3", outcome: "succeeded", durationMs: 9 }),
      event("agent.tool.called", { name: "web_search", executionId: "t4" }),
      event("agent.tool.completed", { executionId: "t4", outcome: "succeeded", durationMs: 300 }),
    ];
    const items = projectActivity(events, context);
    expect(items.filter((item) => item.kind === "tool")).toHaveLength(4);
    const folded = foldAdjacentTools(items.filter((item) => item.kind === "tool"));
    expect(folded).toHaveLength(2);
    expect(folded[0]).toMatchObject({ title: "Reading file", count: 3, durationMs: 31 });
    expect(folded[1]).toMatchObject({ title: "Searching the web" });
    expect(folded[1]?.count).toBeUndefined();
    expectNoInternals(items);
  });

  it("folds subagent lifecycle into a single research item (case 4)", () => {
    const items = projectActivity(
      [
        event("thread.subagent", { agentId: "helper-1", name: "helper", task: "delegated task", status: "running" }),
        event("thread.subagent", { agentId: "helper-1", name: "helper", task: "delegated task", status: "running", progress: "reading" }),
        event("thread.subagent", { agentId: "helper-1", name: "helper", task: "delegated task", status: "completed", result: "done" }),
      ],
      context,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "research", status: "completed", title: "Researching" });
    expect(items[0]?.detail).toBeUndefined(); // helper results stay out of activity
  });

  it("keeps background tasks alive past parent completion and refresh (case 5)", () => {
    const events = [
      event("subagent.started", { taskId: "bg-1", agentId: "helper" }),
      event("thread.subagent", { agentId: "bg-1", name: "helper", task: "delegated task", status: "running" }),
      event("run.completed", {}),
    ];
    const items = projectActivity(events, context);
    const background = items.find((item) => item.kind === "background");
    expect(background).toMatchObject({ status: "running", title: "Working in background", taskId: "bg-1" });
    expect(items.filter((item) => item.kind === "research")).toHaveLength(0); // no duplicate card

    // After a refresh the durable row re-seeds the same card.
    const reseeded = seedActivityFromContext({
      ...context,
      backgroundTasks: [
        { taskId: "bg-1", parentRunId: "run-1", botId: "bot-a", status: "running" },
      ],
    });
    expect(reseeded[0]).toMatchObject({ id: "bg:bg-1", kind: "background", status: "running", runId: "run-1" });

    const done = projectActivity(
      [...events, event("subagent.completed", { taskId: "bg-1", agentId: "helper", result: "x" })],
      context,
    );
    expect(done.find((item) => item.id === "bg:bg-1")).toMatchObject({
      status: "completed",
      title: "Background task completed",
      taskId: undefined,
    });
  });

  it("projects collaboration as help, not internals (cases 6, 7, 10, 11)", () => {
    const items = projectActivity(
      [
        event("thread.collaboration.requested", {
          fromBotId: "bot-a",
          toBotId: "bot-b",
          fromRunId: "run-1",
          toRunId: "run-2",
          intent: "request",
        }),
        event("thread.collaboration.result", {
          fromBotId: "bot-b",
          toBotId: "bot-a",
          fromRunId: "run-2",
          toRunId: "run-3",
          intent: "result",
        }),
      ],
      context,
    );
    const asked = items.find((item) => item.id === "collab:run-2");
    expect(asked).toMatchObject({
      kind: "delegation",
      status: "completed", // closed by the result
      title: "Asked Finance for help",
      runId: "run-1", // grouped under the requester's turn (§36)
    });
    const result = items.find((item) => item.title === "Finance returned a result");
    expect(result).toMatchObject({ kind: "delegation", status: "completed" });
    // Owner resumption is not an ownership transfer: no handoff item exists.
    expect(items.filter((item) => item.kind === "handoff")).toHaveLength(0);
    expectNoInternals(items);
  });

  it("renders a question delegation distinctly", () => {
    const items = projectActivity(
      [
        event("thread.collaboration.requested", {
          fromBotId: "bot-a",
          toBotId: "bot-b",
          fromRunId: "run-1",
          toRunId: "run-2",
          intent: "question",
        }),
      ],
      context,
    );
    expect(items[0]?.title).toBe("Asked Finance a question");
  });

  it("projects handoff exactly once even with the legacy event present (cases 8, 9)", () => {
    const items = projectActivity(
      [
        event("group.handoff", { messageId: "m1", fromBotId: "bot-a", toBotId: "bot-b", text: "stage" }),
        event(
          "thread.turn.handed_off",
          { fromBotId: "bot-a", toBotId: "bot-b", fromRunId: "run-1", toRunId: "run-2", handoffDepth: 1 },
          { botId: "bot-b", runId: "run-2" },
        ),
      ],
      context,
    );
    const handoffs = items.filter((item) => item.kind === "handoff");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ title: "Handed this to Finance", runId: "run-1" });
  });

  it("maps waiting states without duplicating dedicated UI (cases 12, 13)", () => {
    const items = projectActivity([event("run.waiting_input", {})], context);
    expect(items.find((item) => item.id === "run:run-1")).toMatchObject({
      kind: "waiting_input",
      status: "waiting",
      title: "Waiting for your answer",
    });
    const seeded = seedActivityFromContext({
      ...context,
      runs: [{ runId: "run-9", botId: "bot-a", status: "waiting_takeover" }],
    });
    expect(seeded[0]).toMatchObject({
      kind: "waiting_takeover",
      status: "waiting",
      title: "Needs you to take over",
    });
  });

  it("projects failed and cancelled runs (case 14)", () => {
    const failed = projectActivity([event("run.failed", { error: "model exploded" })], context);
    expect(failed.find((item) => item.id === "run:run-1")).toMatchObject({
      kind: "failed",
      status: "failed",
      title: "Stopped with an error",
      detail: "model exploded",
    });
    const cancelled = projectActivity([event("run.cancelled", {})], context);
    expect(cancelled.find((item) => item.id === "run:run-1")).toMatchObject({
      kind: "cancelled",
      status: "cancelled",
    });
  });

  it("hides routing state and clips oversized failure detail", () => {
    const items = projectActivity(
      [
        event("thread.turn.routed", { routeKind: "group_router", ownerBotId: "bot-a" }),
        event("run.failed", { error: "x".repeat(500) }),
      ],
      context,
    );
    expect(items.filter((item) => item.title.toLowerCase().includes("routed"))).toHaveLength(0);
    expect(items[0]?.detail?.length).toBeLessThanOrEqual(200);
  });
});

describe("activity grouping (§35–§38)", () => {
  it("keeps collaboration and background under the delegating run", () => {
    const items = projectActivity(
      [
        event("agent.tool.called", { name: "read_file", executionId: "t1" }),
        event("thread.collaboration.requested", {
          fromBotId: "bot-a",
          toBotId: "bot-b",
          fromRunId: "run-1",
          toRunId: "run-2",
          intent: "request",
        }),
        event("subagent.started", { taskId: "bg-1", agentId: "helper" }),
      ],
      context,
    );
    const groups = groupActivity(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.rootRunId).toBe("run-1");
    expect(groups[0]?.items.map((item) => item.kind)).toEqual(["tool", "delegation", "background"]);
  });

  it("windows live activity but never hides actionable states (§24)", () => {
    const items: ActivityItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: `tool:run-1:t${i}`,
      runId: "run-1",
      botId: "bot-a",
      threadId: "thread-1",
      kind: "tool",
      status: "completed",
      title: "Reading file",
    }));
    items.push({
      id: "run:run-1",
      runId: "run-1",
      botId: "bot-a",
      threadId: "thread-1",
      kind: "waiting_input",
      status: "waiting",
      title: "Waiting for your answer",
    });
    const { visible, hiddenCount } = windowActivity(items, 6);
    expect(visible.some((item) => item.kind === "waiting_input")).toBe(true);
    expect(visible.length).toBeLessThanOrEqual(7);
    expect(hiddenCount).toBeGreaterThan(0);
  });

  it("summarizes finished runs for the collapsed row (§22)", () => {
    const items = projectActivity(
      [
        event("agent.tool.called", { name: "read_file", executionId: "t1" }),
        event("agent.tool.completed", { executionId: "t1", outcome: "succeeded" }),
        event("agent.tool.called", { name: "read_file", executionId: "t2" }),
        event("agent.tool.completed", { executionId: "t2", outcome: "succeeded" }),
        event("subagent.started", { taskId: "bg-1", agentId: "helper" }),
      ],
      context,
    );
    const folded = foldAdjacentTools(items);
    expect(summarizeRunActivity(folded)).toEqual({
      actions: 2,
      hasBackground: true,
      hasFailure: false,
    });
  });

  it("gives the sidebar one current line per run (§27/§28)", () => {
    const items = projectActivity(
      [
        event("run.started", { trigger: "user" }),
        event("thread.progress", { text: "plan_enter", activity: true }),
      ],
      context,
    );
    expect(currentActivityLine(items, "run-1")).toEqual({ kind: "planning", text: "Planning" });
    expect(currentActivityLine(items, "run-unknown")).toBeNull();
  });
});
