import { describe, expect, it } from "vitest";
import { buildRunOrchestration, parseRunOrchestration } from "./orchestration.js";
import {
  collaborationContextRole,
  collaborationFromOrchestration,
  handoffCollaboration,
  handoffDepthExceeded,
  isAcknowledgementLoop,
  isHandoffBounceBack,
  MAX_HANDOFF_DEPTH,
  supportCollaboration,
  userTurnCollaboration,
} from "./collaboration.js";

describe("handoff depth (§13)", () => {
  it("allows Alice→Bob and Bob→Charlie but rejects the third transfer", () => {
    expect(MAX_HANDOFF_DEPTH).toBe(2);
    expect(handoffDepthExceeded(0)).toBe(false); // Alice → Bob = depth 1
    expect(handoffDepthExceeded(1)).toBe(false); // Bob → Charlie = depth 2
    expect(handoffDepthExceeded(2)).toBe(true); // Charlie → Dave = rejected
  });
});

describe("handoff bounce-back (§14)", () => {
  it("rejects returning the stage to its sender without a new user instruction", () => {
    expect(
      isHandoffBounceBack({ targetBotId: "alice", fromBotId: "alice", hasNewUserInstruction: false }),
    ).toBe(true);
  });

  it("allows the return when the user redirected after the handoff", () => {
    expect(
      isHandoffBounceBack({ targetBotId: "alice", fromBotId: "alice", hasNewUserInstruction: true }),
    ).toBe(false);
  });

  it("allows handing to a different bot", () => {
    expect(
      isHandoffBounceBack({ targetBotId: "charlie", fromBotId: "alice", hasNewUserInstruction: false }),
    ).toBe(false);
    expect(
      isHandoffBounceBack({ targetBotId: "alice", fromBotId: null, hasNewUserInstruction: false }),
    ).toBe(false);
  });
});

describe("message_bot acknowledgement loop (§15)", () => {
  it("blocks ack-shaped replies from a run woken by an outcome", () => {
    for (const intent of ["fyi", "status"]) {
      expect(
        isAcknowledgementLoop({ wokeIntent: "result", targetsWaker: true, intent }),
      ).toBe(true);
      expect(
        isAcknowledgementLoop({ wokeIntent: "status", targetsWaker: true, intent }),
      ).toBe(true);
    }
  });

  it("keeps substantive questions and requests allowed", () => {
    expect(
      isAcknowledgementLoop({ wokeIntent: "result", targetsWaker: true, intent: "question" }),
    ).toBe(false);
    expect(
      isAcknowledgementLoop({ wokeIntent: "result", targetsWaker: true, intent: "request" }),
    ).toBe(false);
    expect(
      isAcknowledgementLoop({ wokeIntent: "result", targetsWaker: true, intent: "result" }),
    ).toBe(false);
  });

  it("never flags messages to other bots or runs woken by requests", () => {
    expect(
      isAcknowledgementLoop({ wokeIntent: "result", targetsWaker: false, intent: "fyi" }),
    ).toBe(false);
    expect(
      isAcknowledgementLoop({ wokeIntent: "request", targetsWaker: true, intent: "fyi" }),
    ).toBe(false);
    expect(
      isAcknowledgementLoop({ wokeIntent: undefined, targetsWaker: true, intent: "fyi" }),
    ).toBe(false);
  });
});

describe("collaboration lineage in the orchestration snapshot (§5)", () => {
  it("round-trips user, support and handoff lineage", () => {
    const user = buildRunOrchestration({
      kind: "explicit_mention",
      ownerBotId: "alice",
      responseMode: "single",
      collaboration: userTurnCollaboration(),
    });
    expect(parseRunOrchestration(JSON.parse(JSON.stringify(user)))?.collaboration).toEqual({
      role: "owner",
      source: "user",
      fromBotId: null,
      parentRunId: null,
      handoffDepth: 0,
      messageHop: 0,
    });

    const support = buildRunOrchestration({
      kind: "bot_message",
      ownerBotId: "bob",
      responseMode: "single",
      ownershipMode: "support",
      collaboration: supportCollaboration({
        fromBotId: "alice",
        parentRunId: "run-alice",
        handoffDepth: 0,
        messageHop: 1,
      }),
    });
    expect(parseRunOrchestration(support)?.collaboration).toEqual({
      role: "support",
      source: "bot_message",
      fromBotId: "alice",
      parentRunId: "run-alice",
      handoffDepth: 0,
      messageHop: 1,
    });

    const handoff = buildRunOrchestration({
      kind: "handoff",
      ownerBotId: "bob",
      responseMode: "single",
      collaboration: handoffCollaboration({
        fromBotId: "alice",
        parentRunId: "run-alice",
        handoffDepth: 1,
      }),
    });
    expect(parseRunOrchestration(handoff)?.collaboration).toEqual({
      role: "owner",
      source: "handoff",
      fromBotId: "alice",
      parentRunId: "run-alice",
      handoffDepth: 1,
      messageHop: 0,
    });
  });

  it("drops a malformed lineage block but keeps the ownership decision", () => {
    const parsed = parseRunOrchestration({
      version: "v1",
      routing: { kind: "handoff" },
      ownership: { mode: "owner", ownerBotId: "bob" },
      responseMode: "single",
      collaboration: { role: "captain", source: "user" },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.collaboration).toBeUndefined();
    expect(parsed?.ownership.ownerBotId).toBe("bob");
  });

  it("reads lineage back from an unknown snapshot value", () => {
    expect(collaborationFromOrchestration(null)).toBeNull();
    expect(collaborationFromOrchestration({ junk: true })).toBeNull();
    expect(
      collaborationFromOrchestration(
        buildRunOrchestration({
          kind: "handoff",
          ownerBotId: "bob",
          responseMode: "single",
          collaboration: handoffCollaboration({
            fromBotId: "alice",
            parentRunId: "run-alice",
            handoffDepth: 1,
          }),
        }),
      )?.source,
    ).toBe("handoff");
  });
});

describe("collaborationContextRole (§21)", () => {
  it("maps lineage to the runtime identity", () => {
    expect(collaborationContextRole(userTurnCollaboration(), "user")).toBe("owner");
    expect(
      collaborationContextRole(
        supportCollaboration({ fromBotId: "a", parentRunId: "r", handoffDepth: 0, messageHop: 1 }),
        "bot_message",
      ),
    ).toBe("support");
    expect(
      collaborationContextRole(
        handoffCollaboration({ fromBotId: "a", parentRunId: "r", handoffDepth: 1 }),
        "follow_up",
      ),
    ).toBe("handoff_owner");
  });

  it("falls back to the trigger for pre-Phase-3 rows", () => {
    expect(collaborationContextRole(null, "bot_message")).toBe("support");
    expect(collaborationContextRole(null, "user")).toBe("owner");
    expect(collaborationContextRole(null, "follow_up")).toBe("owner");
  });
});
