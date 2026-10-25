import {
  type InterventionView,
  legacyInterventionId,
  type MessageBlock,
  type PlanReviewContent,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  type CardMessageFact,
  projectExecutionDisplayBlocks,
  projectExecutionInteractions,
  projectThreadCardSurface,
} from "./card-interactions.js";

const createdAt = "2026-10-24T10:00:00.000Z";

function intervention(overrides: Partial<InterventionView> = {}): InterventionView {
  return {
    id: "intervention-1",
    revision: 1,
    kind: "input",
    status: "pending",
    spaceId: "space-1",
    threadId: "thread-1",
    runId: "run-1",
    attemptId: "attempt-1",
    botId: "bot-1",
    messageId: "message-1",
    createdAt,
    requestingActor: { botId: "bot-1" },
    input: { mode: "text" },
    presentation: { text: "Which city?" },
    ...overrides,
  } as InterventionView;
}

function message(
  blocks: MessageBlock[],
  overrides: Partial<CardMessageFact> = {},
): CardMessageFact {
  return {
    id: "message-1",
    threadId: "thread-1",
    spaceId: "space-1",
    botId: "bot-1",
    runId: "run-1",
    createdAt,
    blocks,
    ...overrides,
  };
}

const plan: PlanReviewContent = {
  planId: "plan-1",
  contentVersion: 2,
  revision: 4,
  goal: "Ship cards",
  items: [{ id: "item-1", title: "Define schemas", status: "pending" }],
  source: "plan_exit",
};

const baseInput = {
  spaceId: "space-1",
  threadId: "thread-1",
  messages: [] as CardMessageFact[],
  interventions: [] as InterventionView[],
  runs: [],
};

describe("CARD-01 thread card surface", () => {
  it("maps durable Interventions into strict, addressable views", () => {
    const surface = projectThreadCardSurface({
      ...baseInput,
      interventions: [
        intervention(),
        intervention({
          id: "approval-1",
          kind: "approval",
          messageId: "message-2",
          approval: { effectId: "effect-1", effectStatus: "intended" },
        }),
        intervention({
          id: "plan-1",
          kind: "plan_review",
          messageId: "message-3",
          input: undefined,
          approval: undefined,
          planReview: { content: plan },
        }),
      ],
    });
    expect(surface.interactions.map((view) => view.kind)).toEqual([
      "plan_review",
      "action_approval",
      "input_request",
    ]);
    expect(surface.interactions[1]).toMatchObject({
      kind: "action_approval",
      approval: { kind: "tool", effectId: "effect-1" },
      source: { threadId: "thread-1", messageId: "message-2", runId: "run-1" },
    });
    expect(surface.interactions[0]).not.toHaveProperty("approval");
    expect(JSON.stringify(surface.interactions[0])).not.toContain("effectId");
    expect(surface.attention).toHaveLength(3);
    // Attention uses its own frozen order (expiry → attentionAt → stableId),
    // not the pending-kind display order.
    expect(surface.attention.map((item) => item.kind)).toEqual([
      "action_approval",
      "input_request",
      "plan_review",
    ]);
  });

  it("keeps app authorization, MCP assignment, and skill save distinct", () => {
    const surface = projectThreadCardSurface({
      ...baseInput,
      messages: [
        message([
          {
            kind: "app_connect",
            connectorId: "composio",
            provider: "composio",
            name: "Gmail",
            description: "Read mail",
            logo: null,
            status: "pending",
          },
          {
            kind: "mcp_approval",
            name: "Docs",
            serverId: "server-1",
            transport: "streamable_http",
            endpoint: "https://mcp.example.test",
            needsOAuth: true,
            status: "pending",
          },
          {
            kind: "skill_draft",
            skillId: "skill-1",
            name: "Triage",
            goal: "Sort the inbox",
            playbook: {
              whenToUse: "New mail",
              inputs: [],
              steps: ["Read"],
              howToCheck: "Sorted",
              whatToReturn: "Summary",
              approvalBoundaries: "No sending",
              failureHandling: "Stop",
            },
            status: "draft",
          },
        ]),
      ],
    });
    const approvals = surface.interactions.filter((view) => view.kind === "action_approval");
    expect(approvals.map((view) => view.approval.kind)).toEqual([
      "connect.app_authorization",
      "connect.mcp_assignment",
      "skill_save",
    ]);
    expect(approvals[1]?.approval).toMatchObject({ allowAllTools: true });
    expect(approvals[2]?.approval).not.toHaveProperty("effectId");
    expect(JSON.stringify(approvals)).not.toContain("requestApproval(tool)");
    expect(surface.attention).toHaveLength(3);
  });

  it("keeps every same-kind approval block from one message addressable", () => {
    const surface = projectThreadCardSurface({
      ...baseInput,
      messages: [
        message([
          {
            kind: "app_connect",
            connectorId: "composio",
            provider: "gmail",
            name: "Gmail",
            description: "Read mail",
            logo: null,
            status: "pending",
          },
          {
            kind: "app_connect",
            connectorId: "composio",
            provider: "drive",
            name: "Drive",
            description: "Read files",
            logo: null,
            status: "pending",
          },
        ]),
      ],
    });
    const approvals = surface.interactions.filter((view) => view.kind === "action_approval");
    expect(approvals).toHaveLength(2);
    expect(new Set(approvals.map((view) => view.interactionId)).size).toBe(2);
    expect(approvals.map((view) => view.presentation.text)).toEqual(["Gmail", "Drive"]);
    expect(surface.attention).toHaveLength(2);
  });

  it("keeps a skill-save draft whose goal uses the existing skills.start limit", () => {
    const goal = "g".repeat(3_500);
    const surface = projectThreadCardSurface({
      ...baseInput,
      messages: [
        message([
          {
            kind: "skill_draft",
            skillId: "skill-1",
            name: "Triage",
            goal,
            playbook: {
              whenToUse: "New mail",
              inputs: [],
              steps: ["Read"],
              howToCheck: "Sorted",
              whatToReturn: "Summary",
              approvalBoundaries: "No sending",
              failureHandling: "Stop",
            },
            status: "draft",
          },
        ]),
      ],
    });
    const approvals = surface.interactions.filter((view) => view.kind === "action_approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.approval).toMatchObject({ kind: "skill_save", goal });
    expect(surface.attention).toHaveLength(1);
  });

  it("keeps skill drafts with the editor's empty or long names", () => {
    const longName = "n".repeat(300);
    const playbook = {
      whenToUse: "New mail",
      inputs: [],
      steps: ["Read"],
      howToCheck: "Sorted",
      whatToReturn: "Summary",
      approvalBoundaries: "No sending",
      failureHandling: "Stop",
    };
    const surface = projectThreadCardSurface({
      ...baseInput,
      messages: [
        message([
          {
            kind: "skill_draft",
            skillId: "skill-empty",
            name: "",
            goal: "Sort mail",
            playbook,
            status: "draft",
          },
          {
            kind: "skill_draft",
            skillId: "skill-long",
            name: longName,
            goal: "Sort mail",
            playbook,
            status: "draft",
          },
        ]),
      ],
    });
    const approvals = surface.interactions.filter((view) => view.kind === "action_approval");
    expect(approvals.map((view) => view.approval)).toEqual([
      expect.objectContaining({ kind: "skill_save", skillId: "skill-empty", name: "" }),
      expect.objectContaining({ kind: "skill_save", skillId: "skill-long", name: longName }),
    ]);
    expect(surface.attention).toHaveLength(2);
  });

  it("preserves a settled legacy plan-review state instead of reviving it", () => {
    const surface = projectThreadCardSurface({
      ...baseInput,
      messages: [
        message([
          {
            kind: "ask",
            text: "Review the plan",
            status: "pending",
            planReview: plan,
          },
        ]),
      ],
      interventions: [
        intervention({
          id: legacyInterventionId("message-1"),
          kind: "input",
          status: "cancelled",
          revision: 4,
          expiresAt: "2026-10-24T11:00:00.000Z",
          messageId: "message-1",
          input: { mode: "text" },
          presentation: { text: "Review the plan" },
        }),
      ],
    });
    expect(surface.interactions).toEqual([
      expect.objectContaining({
        kind: "plan_review",
        status: "cancelled",
        revision: 4,
        expiresAt: "2026-10-24T11:00:00.000Z",
        source: expect.objectContaining({ messageId: "message-1" }),
      }),
    ]);
    expect(surface.attention).toEqual([]);
  });

  it("treats settled legacy blocks as terminal history, never actionable", () => {
    const surface = projectThreadCardSurface({
      ...baseInput,
      messages: [
        message([
          {
            kind: "app_connect",
            provider: "composio",
            name: "Gmail",
            description: "Read mail",
            logo: null,
            status: "connected",
          },
          {
            kind: "mcp_approval",
            name: "Docs",
            serverId: "server-1",
            transport: "sse",
            endpoint: null,
            needsOAuth: false,
            status: "dismissed",
          },
          {
            kind: "skill_draft",
            skillId: "skill-1",
            name: "Triage",
            goal: "Sort",
            playbook: {
              whenToUse: "New mail",
              inputs: [],
              steps: [],
              howToCheck: "Sorted",
              whatToReturn: "Summary",
              approvalBoundaries: "None",
              failureHandling: "Stop",
            },
            status: "saved",
          },
        ]),
      ],
    });
    expect(surface.interactions.map((view) => view.status)).toEqual([
      "answered",
      "cancelled",
      "answered",
    ]);
    expect(surface.attention).toEqual([]);
  });

  it("does not turn a settled ask into an actionable card", () => {
    const surface = projectThreadCardSurface({
      ...baseInput,
      interventions: [intervention({ status: "answered", revision: 2, resolvedAt: createdAt })],
    });
    expect(surface.interactions).toEqual([
      expect.objectContaining({ kind: "input_request", status: "answered", revision: 2 }),
    ]);
    expect(surface.attention).toEqual([]);
  });

  it("maps only frozen display members and excludes receipts, cards, connects, and computer history", () => {
    const surface = projectThreadCardSurface({
      ...baseInput,
      messages: [
        message([
          { kind: "text", text: "Hello" },
          {
            kind: "chart",
            name: "Trend",
            spec: { mark: "line" },
            data: [{ x: 1 }],
          },
          { kind: "image", artifactId: "artifact-1", mimeType: "image/png", name: "chart.png" },
          {
            kind: "file",
            artifactId: "artifact-2",
            mimeType: "text/plain",
            name: "a.txt",
            size: 3,
          },
          {
            kind: "subagent",
            agentId: "agent-1",
            name: "Researcher",
            task: "Find",
            status: "completed",
          },
          {
            kind: "cloud_agent",
            agentId: "cloud-1",
            title: "Remote fix",
            status: "finished",
            url: "https://cloud.example.test",
          },
          {
            kind: "collaboration_receipt",
            target: { kind: "group", groupId: "group-1", threadId: "thread-1" },
            state: "sent",
            destination: null,
          },
          { kind: "card", lines: [{ k: "A", v: "B" }] },
          { kind: "connect", name: "App", initial: "A", color: "#000", status: "connected" },
          { kind: "computer", state: "running", text: "Bot took over" },
        ]),
      ],
    });
    expect(surface.displayBlocks.map((block) => block.kind)).toEqual([
      "markdown",
      "chart",
      "media",
      "media",
      "task_status",
      "task_status",
    ]);
    expect(surface.displayBlocks[4]).toMatchObject({
      kind: "task_status",
      status: "completed",
      source: { messageId: "message-1", runId: "run-1" },
    });
    expect(surface.interactions).toEqual([]);
    expect(surface.attention).toEqual([]);
  });

  it("derives takeover/return only from current Run and Computer facts", () => {
    const run = {
      id: "run-1",
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      status: "waiting_takeover",
      createdAt,
      waitStartedAt: createdAt,
      executionLeaseActive: false,
    };
    const waiting = projectThreadCardSurface({
      ...baseInput,
      messages: [message([{ kind: "computer", state: "waiting", text: "Take over" }])],
      runs: [run],
      computers: [
        {
          id: "computer-1",
          botId: "bot-1",
          controlHolder: "none",
          controlBotId: null,
          controlRunId: "run-1",
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
        },
      ],
    });
    expect(waiting.interactions).toEqual([
      expect.objectContaining({ kind: "session_control", action: "takeover" }),
    ]);
    const returning = projectThreadCardSurface({
      ...baseInput,
      messages: [message([{ kind: "computer", state: "running", text: "Bot took over" }])],
      runs: [run],
      computers: [
        {
          id: "computer-1",
          botId: "bot-1",
          controlHolder: "user",
          controlBotId: "bot-1",
          controlRunId: "run-1",
          controlLeaseId: "lease-1",
          controlLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
      ],
    });
    expect(returning.interactions).toEqual([
      expect.objectContaining({ kind: "session_control", action: "return" }),
    ]);
    const historicalOnly = projectThreadCardSurface({
      ...baseInput,
      messages: [message([{ kind: "computer", state: "running", text: "Bot took over" }])],
    });
    expect(historicalOnly.interactions).toEqual([]);
  });

  it("projects delegated takeovers from separate Bots in one visible thread", () => {
    const surface = projectThreadCardSurface({
      ...baseInput,
      runs: [
        {
          id: "run-delegated-1",
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-2",
          status: "waiting_takeover",
          createdAt,
          waitStartedAt: createdAt,
          executionLeaseActive: false,
        },
        {
          id: "run-delegated-2",
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-3",
          status: "waiting_takeover",
          createdAt,
          waitStartedAt: createdAt,
          executionLeaseActive: false,
        },
      ],
      computers: [
        {
          id: "computer-2",
          botId: "bot-2",
          controlHolder: "none",
          controlBotId: null,
          controlRunId: "run-delegated-1",
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
        },
        {
          id: "computer-3",
          botId: "bot-3",
          controlHolder: "none",
          controlBotId: null,
          controlRunId: "run-delegated-2",
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
        },
      ],
    });
    expect(surface.interactions).toEqual([
      expect.objectContaining({
        kind: "session_control",
        action: "takeover",
        runId: "run-delegated-1",
        computerId: "computer-2",
      }),
      expect.objectContaining({
        kind: "session_control",
        action: "takeover",
        runId: "run-delegated-2",
        computerId: "computer-3",
      }),
    ]);
  });

  it("never leaks answer, secret, address, payment body, or effect payloads", () => {
    const surface = projectThreadCardSurface({
      ...baseInput,
      interventions: [
        intervention({
          presentation: {
            text: "Choose a saved card",
            detail: "Only the last four digits are shown",
          },
        }),
      ],
      messages: [
        message([
          { kind: "text", text: "No secrets here" },
          {
            kind: "collaboration_receipt",
            target: { kind: "bot", botId: "bot-1" },
            state: "completed",
            destination: null,
          },
        ]),
      ],
    });
    const serialized = JSON.stringify({
      interactions: surface.interactions,
      attention: surface.attention,
    });
    for (const forbidden of [
      "sk-live-answer",
      "4111111111111111",
      "123 Main Street",
      "requestBody",
      "effectResult",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Plain markdown is a display block, but it is never an Interaction or an
    // attention source.
    expect(surface.interactions.map((view) => view.kind)).toEqual(["input_request"]);
    expect(surface.attention.map((item) => item.kind)).toEqual(["input_request"]);
  });

  it("projects group membership only when the actor may manage members", () => {
    const facts = {
      interactionId: "group-membership-1",
      revision: 3,
      groupId: "group-1",
      botId: "bot-1",
      messageGroupRequestId: "request-1",
      requestRevision: 2,
      sourceSpaceId: "space-1",
      sourceThreadId: "thread-1",
      sourceMessageId: "message-1",
      sourceRunId: "run-1",
      sourceBotId: "bot-1",
      createdAt,
      expiresAt: null,
      presentation: { text: "Add the bot to Design" },
      canManageMembers: true,
    };
    expect(
      projectThreadCardSurface({
        ...baseInput,
        groupMembershipApprovals: [facts],
      }).interactions,
    ).toEqual([
      expect.objectContaining({
        kind: "action_approval",
        approval: expect.objectContaining({
          kind: "group_membership",
          action: "add_bot_to_group",
        }),
      }),
    ]);
    expect(
      projectThreadCardSurface({
        ...baseInput,
        groupMembershipApprovals: [{ ...facts, canManageMembers: false }],
      }).interactions,
    ).toEqual([]);
  });

  it("projects execution snapshot blocks without inventing interactions", () => {
    expect(
      projectExecutionInteractions([
        intervention({ id: "plan-1", kind: "plan_review", planReview: { content: plan } }),
        intervention({ id: "unsigned", kind: "approval" }),
      ]),
    ).toEqual([expect.objectContaining({ kind: "plan_review", interactionId: "plan-1" })]);
    expect(
      projectExecutionDisplayBlocks([{ kind: "text", text: "Result" }], {
        threadId: "thread-1",
        messageId: "message-1",
        runId: "run-1",
      }),
    ).toEqual([expect.objectContaining({ kind: "markdown", text: "Result" })]);
  });
});
