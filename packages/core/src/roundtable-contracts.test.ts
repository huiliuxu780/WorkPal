import { describe, expect, it } from "vitest";
import {
  type CollaborationDestination,
  type CollaborationReceiptTarget,
  type DestinationLocator,
  type GroupWorkState,
  parseArtifactSummary,
  parseAttemptId,
  parseBackgroundExecutionRef,
  parseBotId,
  parseCollaborationDestination,
  parseCollaborationOrigin,
  parseCollaborationReceipt,
  parseDeliveryBatchKey,
  parseDestinationLocator,
  parseGroupDetailSummary,
  parseGroupId,
  parseGroupMemberSummary,
  parseGroupPageQuery,
  parseGroupRoutineSummary,
  parseGroupWorkDetail,
  parseGroupWorkItem,
  parseGroupWorkQuery,
  parseGroupWorkState,
  parseInterventionId,
  parseMessageId,
  parseRunId,
  parseRunInstructionRef,
  parseRuntimeTaskId,
  parseSpaceId,
  parseTaskId,
  parseTaskInstructionEnvelope,
  parseThreadId,
  parseUserId,
  ROUNDTABLE_CONTRACT_INVALID,
  RoundtableContractError,
  type RunId,
  type TaskId,
} from "./roundtable-contracts.js";

const ids = {
  user: parseUserId("user-1"),
  space: parseSpaceId("space-1"),
  bot: parseBotId("bot-1"),
  peerBot: parseBotId("bot-2"),
  group: parseGroupId("group-1"),
  thread: parseThreadId("thread-1"),
  pairThread: parseThreadId("thread-pair"),
  message: parseMessageId("message-1"),
  task: parseTaskId("task-1"),
  rootRun: parseRunId("run-root"),
  run: parseRunId("run-1"),
  attempt: parseAttemptId("attempt-1"),
  runtimeTask: parseRuntimeTaskId("runtime-task-1"),
  intervention: parseInterventionId("intervention-1"),
};

function expectContractError(fn: () => unknown, contract: string, path?: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RoundtableContractError);
  const error = caught as RoundtableContractError;
  expect(error.code).toBe(ROUNDTABLE_CONTRACT_INVALID);
  expect(error.contract).toBe(contract);
  if (path !== undefined) expect(error.path).toBe(path);
}

function assertNever(value: never): never {
  throw new Error(`unhandled contract variant: ${JSON.stringify(value)}`);
}

function describeDestination(destination: CollaborationDestination): string {
  switch (destination.kind) {
    case "current_group":
      return `group:${destination.groupId}/${destination.threadId}`;
    case "agent_pair":
      return `pair:${destination.pairThreadId}/${destination.peerBotId}`;
    default:
      return assertNever(destination);
  }
}

function describeLocator(locator: DestinationLocator): string {
  switch (locator.kind) {
    case "group_message":
      return `group:${locator.groupId}/${locator.threadId}/${locator.messageId}`;
    case "pair_message":
      return `pair:${locator.pairThreadId}/${locator.messageId}`;
    default:
      return assertNever(locator);
  }
}

function describeWorkState(state: GroupWorkState): string {
  switch (state.kind) {
    case "queued":
    case "cancelled":
      return state.kind;
    case "working":
      return `working:${state.currentAction ?? ""}`;
    case "waiting":
      return `waiting:${state.reason}`;
    case "failed":
      return `failed:${state.summary}`;
    case "done":
      return `done:${state.resultMessageId ?? ""}`;
    default:
      return assertNever(state);
  }
}

function describeReceiptTarget(target: CollaborationReceiptTarget): string {
  switch (target.kind) {
    case "bot":
      return `bot:${target.botId}`;
    case "group":
      return `group:${target.groupId}/${target.threadId}`;
    default:
      return assertNever(target);
  }
}

const workState: GroupWorkState = { kind: "working", currentAction: "reading tests" };
const workItem = {
  taskId: ids.task,
  rootRunId: ids.rootRun,
  ownerBotId: ids.bot,
  state: workState,
  updatedAt: "2026-10-22T10:00:00.000Z",
  children: [],
};
const envelope = {
  taskId: ids.task,
  revision: 2,
  original: { content: "Compare LCP across releases.", messageId: ids.message },
  amendments: [{ messageId: ids.message, seq: 4, content: "Split by region." }],
};

describe("roundtable branded ids", () => {
  it("parses every architecture id", () => {
    expect(parseUserId("user-1")).toBe(ids.user);
    expect(parseSpaceId("space-1")).toBe(ids.space);
    expect(parseBotId("bot-1")).toBe(ids.bot);
    expect(parseGroupId("group-1")).toBe(ids.group);
    expect(parseThreadId("thread-1")).toBe(ids.thread);
    expect(parseMessageId("message-1")).toBe(ids.message);
    expect(parseTaskId("task-1")).toBe(ids.task);
    expect(parseRunId("run-1")).toBe(ids.run);
    expect(parseAttemptId("attempt-1")).toBe(ids.attempt);
    expect(parseRuntimeTaskId("runtime-task-1")).toBe(ids.runtimeTask);
    expect(parseInterventionId("intervention-1")).toBe(ids.intervention);
  });

  it("rejects empty and non-string ids", () => {
    for (const value of ["", null, undefined, 1, {}, []]) {
      expect(() => parseTaskId(value)).toThrow(RoundtableContractError);
    }
  });

  it("keeps TaskId and RunId in separate namespaces", () => {
    // @ts-expect-error TaskId is not assignable to RunId.
    const run: RunId = ids.task;
    expect(run).toBe(ids.task);
  });

  it("does not let a RuntimeTaskId pass as a user-visible TaskId", () => {
    // @ts-expect-error RuntimeTaskId is not assignable to TaskId.
    const task: TaskId = ids.runtimeTask;
    expect(task).toBe(ids.runtimeTask);
  });
});

describe("CollaborationDestination", () => {
  it("parses the public group variant", () => {
    const destination = parseCollaborationDestination({
      kind: "current_group",
      groupId: ids.group,
      threadId: ids.thread,
    });
    expect(destination).toEqual({
      kind: "current_group",
      groupId: ids.group,
      threadId: ids.thread,
    });
    expect(describeDestination(destination)).toBe(`group:${ids.group}/${ids.thread}`);
  });

  it("parses the private pair variant", () => {
    const destination = parseCollaborationDestination({
      kind: "agent_pair",
      pairThreadId: ids.pairThread,
      peerBotId: ids.peerBot,
    });
    expect(destination).toEqual({
      kind: "agent_pair",
      pairThreadId: ids.pairThread,
      peerBotId: ids.peerBot,
    });
    expect(describeDestination(destination)).toBe(`pair:${ids.pairThread}/${ids.peerBot}`);
  });

  it("fails closed on an unknown kind", () => {
    expectContractError(
      () =>
        parseCollaborationDestination({
          kind: "group",
          groupId: ids.group,
          threadId: ids.thread,
        }),
      "CollaborationDestination",
      "kind",
    );
  });

  it("rejects destination fields from both variants", () => {
    expectContractError(
      () =>
        parseCollaborationDestination({
          kind: "agent_pair",
          pairThreadId: ids.pairThread,
          peerBotId: ids.peerBot,
          groupId: ids.group,
          threadId: ids.thread,
        }),
      "CollaborationDestination",
      "",
    );
  });

  it("rejects incomplete and non-object payloads", () => {
    expectContractError(
      () => parseCollaborationDestination({ kind: "agent_pair", pairThreadId: ids.pairThread }),
      "CollaborationDestination",
      "peerBotId",
    );
    expectContractError(
      () => parseCollaborationDestination([ids.group]),
      "CollaborationDestination",
      "destination",
    );
  });
});

describe("origin and locator", () => {
  it("parses an origin with an optional source message", () => {
    expect(
      parseCollaborationOrigin({
        sourceThreadId: ids.thread,
        sourceRunId: ids.rootRun,
        sourceMessageId: ids.message,
      }),
    ).toEqual({
      sourceThreadId: ids.thread,
      sourceRunId: ids.rootRun,
      sourceMessageId: ids.message,
    });
    expect(
      parseCollaborationOrigin({
        sourceThreadId: ids.thread,
        sourceRunId: ids.rootRun,
      }),
    ).toEqual({ sourceThreadId: ids.thread, sourceRunId: ids.rootRun });
  });

  it("requires the origin thread and run", () => {
    expectContractError(
      () => parseCollaborationOrigin({ sourceThreadId: ids.thread }),
      "CollaborationOrigin",
      "sourceRunId",
    );
  });

  it("parses both locator variants", () => {
    const groupLocator = parseDestinationLocator({
      kind: "group_message",
      groupId: ids.group,
      threadId: ids.thread,
      messageId: ids.message,
    });
    const pairLocator = parseDestinationLocator({
      kind: "pair_message",
      pairThreadId: ids.pairThread,
      messageId: ids.message,
    });
    expect(describeLocator(groupLocator)).toBe(`group:${ids.group}/${ids.thread}/${ids.message}`);
    expect(describeLocator(pairLocator)).toBe(`pair:${ids.pairThread}/${ids.message}`);
  });

  it("fails closed on unknown and mixed locator kinds", () => {
    expectContractError(
      () =>
        parseDestinationLocator({
          kind: "bot_message",
          botId: ids.bot,
          messageId: ids.message,
        }),
      "DestinationLocator",
      "kind",
    );
    expectContractError(
      () =>
        parseDestinationLocator({
          kind: "pair_message",
          pairThreadId: ids.pairThread,
          messageId: ids.message,
          groupId: ids.group,
        }),
      "DestinationLocator",
      "",
    );
  });
});

describe("TaskInstructionEnvelope", () => {
  it("parses the original instruction and ordered amendments", () => {
    expect(parseTaskInstructionEnvelope(envelope)).toEqual(envelope);
  });

  it("allows an envelope without a source message or amendments", () => {
    expect(
      parseTaskInstructionEnvelope({
        taskId: ids.task,
        revision: 1,
        original: { content: "Original request." },
        amendments: [],
      }),
    ).toEqual({
      taskId: ids.task,
      revision: 1,
      original: { content: "Original request." },
      amendments: [],
    });
  });

  it("rejects a non-positive revision and unordered amendments", () => {
    expectContractError(
      () => parseTaskInstructionEnvelope({ ...envelope, revision: 0 }),
      "TaskInstructionEnvelope",
      "revision",
    );
    expectContractError(
      () =>
        parseTaskInstructionEnvelope({
          ...envelope,
          amendments: [
            { messageId: ids.message, seq: 8, content: "Second." },
            { messageId: ids.message, seq: 4, content: "First." },
          ],
        }),
      "TaskInstructionEnvelope",
      "amendments[1].seq",
    );
  });

  it("rejects a missing original block", () => {
    expectContractError(
      () => parseTaskInstructionEnvelope({ taskId: ids.task, revision: 1, amendments: [] }),
      "TaskInstructionEnvelope",
      "original",
    );
  });
});

describe("RunInstructionRef and BackgroundExecutionRef", () => {
  it("parses the revision consumed by a Run", () => {
    expect(parseRunInstructionRef({ taskId: ids.task, consumedRevision: 2 })).toEqual({
      taskId: ids.task,
      consumedRevision: 2,
    });
    expectContractError(
      () => parseRunInstructionRef({ taskId: ids.task, consumedRevision: 0 }),
      "RunInstructionRef",
      "consumedRevision",
    );
  });

  it("keeps the product task and runtime task identities separate", () => {
    const execution = parseBackgroundExecutionRef({
      taskId: ids.task,
      runId: ids.run,
      attemptId: ids.attempt,
      runtimeTaskId: ids.runtimeTask,
      consumedRevision: 2,
    });
    expect(execution.taskId).toBe(ids.task);
    expect(execution.runtimeTaskId).toBe(ids.runtimeTask);
    expect(parseBackgroundExecutionRef(execution)).toEqual(execution);
  });

  it("rejects a background execution without a runtime task identity", () => {
    expectContractError(
      () =>
        parseBackgroundExecutionRef({
          taskId: ids.task,
          runId: ids.run,
          attemptId: ids.attempt,
          consumedRevision: 2,
        }),
      "BackgroundExecutionRef",
      "runtimeTaskId",
    );
  });
});

describe("DeliveryBatchKey", () => {
  const batchKey = {
    threadId: ids.thread,
    threadGeneration: 3,
    botId: ids.bot,
    originRunId: ids.rootRun,
    executionTaskId: ids.task,
    executionRunId: ids.run,
    attemptId: ids.attempt,
    runtimeTaskId: ids.runtimeTask,
    consumedRevision: 2,
  };

  it("parses a complete execution identity", () => {
    expect(parseDeliveryBatchKey(batchKey)).toEqual(batchKey);
    expect(parseDeliveryBatchKey({ ...batchKey, threadGeneration: 0 })).toEqual({
      ...batchKey,
      threadGeneration: 0,
    });
  });

  it("rejects a negative generation and a missing runtime identity", () => {
    expectContractError(
      () => parseDeliveryBatchKey({ ...batchKey, threadGeneration: -1 }),
      "DeliveryBatchKey",
      "threadGeneration",
    );
    const { runtimeTaskId: _runtimeTaskId, ...withoutRuntimeTask } = batchKey;
    expectContractError(
      () => parseDeliveryBatchKey(withoutRuntimeTask),
      "DeliveryBatchKey",
      "runtimeTaskId",
    );
  });
});

describe("CollaborationReceipt", () => {
  it("represents a group receipt without a fake toBotId", () => {
    const receipt = parseCollaborationReceipt({
      kind: "collaboration_receipt",
      target: { kind: "group", groupId: ids.group, threadId: ids.thread },
      state: "sent",
      destination: {
        kind: "group_message",
        groupId: ids.group,
        threadId: ids.thread,
        messageId: ids.message,
      },
    });
    expect(describeReceiptTarget(receipt.target)).toBe(`group:${ids.group}/${ids.thread}`);
    expect(receipt.destination?.kind).toBe("group_message");
  });

  it("rejects a group target carrying toBotId", () => {
    expectContractError(
      () =>
        parseCollaborationReceipt({
          kind: "collaboration_receipt",
          target: {
            kind: "group",
            groupId: ids.group,
            threadId: ids.thread,
            toBotId: ids.bot,
          },
          state: "failed",
          destination: null,
        }),
      "CollaborationReceiptTarget",
      "",
    );
  });

  it("requires a locator for delivered receipts and none for failures", () => {
    expectContractError(
      () =>
        parseCollaborationReceipt({
          kind: "collaboration_receipt",
          target: { kind: "bot", botId: ids.peerBot },
          state: "sent",
          destination: null,
        }),
      "CollaborationReceipt",
      "destination",
    );
    expectContractError(
      () =>
        parseCollaborationReceipt({
          kind: "collaboration_receipt",
          target: { kind: "bot", botId: ids.peerBot },
          state: "failed",
          destination: {
            kind: "pair_message",
            pairThreadId: ids.pairThread,
            messageId: ids.message,
          },
        }),
      "CollaborationReceipt",
      "destination",
    );
    expect(
      parseCollaborationReceipt({
        kind: "collaboration_receipt",
        target: { kind: "bot", botId: ids.peerBot },
        state: "failed",
        destination: null,
      }).destination,
    ).toBeNull();
  });

  it("rejects a group receipt pointing at a pair locator", () => {
    expectContractError(
      () =>
        parseCollaborationReceipt({
          kind: "collaboration_receipt",
          target: { kind: "group", groupId: ids.group, threadId: ids.thread },
          state: "completed",
          destination: {
            kind: "pair_message",
            pairThreadId: ids.pairThread,
            messageId: ids.message,
          },
        }),
      "CollaborationReceipt",
      "destination",
    );
  });

  it("fails closed on an unknown state or target kind", () => {
    expectContractError(
      () =>
        parseCollaborationReceipt({
          kind: "collaboration_receipt",
          target: { kind: "bot", botId: ids.peerBot },
          state: "unknown",
          destination: null,
        }),
      "CollaborationReceipt",
      "state",
    );
    expectContractError(
      () =>
        parseCollaborationReceipt({
          kind: "collaboration_receipt",
          target: { kind: "room", groupId: ids.group },
          state: "failed",
          destination: null,
        }),
      "CollaborationReceiptTarget",
      "kind",
    );
  });
});

describe("group read contracts", () => {
  it("parses a group page query and rejects an unbounded limit", () => {
    expect(
      parseGroupPageQuery({
        actor: { kind: "user", userId: ids.user, spaceId: ids.space },
        groupId: ids.group,
        cursor: "cursor-1",
        limit: 20,
      }),
    ).toEqual({
      actor: { kind: "user", userId: ids.user, spaceId: ids.space },
      groupId: ids.group,
      cursor: "cursor-1",
      limit: 20,
    });
    expectContractError(
      () =>
        parseGroupPageQuery({
          actor: { kind: "user", userId: ids.user, spaceId: ids.space },
          groupId: ids.group,
          limit: 0,
        }),
      "GroupPageQuery",
      "limit",
    );
  });

  it("rejects a non-user actor", () => {
    expectContractError(
      () =>
        parseGroupPageQuery({
          actor: { kind: "system", userId: ids.user, spaceId: ids.space },
          groupId: ids.group,
          limit: 20,
        }),
      "UserActor",
      "kind",
    );
  });

  it("parses a group work query", () => {
    expect(
      parseGroupWorkQuery({
        actor: { kind: "user", userId: ids.user, spaceId: ids.space },
        groupId: ids.group,
        taskId: ids.task,
      }),
    ).toEqual({
      actor: { kind: "user", userId: ids.user, spaceId: ids.space },
      groupId: ids.group,
      taskId: ids.task,
    });
  });

  it("parses every work state variant", () => {
    const states: GroupWorkState[] = [
      { kind: "queued" },
      { kind: "working" },
      { kind: "working", currentAction: "reading" },
      { kind: "waiting", reason: "approval" },
      { kind: "waiting", reason: "input" },
      { kind: "waiting", reason: "resource" },
      { kind: "failed", summary: "provider error" },
      { kind: "done" },
      { kind: "done", resultMessageId: ids.message },
      { kind: "cancelled" },
    ];
    for (const state of states) {
      expect(parseGroupWorkState(state)).toEqual(state);
      expect(describeWorkState(state)).toContain(state.kind);
    }
  });

  it("fails closed on unknown work states and waiting reasons", () => {
    expectContractError(() => parseGroupWorkState({ kind: "running" }), "GroupWorkState", "kind");
    expectContractError(
      () => parseGroupWorkState({ kind: "waiting", reason: "meeting" }),
      "GroupWorkState",
      "reason",
    );
    expectContractError(
      () => parseGroupWorkState({ kind: "cancelled", currentAction: "still running" }),
      "GroupWorkState",
      "",
    );
  });

  it("parses a recursive work item and a detail envelope", () => {
    const item = parseGroupWorkItem({
      ...workItem,
      children: [
        {
          ...workItem,
          taskId: parseTaskId("task-child"),
          rootRunId: ids.rootRun,
          state: { kind: "queued" },
        },
      ],
    });
    expect(item.children.map((child) => child.taskId)).toEqual(["task-child"]);
    expect(
      parseGroupWorkDetail({
        groupId: ids.group,
        work: item,
        instruction: envelope,
      }),
    ).toEqual({ groupId: ids.group, work: item, instruction: envelope });
  });

  it("rejects a work item without a children array", () => {
    const { children: _children, ...withoutChildren } = workItem;
    expectContractError(() => parseGroupWorkItem(withoutChildren), "GroupWorkItem", "children");
  });

  it("keeps the current user out of the agent member variant", () => {
    const members = [
      parseGroupMemberSummary({ kind: "user", userId: ids.user, name: "Joy" }),
      parseGroupMemberSummary({
        kind: "bot",
        botId: ids.bot,
        name: "Little Blue",
        status: "active",
      }),
    ];
    expect(
      parseGroupDetailSummary({
        groupId: ids.group,
        threadId: ids.thread,
        name: "Design review",
        members,
      }),
    ).toEqual({
      groupId: ids.group,
      threadId: ids.thread,
      name: "Design review",
      members,
    });
    expectContractError(
      () => parseGroupMemberSummary({ kind: "group", groupId: ids.group }),
      "GroupMemberSummary",
      "kind",
    );
  });

  it("parses artifact and routine summaries", () => {
    const artifact = {
      id: "artifact-1",
      name: "report.csv",
      description: null,
      mimeType: "text/csv",
      size: 42,
      version: 2,
      createdAt: "2026-10-22T10:00:00.000Z",
    };
    expect(parseArtifactSummary(artifact)).toEqual(artifact);
    expectContractError(
      () => parseArtifactSummary({ ...artifact, size: -1 }),
      "ArtifactSummary",
      "size",
    );

    const routine = {
      id: "routine-1",
      botId: ids.bot,
      threadId: ids.thread,
      name: "Morning brief",
      crons: ["0 9 * * *"],
      timezone: "Asia/Shanghai",
      active: true,
      nextRunAt: "2026-10-23T01:00:00.000Z",
    };
    expect(parseGroupRoutineSummary(routine)).toEqual(routine);
    expect(parseGroupRoutineSummary({ ...routine, nextRunAt: null })).toEqual({
      ...routine,
      nextRunAt: null,
    });
    expectContractError(
      () => parseGroupRoutineSummary({ ...routine, active: "yes" }),
      "GroupRoutineSummary",
      "active",
    );
  });
});
