import type { ActivityItem, ExecutionSummary, Run, ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { projectPublicDelegations, publicDelegationStatus } from "./public-collaboration";

const ISO = "2026-10-23T00:00:00.000Z";
const THREAD = "thread-group";

function outbound(input: {
  id: string;
  seq: number;
  sourceRunId: string;
  senderBotId?: string;
  targetBotId: string;
  targetName: string;
  text: string;
}): ThreadMessage {
  return {
    id: input.id,
    threadId: THREAD,
    seq: input.seq,
    role: "bot",
    botId: input.senderBotId ?? "bot-a",
    runId: input.sourceRunId,
    blocks: [
      {
        kind: "bot_message_sent",
        toBotId: input.targetBotId,
        toBotName: input.targetName,
        text: input.text,
        intent: "request",
      },
    ],
    createdAt: ISO,
  };
}

function inbound(input: {
  id: string;
  seq: number;
  outboundId: string;
  targetRunId: string;
  senderBotId?: string;
  senderName?: string;
  text: string;
}): ThreadMessage {
  return {
    id: input.id,
    threadId: THREAD,
    seq: input.seq,
    role: "user",
    runId: input.targetRunId,
    blocks: [
      {
        kind: "bot_message_received",
        fromBotId: input.senderBotId ?? "bot-a",
        fromBotName: input.senderName ?? "Alpha",
        text: input.text,
        intent: "request",
        returnToMessageId: input.outboundId,
      },
    ],
    createdAt: ISO,
  };
}

function textMessage(id: string, seq: number): ThreadMessage {
  return {
    id,
    threadId: THREAD,
    seq,
    role: "bot",
    botId: "bot-a",
    runId: "source-1",
    blocks: [{ kind: "text", text: "ordinary response" }],
    createdAt: ISO,
  };
}

function run(id: string, botId: string, status: Run["status"], error: string | null = null): Run {
  return {
    id,
    botId,
    threadId: THREAD,
    taskId: `task:${id}`,
    status,
    waitKind: null,
    trigger: "bot_message",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error,
    startedAt: ISO,
    completedAt: ["completed", "failed", "cancelled"].includes(status) ? ISO : null,
    createdAt: ISO,
  };
}

const callOne = [
  outbound({
    id: "out-1",
    seq: 1,
    sourceRunId: "source-1",
    targetBotId: "bot-b",
    targetName: "Beta",
    text: "Do A",
  }),
  inbound({ id: "in-1", seq: 2, outboundId: "out-1", targetRunId: "target-1", text: "Do A" }),
];

const callTwo = [
  outbound({
    id: "out-2",
    seq: 3,
    sourceRunId: "source-1",
    targetBotId: "bot-c",
    targetName: "Gamma",
    text: "Do B",
  }),
  inbound({ id: "in-2", seq: 4, outboundId: "out-2", targetRunId: "target-2", text: "Do B" }),
];

describe("public collaboration display projection", () => {
  it("projects one public delegation with its independent target Run", () => {
    const projection = projectPublicDelegations(callOne, {
      runs: [run("target-1", "bot-b", "queued")],
    });
    const group = projection.groupsByFirstMessageId.get("out-1");

    expect(group).toMatchObject({
      sourceRunId: "source-1",
      senderBotId: "bot-a",
      senderFallbackName: "Alpha",
    });
    expect(group?.deliveries).toEqual([
      expect.objectContaining({
        targetBotId: "bot-b",
        targetRunId: "target-1",
        text: "Do A",
        status: { kind: "queued" },
      }),
    ]);
    expect(projection.hiddenMessageIds).toEqual(new Set(["in-1"]));
  });

  it("visually merges adjacent calls from the same source Run and sender", () => {
    const projection = projectPublicDelegations([...callOne, ...callTwo], {
      runs: [
        run("target-1", "bot-b", "completed"),
        run("target-2", "bot-c", "failed", "Safe failure"),
      ],
    });
    const groups = [...projection.groupsByFirstMessageId.values()];

    expect(groups).toHaveLength(1);
    expect(groups[0]?.deliveries.map((delivery) => delivery.targetRunId)).toEqual([
      "target-1",
      "target-2",
    ]);
    expect(groups[0]?.deliveries.map((delivery) => delivery.status)).toEqual([
      { kind: "completed" },
      { kind: "failed", detail: "Safe failure" },
    ]);
    expect(projection.hiddenMessageIds).toEqual(new Set(["in-1", "in-2", "out-2"]));
  });

  it("does not merge calls from different source Runs", () => {
    const secondSource = callTwo.map((message) =>
      message.id === "out-2" ? { ...message, runId: "source-2" } : message,
    );
    const projection = projectPublicDelegations([...callOne, ...secondSource], { runs: [] });

    expect([...projection.groupsByFirstMessageId.keys()]).toEqual(["out-1", "out-2"]);
  });

  it("does not merge calls from different senders", () => {
    const secondSender = callTwo.map((message) =>
      message.id === "out-2" ? { ...message, botId: "bot-other" } : message,
    );
    const projection = projectPublicDelegations([...callOne, ...secondSender], { runs: [] });

    expect([...projection.groupsByFirstMessageId.keys()]).toEqual(["out-1", "out-2"]);
  });

  it("does not merge across an ordinary message", () => {
    const projection = projectPublicDelegations(
      [...callOne, textMessage("ordinary", 3), ...callTwo],
      { runs: [] },
    );

    expect([...projection.groupsByFirstMessageId.keys()]).toEqual(["out-1", "out-2"]);
    expect(projection.hiddenMessageIds.has("ordinary")).toBe(false);
  });

  it("keeps an unpaired public outbound out of the private receipt path", () => {
    const onlyOutbound = callOne.filter((message) => message.id === "out-1");
    const projection = projectPublicDelegations(onlyOutbound, { runs: [] });

    expect(projection.groupsByFirstMessageId).toHaveLength(0);
    expect(projection.hiddenMessageIds).toEqual(new Set(["out-1"]));
  });

  it("keeps terminal target states independent across Run and live Activity facts", () => {
    const activity: ActivityItem[] = [
      {
        id: "run:target-failed",
        runId: "target-failed",
        botId: "bot-c",
        threadId: THREAD,
        kind: "failed",
        status: "failed",
        title: "Could not finish",
        detail: "Permission denied",
      },
    ];
    const executions: ExecutionSummary[] = [
      {
        runId: "target-complete",
        threadId: THREAD,
        botId: "bot-b",
        rev: 3,
        status: "completed",
        trigger: "bot_message",
        title: "Done",
        updatedAt: ISO,
        artifacts: [],
        entry: "collaboration",
      },
    ];

    expect(publicDelegationStatus("target-complete", { runs: [], executions, activity })).toEqual({
      kind: "completed",
    });
    expect(publicDelegationStatus("target-failed", { runs: [], executions, activity })).toEqual({
      kind: "failed",
      detail: "Permission denied",
    });
  });
});
