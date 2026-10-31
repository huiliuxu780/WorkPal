import type { DisplayBlock, ExecutionSummary } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  mergeExecutionsByRun,
  mergeThreadHistory,
  prependThreadHistoryPage,
  upsertMessageById,
} from "./message-pages.js";

type Message = { id: string; seq: number };
type Snapshot = {
  threadId: string;
  messages: Message[];
  olderCursor: number | null;
  executions?: ExecutionSummary[];
  displayBlocks?: DisplayBlock[];
};

function displayBlock(blockId: string, text = "card text"): DisplayBlock {
  return { kind: "markdown", blockId, text } as DisplayBlock;
}

function summary(runId: string, rev: number, title = runId): ExecutionSummary {
  return {
    runId,
    threadId: "thread-1",
    botId: "bot-1",
    rev,
    status: "completed",
    trigger: "user",
    title,
    updatedAt: "2026-10-12T00:00:00.000Z",
    artifacts: [],
    entry: "execution",
  };
}

function snapshot(messages: Message[], executions?: ExecutionSummary[]): Snapshot {
  return {
    threadId: "thread-1",
    messages,
    olderCursor: executions === undefined ? 50 : 50,
    ...(executions ? { executions } : {}),
  };
}

describe("mergeExecutionsByRun", () => {
  it("is undefined when neither side carries summaries and de-dupes by run", () => {
    expect(mergeExecutionsByRun(undefined, undefined)).toBeUndefined();
    const merged = mergeExecutionsByRun([summary("run-1", 9, "fresh")], [summary("run-1", 4), summary("run-2", 2)]);
    expect(merged?.map((item) => [item.runId, item.rev])).toEqual([
      ["run-1", 9],
      ["run-2", 2],
    ]);
  });

  it("keeps older-page summaries across a refresh of the current window", () => {
    const previous = snapshot([{ id: "m1", seq: 1 }], [summary("run-old", 3)]);
    const recent = snapshot([{ id: "m2", seq: 2 }], [summary("run-new", 1)]);
    const merged = mergeThreadHistory(previous, recent, true);
    expect(merged.executions?.map((item) => item.runId).sort()).toEqual(["run-new", "run-old"]);
  });

  it("carries page summaries into the loaded history and survives a window-only refresh", () => {
    const base: Snapshot = { threadId: "thread-1", messages: [{ id: "m9", seq: 9 }], olderCursor: 8 };
    const page = { threadId: "thread-1", messages: [{ id: "m2", seq: 2 }], olderCursor: null, executions: [summary("run-page", 2)] };
    const loaded = prependThreadHistoryPage(base, page)!;
    expect(loaded.executions?.map((item) => item.runId)).toEqual(["run-page"]);
    expect(loaded.olderCursor).toBeNull();

    // A refresh without a page (older server omits the field) must not erase it.
    const refreshed = mergeThreadHistory(loaded, { ...snapshot([{ id: "m10", seq: 10 }], [summary("run-live", 1)]), olderCursor: null }, true);
    expect(refreshed.executions?.map((item) => item.runId).sort()).toEqual(["run-live", "run-page"]);
  });
});

describe("displayBlocks merge", () => {
  it("keeps page display blocks across a window-only refresh and de-dupes by blockId", () => {
    const base: Snapshot = {
      threadId: "thread-1",
      messages: [{ id: "m9", seq: 9 }],
      olderCursor: 8,
      displayBlocks: [displayBlock("m9:0:markdown")],
    };
    const page = {
      threadId: "thread-1",
      messages: [{ id: "m2", seq: 2 }],
      olderCursor: null,
      displayBlocks: [displayBlock("m2:0:markdown")],
    };
    const loaded = prependThreadHistoryPage(base, page)!;
    expect(loaded.displayBlocks?.map((block) => block.blockId)).toEqual([
      "m9:0:markdown",
      "m2:0:markdown",
    ]);

    // A refresh without a page (older server omits the field) must not erase it.
    const refreshed = mergeThreadHistory(
      loaded,
      { ...snapshot([{ id: "m10", seq: 10 }]), olderCursor: null },
      true,
    );
    expect(refreshed.displayBlocks?.map((block) => block.blockId)).toEqual([
      "m9:0:markdown",
      "m2:0:markdown",
    ]);
  });

  it("prefers the fresher projection when both sides carry the same blockId", () => {
    const recent = {
      ...snapshot([{ id: "m9", seq: 9 }]),
      displayBlocks: [displayBlock("m9:0:markdown", "fresh")],
    };
    const previous = {
      ...snapshot([{ id: "m8", seq: 8 }]),
      displayBlocks: [displayBlock("m9:0:markdown", "stale")],
    };
    const merged = mergeThreadHistory(previous, recent, true);
    expect(merged.displayBlocks).toEqual([displayBlock("m9:0:markdown", "fresh")]);
  });
});

describe("upsertMessageById", () => {
  it("replays one message id as an update instead of a duplicate card row", () => {
    const first = { id: "m1", seq: 1, text: "first" };
    const second = { id: "m2", seq: 2, text: "second" };
    const replayed = { id: "m1", seq: 1, text: "updated" };
    const once = upsertMessageById([first, second], replayed);
    const twice = upsertMessageById(once, replayed);
    expect(twice).toHaveLength(2);
    expect(twice).toEqual([replayed, second]);
  });
});
