import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { groupPeerReceipts, peerReceiptTargetsForMessage } from "./peer-receipts";

function message(
  id: string,
  blocks: MessageBlock[],
  options: { runId?: string; role?: "user" | "bot" } = {},
): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 1,
    role: options.role ?? "bot",
    botId: "bot-joy",
    blocks,
    createdAt: "2026-10-26T10:00:00.000Z",
    ...(options.runId ? { runId: options.runId } : {}),
  };
}

const pairReceipt = (botId: string, pairThreadId: string, messageId: string): MessageBlock => ({
  kind: "collaboration_receipt",
  target: { kind: "bot", botId },
  state: "sent",
  destination: { kind: "pair_message", pairThreadId, messageId },
});

describe("peer receipts", () => {
  it("reads one openable target from a collaboration receipt", () => {
    const groups = groupPeerReceipts([message("m1", [pairReceipt("bot-blue", "pair-1", "msg-1")])]);
    expect(groups.groups).toHaveLength(1);
    expect(groups.groups[0]!.targets[0]).toMatchObject({
      botId: "bot-blue",
      state: "sent",
      sourceReceiptMessageId: "m1",
      destination: { kind: "pair_message", pairThreadId: "pair-1", messageId: "msg-1" },
    });
  });

  it("keeps a legacy receipt visible but non-openable", () => {
    const groups = groupPeerReceipts([
      message("m1", [
        { kind: "bot_message_sent", toBotId: "bot-blue", toBotName: "Blue", text: "" },
      ]),
    ]);
    expect(groups.groups[0]!.targets[0]).toMatchObject({
      botId: "bot-blue",
      destination: null,
      sourceReceiptMessageId: "m1",
    });
  });

  it("does not treat a group destination receipt as a private receipt", () => {
    const groups = groupPeerReceipts([
      message("m1", [
        {
          kind: "collaboration_receipt",
          target: { kind: "group", groupId: "group-1", threadId: "thread-2" },
          state: "sent",
          destination: null,
        },
      ]),
    ]);
    expect(groups.groups).toEqual([]);
    expect(groups.groupByMessageId.size).toBe(0);
  });

  it("does not swallow a pair body that happens to use bot_message_sent", () => {
    const groups = groupPeerReceipts([
      message("m1", [
        { kind: "bot_message_sent", toBotId: "bot-blue", toBotName: "Blue", text: "body" },
      ]),
    ]);
    expect(groups.groups).toEqual([]);
  });

  it("groups adjacent receipts from one Run and keeps each target locator", () => {
    const groups = groupPeerReceipts([
      message("m1", [pairReceipt("bot-blue", "pair-1", "msg-1")], { runId: "run-1" }),
      message("m2", [pairReceipt("bot-red", "pair-2", "msg-2")], { runId: "run-1" }),
      message("m3", [pairReceipt("bot-green", "pair-3", "msg-3")], { runId: "run-1" }),
    ]);
    expect(groups.groups).toHaveLength(1);
    expect(groups.groups[0]!.targets.map((target) => target.botId)).toEqual([
      "bot-blue",
      "bot-red",
      "bot-green",
    ]);
    expect(groups.groupByMessageId.get("m2")!.anchorMessageId).toBe("m1");
    expect(groups.groupByMessageId.get("m3")!.messageIds).toEqual(["m1", "m2", "m3"]);
  });

  it("keeps different Runs in separate rows", () => {
    const groups = groupPeerReceipts([
      message("m1", [pairReceipt("bot-blue", "pair-1", "msg-1")], { runId: "run-1" }),
      message("m2", [pairReceipt("bot-red", "pair-2", "msg-2")], { runId: "run-2" }),
    ]);
    expect(groups.groups).toHaveLength(2);
  });

  it("starts a new row after a substantive message", () => {
    const groups = groupPeerReceipts([
      message("m1", [pairReceipt("bot-blue", "pair-1", "msg-1")], { runId: "run-1" }),
      message("m2", [{ kind: "text", text: "hello" }], { runId: "run-1" }),
      message("m3", [pairReceipt("bot-red", "pair-2", "msg-2")], { runId: "run-1" }),
    ]);
    expect(groups.groups).toHaveLength(2);
  });

  it("dedupes a target contacted twice in one Run and keeps the latest locator", () => {
    const groups = groupPeerReceipts([
      message("m1", [pairReceipt("bot-blue", "pair-1", "msg-1")], { runId: "run-1" }),
      message("m2", [pairReceipt("bot-blue", "pair-1", "msg-2")], { runId: "run-1" }),
    ]);
    expect(groups.groups[0]!.targets).toHaveLength(1);
    expect(groups.groups[0]!.targets[0]!.destination?.messageId).toBe("msg-2");
  });

  it("lists a single message's targets directly", () => {
    const targets = peerReceiptTargetsForMessage(
      message("m1", [
        pairReceipt("bot-blue", "pair-1", "msg-1"),
        pairReceipt("bot-red", "pair-2", "msg-2"),
      ]),
    );
    expect(targets).toHaveLength(2);
  });
});
