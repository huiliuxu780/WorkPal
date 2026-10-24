import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { projectPublicDelegations } from "./public-collaboration";

const ISO = "2026-10-24T00:00:00.000Z";
const THREAD = "thread-group";

function outbound(input: {
  id: string;
  seq?: number;
  runId?: string;
  senderBotId?: string;
  targetBotId: string;
  targetName: string;
  text: string;
  intent?: "request" | "result" | "question" | "status" | "fyi";
}): ThreadMessage {
  return {
    id: input.id,
    threadId: THREAD,
    seq: input.seq ?? 0,
    role: "bot",
    ...(input.senderBotId === undefined ? {} : { botId: input.senderBotId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    blocks: [
      {
        kind: "bot_message_sent",
        toBotId: input.targetBotId,
        toBotName: input.targetName,
        text: input.text,
        intent: input.intent ?? "request",
      },
    ],
    createdAt: ISO,
  };
}

function inbound(input: {
  id: string;
  seq?: number;
  outboundId: string;
  targetRunId?: string;
  senderName?: string;
  text?: string;
}): ThreadMessage {
  return {
    id: input.id,
    threadId: THREAD,
    seq: input.seq ?? 0,
    role: "user",
    ...(input.targetRunId === undefined ? {} : { runId: input.targetRunId }),
    blocks: [
      {
        kind: "bot_message_received",
        fromBotId: "bot-sender",
        fromBotName: input.senderName ?? "Sender stored",
        text: input.text ?? "body",
        intent: "request",
        returnToMessageId: input.outboundId,
      },
    ],
    createdAt: ISO,
  };
}

function textMessage(id: string, runId = "source-1"): ThreadMessage {
  return {
    id,
    threadId: THREAD,
    seq: 0,
    role: "bot",
    botId: "bot-sender",
    runId,
    blocks: [{ kind: "text", text: "an ordinary reply" }],
    createdAt: ISO,
  };
}

describe("public delegation projection", () => {
  it("pairs a sender record with its target wake prompt and hides only the prompt", () => {
    const messages = [
      outbound({
        id: "out-1",
        runId: "source-1",
        senderBotId: "bot-sender",
        targetBotId: "bot-target",
        targetName: "Target stored",
        text: "Review the public delegation layout.",
      }),
      inbound({ id: "in-1", outboundId: "out-1", targetRunId: "target-1" }),
    ];
    const projection = projectPublicDelegations(messages);
    const group = projection.groupsByFirstMessageId.get("out-1");

    expect(group).toMatchObject({
      sourceRunId: "source-1",
      senderBotId: "bot-sender",
      senderFallbackName: "Sender stored",
      firstMessageId: "out-1",
    });
    expect(group?.deliveries).toEqual([
      {
        messageId: "out-1",
        targetBotId: "bot-target",
        targetFallbackName: "Target stored",
        targetRunId: "target-1",
        body: "Review the public delegation layout.",
        intent: "request",
        trace: "sent",
      },
    ]);
    expect([...projection.hiddenMessageIds]).toEqual(["in-1"]);
  });

  it("keeps an orphan wake hidden without claiming it for any merge group", () => {
    // A wake with no preceding outbound (e.g. a resumed turn) is hidden from
    // the transcript but belongs to no rendered group, so its execution
    // anchors must render at its own position — the Shell guard that skips
    // merged-member rows must never drop an orphan like this.
    const messages = [
      inbound({ id: "in-orphan", outboundId: "out-missing", targetRunId: "target-orphan" }),
    ];
    const projection = projectPublicDelegations(messages);
    expect([...projection.hiddenMessageIds]).toEqual(["in-orphan"]);
    for (const group of projection.groupsByFirstMessageId.values()) {
      expect(group.messageIds).not.toContain("in-orphan");
    }
  });

  it("merges adjacent same-source deliveries while keeping every target Run separate", () => {
    const messages = [
      outbound({
        id: "out-1",
        runId: "source-1",
        senderBotId: "bot-sender",
        targetBotId: "bot-blue",
        targetName: "Blue",
        text: "Check the performance baseline.",
      }),
      inbound({ id: "in-1", outboundId: "out-1", targetRunId: "target-blue" }),
      outbound({
        id: "out-2",
        runId: "source-1",
        senderBotId: "bot-sender",
        targetBotId: "bot-orange",
        targetName: "Orange",
        text: "Draft two first-screen options.",
      }),
      inbound({ id: "in-2", outboundId: "out-2", targetRunId: "target-orange" }),
    ];

    const projection = projectPublicDelegations(messages);
    const groups = [...projection.groupsByFirstMessageId.values()];

    expect(groups).toHaveLength(1);
    expect(groups[0]?.firstMessageId).toBe("out-1");
    expect(groups[0]?.deliveries.map((delivery) => delivery.targetRunId)).toEqual([
      "target-blue",
      "target-orange",
    ]);
    expect(groups[0]?.messageIds).toEqual(["out-1", "in-1", "out-2", "in-2"]);
    expect(projection.hiddenMessageIds).toEqual(new Set(["in-1", "in-2", "out-2"]));
  });

  it("does not merge across a different source Run, sender, or an ordinary message", () => {
    const otherRun = outbound({
      id: "out-run",
      runId: "source-2",
      senderBotId: "bot-sender",
      targetBotId: "bot-blue",
      targetName: "Blue",
      text: "other run",
    });
    const otherSender = outbound({
      id: "out-sender",
      runId: "source-1",
      senderBotId: "bot-other",
      targetBotId: "bot-blue",
      targetName: "Blue",
      text: "other sender",
    });
    const base = outbound({
      id: "out-1",
      runId: "source-1",
      senderBotId: "bot-sender",
      targetBotId: "bot-blue",
      targetName: "Blue",
      text: "first",
    });
    const baseInbound = inbound({ id: "in-1", outboundId: "out-1", targetRunId: "target-1" });

    const projection = projectPublicDelegations([base, baseInbound, otherRun, otherSender]);
    expect([...projection.groupsByFirstMessageId.keys()]).toEqual([
      "out-1",
      "out-run",
      "out-sender",
    ]);

    const split = projectPublicDelegations([
      base,
      baseInbound,
      textMessage("ordinary"),
      outbound({
        id: "out-2",
        runId: "source-1",
        senderBotId: "bot-sender",
        targetBotId: "bot-orange",
        targetName: "Orange",
        text: "after ordinary",
      }),
      inbound({ id: "in-2", outboundId: "out-2", targetRunId: "target-2" }),
    ]);
    expect([...split.groupsByFirstMessageId.keys()]).toEqual(["out-1", "out-2"]);
    expect(split.hiddenMessageIds.has("ordinary")).toBe(false);
  });

  it("marks an interior sender record without its target half as not sent", () => {
    const projection = projectPublicDelegations([
      outbound({
        id: "out-lost",
        runId: "source-1",
        senderBotId: "bot-sender",
        targetBotId: "bot-gone",
        targetName: "Gone",
        text: "Evidence review",
      }),
      textMessage("ordinary", "source-1"),
    ]);
    const group = projection.groupsByFirstMessageId.get("out-lost");

    expect(group?.deliveries[0]?.trace).toBe("failed");
    expect(group?.deliveries[0]?.targetRunId).toBeUndefined();
  });

  it("keeps a trailing sender record unknown instead of guessing a page boundary", () => {
    const projection = projectPublicDelegations([
      textMessage("ordinary", "source-1"),
      outbound({
        id: "out-edge",
        runId: "source-1",
        senderBotId: "bot-sender",
        targetBotId: "bot-target",
        targetName: "Target",
        text: "Evidence review",
      }),
    ]);
    const group = projection.groupsByFirstMessageId.get("out-edge");

    expect(group?.deliveries[0]?.trace).toBe("unknown");
  });

  it("hides a legacy wake prompt that has no return pointer and never groups it", () => {
    const legacy: ThreadMessage = {
      id: "legacy-in",
      threadId: THREAD,
      seq: 0,
      role: "user",
      runId: "target-legacy",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-sender",
          fromBotName: "Sender",
          text: "legacy prompt",
        },
      ],
      createdAt: ISO,
    };
    const projection = projectPublicDelegations([legacy]);

    expect(projection.groupsByFirstMessageId.size).toBe(0);
    expect(projection.hiddenMessageIds.has("legacy-in")).toBe(true);
  });

  it("projects a result return without turning it into a delegation", () => {
    const messages = [
      outbound({
        id: "out-result",
        runId: "target-1",
        senderBotId: "bot-target",
        targetBotId: "bot-sender",
        targetName: "Sender",
        text: "The baseline finished.",
        intent: "result",
      }),
      inbound({ id: "in-result", outboundId: "out-result", targetRunId: "target-2" }),
    ];
    const projection = projectPublicDelegations(messages);
    const group = projection.groupsByFirstMessageId.get("out-result");

    expect(group?.deliveries[0]?.intent).toBe("result");
    expect(group?.deliveries[0]?.trace).toBe("sent");
  });
});
