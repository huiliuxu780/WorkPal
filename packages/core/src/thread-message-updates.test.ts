import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  reconcileCloudAgentDisplayBlocks,
  takeLiveMessage,
  updateCloudAgentMessages,
} from "./thread-message-updates.js";

const cloud = (agentId: string): MessageBlock => ({
  kind: "cloud_agent",
  agentId,
  title: "Agent",
  status: "running",
  url: "",
});

describe("shared message updates", () => {
  it("takes only the matching run and drops obsolete unscoped progress in order", () => {
    const messages = [
      { id: "first" },
      { id: "progress:legacy" },
      { id: "progress:current", runId: "current" },
      { id: "progress:other", runId: "other" },
      { id: "last" },
    ];
    const result = takeLiveMessage(messages, "progress:current");
    expect(result.previous).toBe(messages[2]);
    expect(result.remaining).toEqual([messages[0], messages[3], messages[4]]);
    expect(messages).toHaveLength(5);
  });

  it("updates every matching cloud block while preserving metadata and unrelated messages", () => {
    const messages = [
      { id: "first", replyToMessageId: "reply", blocks: [cloud("agent"), cloud("other")] },
      { id: "second", replyToMessageId: "reply", blocks: [cloud("agent")] },
      {
        id: "third",
        replyToMessageId: "reply",
        blocks: [{ kind: "text", text: "unchanged" } as MessageBlock],
      },
    ];
    const result = updateCloudAgentMessages(messages, {
      messageId: "first",
      agentId: "agent",
      status: "finished",
    });
    expect(result.map((message) => message.id)).toEqual(["first", "second", "third"]);
    expect(result[0]?.replyToMessageId).toBe("reply");
    expect(result[0]?.blocks[0]).toMatchObject({ agentId: "agent", status: "finished" });
    expect(result[1]?.blocks[0]).toMatchObject({ agentId: "agent", status: "finished" });
    expect(result[0]?.blocks[1]).toBe(messages[0]?.blocks[1]);
    expect(result[2]).toBe(messages[2]);
    expect(messages[0]?.blocks[0]).toMatchObject({ status: "running" });
  });
});

describe("reconcileCloudAgentDisplayBlocks", () => {
  const message = (blocks: MessageBlock[], id = "message-1") => ({
    id,
    threadId: "thread-1",
    runId: "run-1",
    blocks,
  });
  const stale = {
    kind: "task_status",
    blockId: "message-1:0:task_status",
    status: "running",
    title: "Agent",
    summary: null,
    destination: null,
    source: { threadId: "thread-1", messageId: "message-1", runId: "run-1" },
  } as const;

  it("rebuilds the task_status projection from the updated cloud-agent block", () => {
    const updated = [
      message([
        {
          kind: "cloud_agent",
          agentId: "agent",
          title: "Agent",
          status: "finished",
          url: "https://cloud.example.test",
          prUrl: "https://github.example.test/pr/9",
        } as MessageBlock,
      ]),
    ];
    const result = reconcileCloudAgentDisplayBlocks(updated, [stale]);
    const block = result?.[0];
    if (block?.kind !== "task_status") throw new Error("expected a task_status block");
    expect(block.status).toBe("completed");
    expect(block.destination).toBe("https://github.example.test/pr/9");
    expect(block.blockId).toBe("message-1:0:task_status");
  });

  it("leaves other projections and gate-off snapshots untouched", () => {
    const other = { kind: "markdown", blockId: "message-2:0:text", text: "hello" } as const;
    expect(
      reconcileCloudAgentDisplayBlocks(
        [message([{ kind: "text", text: "hi" } as MessageBlock], "message-2")],
        [other],
      ),
    ).toEqual([other]);
    expect(reconcileCloudAgentDisplayBlocks([message([cloud("agent")])], [])).toEqual([]);
    expect(
      reconcileCloudAgentDisplayBlocks([message([cloud("agent")])], undefined),
    ).toBeUndefined();
  });
});
