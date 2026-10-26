import { describe, expect, it } from "vitest";
import {
  type ActionApprovalView,
  ActionApprovalViewSchema,
  compareAttentionItems,
  compareInteractionViewsForDisplay,
  DisplayBlockSchema,
  deriveSessionControlViews,
  type InteractionView,
  InteractionViewSchema,
  type PlanReviewView,
  projectAttentionItems,
  projectGroupMembershipApproval,
} from "./card-interaction.js";
import { outboundDraftRecipientIssue } from "./outbound-draft.js";

const createdAt = "2026-10-24T10:00:00.000Z";
const source = {
  spaceId: "space-1",
  threadId: "thread-1",
  messageId: "message-1",
  runId: "run-1",
  botId: "bot-1",
};
const base = {
  interactionId: "interaction-1",
  revision: 1,
  status: "pending" as const,
  createdAt,
  expiresAt: null,
  attentionAt: createdAt,
  source,
  presentation: { text: "Decide" },
};

const plan = {
  planId: "plan-1",
  contentVersion: 1,
  revision: 3,
  goal: "Ship the card protocol",
  items: [{ id: "item-1", title: "Define schemas", status: "pending" as const }],
  source: "plan_exit" as const,
};

function inputView(overrides: Record<string, unknown> = {}) {
  return {
    kind: "input_request",
    ...base,
    input: { mode: "question", prompt: "Which city?", placeholder: null },
    ...overrides,
  };
}

function toolApproval(overrides: Record<string, unknown> = {}) {
  return {
    kind: "action_approval",
    ...base,
    decision: null,
    approval: {
      kind: "tool",
      authority: "external_effect",
      effectId: "effect-1",
      effectStatus: "intended",
      actions: [{ id: "allow", label: "Allow once" }],
    },
    ...overrides,
  };
}

function planReviewView(overrides: Record<string, unknown> = {}): PlanReviewView {
  return {
    kind: "plan_review",
    ...base,
    plan,
    decision: null,
    feedback: null,
    ...overrides,
  } as unknown as PlanReviewView;
}

function sessionView(overrides: Record<string, unknown> = {}) {
  return {
    kind: "session_control",
    ...base,
    source: { ...source, messageId: null },
    status: "pending" as const,
    action: "takeover" as const,
    runId: "run-1",
    botId: "bot-1",
    computerId: "computer-1",
    executionLeaseActive: false,
    controlLeaseExpiresAt: null,
    ...overrides,
  };
}

function groupMembership(overrides: Record<string, unknown> = {}) {
  const presentation = { text: "Add the bot to Design" };
  return {
    kind: "action_approval",
    ...base,
    presentation,
    decision: null,
    approval: {
      kind: "group_membership",
      authority: "business_transaction",
      action: "add_bot_to_group",
      groupId: "group-1",
      botId: "bot-1",
      messageGroupRequestId: "request-1",
      requestRevision: 2,
      sourceThreadId: source.threadId,
      sourceMessageId: source.messageId,
      presentation,
    },
    ...overrides,
  };
}

function view(key: string, overrides: Record<string, unknown> = {}): InteractionView {
  return {
    kind: "plan_review",
    interactionId: key,
    revision: 1,
    status: "pending",
    createdAt,
    expiresAt: null,
    attentionAt: createdAt,
    source: { ...source, messageId: `message-${key}` },
    presentation: { text: key },
    plan,
    decision: null,
    feedback: null,
    ...overrides,
  } as unknown as InteractionView;
}

describe("CARD-01 strict InteractionView contract", () => {
  it("parses exactly the four frozen members", () => {
    expect(InteractionViewSchema.safeParse(inputView()).success).toBe(true);
    expect(InteractionViewSchema.safeParse(toolApproval()).success).toBe(true);
    expect(InteractionViewSchema.safeParse(planReviewView()).success).toBe(true);
    expect(InteractionViewSchema.safeParse(sessionView()).success).toBe(true);
    expect(InteractionViewSchema.safeParse(groupMembership()).success).toBe(true);
    expect(
      InteractionViewSchema.safeParse({ ...inputView(), kind: "collaboration_receipt" }).success,
    ).toBe(false);
    expect(InteractionViewSchema.safeParse({ ...inputView(), kind: "task_status" }).success).toBe(
      false,
    );
  });

  it("rejects unknown fields instead of stripping them", () => {
    for (const candidate of [
      inputView({ answer: "Paris" }),
      toolApproval({ effectBody: {} }),
      planReviewView({ extra: true }),
      sessionView({ controlRunId: "run-2" }),
    ]) {
      expect(InteractionViewSchema.safeParse(candidate).success).toBe(false);
    }
    expect(
      InteractionViewSchema.safeParse({
        ...inputView(),
        input: { mode: "question", prompt: "Which city?", placeholder: null, answer: "Paris" },
      }).success,
    ).toBe(false);
  });

  it("keeps existing unbounded option and approval labels", () => {
    const label = "x".repeat(300);
    const options = Array.from({ length: 25 }, (_, index) => ({
      id: `option-${index}`,
      label,
    }));
    expect(
      InteractionViewSchema.safeParse(
        inputView({ input: { mode: "choice", prompt: "Pick", options } }),
      ).success,
    ).toBe(true);
    const actions = Array.from({ length: 12 }, (_, index) => ({
      id: `action-${index}`,
      label,
    }));
    expect(
      InteractionViewSchema.safeParse({
        kind: "action_approval",
        ...base,
        decision: null,
        approval: {
          kind: "tool",
          authority: "external_effect",
          effectId: "effect-1",
          effectStatus: "intended",
          actions,
        },
      }).success,
    ).toBe(true);
    expect(
      InteractionViewSchema.safeParse({
        kind: "action_approval",
        ...base,
        decision: null,
        approval: {
          kind: "connect.app_authorization",
          authority: "business_transaction",
          connectorId: null,
          provider: label,
          name: label,
          description: label,
        },
      }).success,
    ).toBe(true);
  });

  it("keeps the nine ActionApproval payloads independent", () => {
    const skillSave = {
      kind: "action_approval",
      ...base,
      decision: null,
      approval: {
        kind: "skill_save",
        authority: "business_transaction",
        skillId: "skill-1",
        name: "Triage",
        goal: "Sort the inbox",
        contentRevision: 1,
        playbook: {
          whenToUse: "New mail",
          inputs: [],
          steps: ["Read"],
          howToCheck: "Sorted",
          whatToReturn: "Summary",
          approvalBoundaries: "No sending",
          failureHandling: "Stop",
        },
      },
    };
    const appAuthorization = {
      kind: "action_approval",
      ...base,
      decision: null,
      approval: {
        kind: "connect.app_authorization",
        authority: "business_transaction",
        connectorId: "composio",
        provider: "composio",
        name: "Gmail",
        description: "Read mail",
      },
    };
    const mcpAssignment = {
      kind: "action_approval",
      ...base,
      decision: null,
      approval: {
        kind: "connect.mcp_assignment",
        authority: "business_transaction",
        serverId: "server-1",
        name: "Docs",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test",
        needsOAuth: true,
        allowAllTools: true,
      },
    };
    const parsed = [skillSave, appAuthorization, mcpAssignment].map((candidate) =>
      ActionApprovalViewSchema.parse(candidate),
    ) as ActionApprovalView[];
    expect(parsed.map((item) => item.approval.kind)).toEqual([
      "skill_save",
      "connect.app_authorization",
      "connect.mcp_assignment",
    ]);
    expect(parsed[0]!.approval).not.toHaveProperty("effectId");
    expect(parsed[1]!.approval).not.toHaveProperty("allowAllTools");
    expect(parsed[2]!.approval).toMatchObject({ allowAllTools: true });
    expect(JSON.stringify(parsed)).not.toContain("requestApproval(tool)");
    expect(
      ActionApprovalViewSchema.safeParse({
        ...mcpAssignment,
        approval: { ...mcpAssignment.approval, allowAllTools: false },
      }).success,
    ).toBe(false);
  });

  it("carries immutable outbound draft revisions and validates their bounds", () => {
    const outbound = {
      kind: "action_approval",
      ...base,
      decision: null,
      approval: {
        kind: "outbound",
        authority: "external_effect",
        effectId: "effect-outbound",
        effectStatus: "intended",
        channel: "email",
        recipientCount: 1,
        subject: "Weekly digest",
        fingerprint: "sha256:aaaaaaaaaaaaaaaa",
        draftState: {
          channel: "email",
          draft: {
            revision: 2,
            fingerprint: "sha256:bbbbbbbbbbbbbbbb",
            recipients: ["ada@example.test"],
            subject: "Weekly digest r2",
            body: "Edited body",
          },
          revisions: [
            {
              revision: 1,
              fingerprint: "sha256:aaaaaaaaaaaaaaaa",
              subject: "Weekly digest",
              createdAt,
              status: "superseded",
            },
            {
              revision: 2,
              fingerprint: "sha256:bbbbbbbbbbbbbbbb",
              subject: "Weekly digest r2",
              createdAt,
              status: "pending",
            },
          ],
        },
      },
    };
    const parsed = ActionApprovalViewSchema.parse(outbound) as ActionApprovalView;
    if (parsed.approval.kind !== "outbound") throw new Error("outbound expected");
    expect(parsed.approval.draftState?.draft.revision).toBe(2);
    expect(parsed.approval.draftState?.revisions.map((entry) => entry.status)).toEqual([
      "superseded",
      "pending",
    ]);
    expect(
      ActionApprovalViewSchema.safeParse({
        ...outbound,
        approval: {
          ...outbound.approval,
          draftState: {
            ...outbound.approval.draftState,
            draft: { ...outbound.approval.draftState.draft, recipients: [] },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      ActionApprovalViewSchema.safeParse({
        ...outbound,
        approval: {
          ...outbound.approval,
          draftState: {
            ...outbound.approval.draftState,
            draft: { ...outbound.approval.draftState.draft, body: "x".repeat(65_537) },
          },
        },
      }).success,
    ).toBe(false);
    for (const recipients of [["abc"], ["ada@example.test", "ada@example.test"]]) {
      expect(
        ActionApprovalViewSchema.safeParse({
          ...outbound,
          approval: {
            ...outbound.approval,
            draftState: {
              ...outbound.approval.draftState,
              draft: { ...outbound.approval.draftState.draft, recipients },
            },
          },
        }).success,
      ).toBe(false);
    }
  });

  it("mirrors the mail sender's recipient acceptance rules", () => {
    expect(outboundDraftRecipientIssue(["ada@example.test"])).toBeNull();
    expect(outboundDraftRecipientIssue([])).toBe("empty");
    expect(outboundDraftRecipientIssue(["abc"])).toBe("invalid");
    expect(outboundDraftRecipientIssue(["ada@example.test", "ADA@example.test"])).toBeNull();
    expect(outboundDraftRecipientIssue(["ada@example.test", " ada@example.test "])).toBe(
      "duplicate",
    );
    expect(
      outboundDraftRecipientIssue(
        Array.from({ length: 21 }, (_, index) => `user${index}@example.test`),
      ),
    ).toBe("too_many");
  });

  it("keeps plan review free of any approval or effect binding", () => {
    const planReview = planReviewView();
    expect(planReview).not.toHaveProperty("approval");
    expect(planReview).not.toHaveProperty("effectId");
    expect(
      PlanReviewViewSchemaSafe({
        ...planReviewView(),
        approval: {
          kind: "tool",
          authority: "external_effect",
          effectId: "effect-1",
          effectStatus: "intended",
          actions: [],
        },
      }),
    ).toBe(false);
    expect(PlanReviewViewSchemaSafe({ ...planReviewView(), effectId: "effect-1" })).toBe(false);
    expect(
      InteractionViewSchema.safeParse({
        ...planReviewView(),
        decision: "approve",
      }).success,
    ).toBe(true);
    expect(
      InteractionViewSchema.safeParse({
        ...planReviewView(),
        decision: "approved",
      }).success,
    ).toBe(false);
  });

  it("accepts only the strict add_bot_to_group group membership payload", () => {
    const parsed = ActionApprovalViewSchema.parse(groupMembership()) as ActionApprovalView;
    expect(parsed.approval).toMatchObject({
      kind: "group_membership",
      action: "add_bot_to_group",
      groupId: "group-1",
      botId: "bot-1",
      messageGroupRequestId: "request-1",
      requestRevision: 2,
    });
    const presentation = { text: "Add the bot to Design" };
    expect(
      projectGroupMembershipApproval({
        interactionId: "interaction-1",
        revision: 1,
        groupId: "group-1",
        botId: "bot-1",
        messageGroupRequestId: "request-1",
        requestRevision: 2,
        sourceSpaceId: source.spaceId,
        sourceThreadId: source.threadId,
        sourceMessageId: source.messageId,
        sourceRunId: source.runId,
        sourceBotId: source.botId,
        createdAt,
        expiresAt: null,
        presentation,
        canManageMembers: true,
      }),
    ).toMatchObject({ approval: { kind: "group_membership" } });
    expect(
      projectGroupMembershipApproval({
        interactionId: "interaction-1",
        revision: 1,
        groupId: "group-1",
        botId: "bot-1",
        messageGroupRequestId: "request-1",
        requestRevision: 2,
        sourceSpaceId: source.spaceId,
        sourceThreadId: source.threadId,
        sourceMessageId: source.messageId,
        sourceRunId: source.runId,
        sourceBotId: source.botId,
        createdAt,
        expiresAt: null,
        presentation,
        canManageMembers: false,
      }),
    ).toBeNull();
    const cases = [
      {
        ...groupMembership(),
        approval: { ...(groupMembership().approval as object), tool: "run_shell" },
      },
      {
        ...groupMembership(),
        approval: { ...(groupMembership().approval as object), args: { cmd: "x" } },
      },
      {
        ...groupMembership(),
        approval: { ...(groupMembership().approval as object), action: "remove_bot_from_group" },
      },
      {
        ...groupMembership(),
        approval: { ...(groupMembership().approval as object), messageGroupRequestId: undefined },
      },
      {
        ...groupMembership(),
        approval: { ...(groupMembership().approval as object), sourceThreadId: "thread-other" },
      },
      {
        ...groupMembership(),
        presentation: { text: "different" },
      },
    ];
    for (const candidate of cases) {
      expect(ActionApprovalViewSchema.safeParse(candidate).success).toBe(false);
    }
  });
});

function PlanReviewViewSchemaSafe(candidate: unknown): boolean {
  return InteractionViewSchema.safeParse(candidate).success;
}

describe("CARD-01 ordering and attention DTO", () => {
  it("sorts pending plan review → approval → input before terminal history", () => {
    const older = "2026-10-24T09:00:00.000Z";
    const newer = "2026-10-24T11:00:00.000Z";
    const views = [
      view("terminal", { status: "answered", createdAt: older }),
      view("input", {
        kind: "input_request",
        createdAt: newer,
        input: { mode: "question", prompt: "Q", placeholder: null },
      }),
      view("approval", {
        kind: "action_approval",
        createdAt: newer,
        decision: null,
        approval: {
          kind: "tool",
          authority: "external_effect",
          effectId: "effect-1",
          effectStatus: "intended",
          actions: [],
        },
      }),
      view("plan", { createdAt: newer }),
    ] as InteractionView[];
    const sorted = (views as Array<Exclude<InteractionView, { kind: "session_control" }>>).sort(
      compareInteractionViewsForDisplay,
    );
    expect(sorted.map((item) => item.interactionId)).toEqual([
      "plan",
      "approval",
      "input",
      "terminal",
    ]);
  });

  it("sorts attention by expiry NULLS LAST, then attentionAt and stableId", () => {
    const items = projectAttentionItems([
      view("b", { expiresAt: "2026-10-24T12:00:00.000Z", attentionAt: "2026-10-24T09:00:00.000Z" }),
      view("a", { expiresAt: "2026-10-24T12:00:00.000Z", attentionAt: "2026-10-24T09:00:00.000Z" }),
      view("none", { expiresAt: null, attentionAt: "2026-10-24T08:00:00.000Z" }),
      view("terminal", { status: "answered" }),
    ] as InteractionView[]);
    expect(items.map((item) => item.stableId)).toEqual(["a", "b", "none"]);
    expect(items.map((item) => item.kind)).toEqual(["plan_review", "plan_review", "plan_review"]);
    const duplicate = projectAttentionItems([
      view("dup"),
      { ...view("dup"), status: "pending" as const },
    ]);
    expect(duplicate).toHaveLength(1);
    expect(
      compareAttentionItems(
        {
          stableId: "a",
          interactionId: "a",
          revision: 1,
          kind: "plan_review",
          status: "pending",
          attentionAt: createdAt,
          expiresAt: "2026-10-24T12:00:00.000Z",
          source,
          presentation: { text: "a" },
        },
        {
          stableId: "b",
          interactionId: "b",
          revision: 1,
          kind: "plan_review",
          status: "pending",
          attentionAt: createdAt,
          expiresAt: null,
          source,
          presentation: { text: "b" },
        },
      ),
    ).toBeLessThan(0);
  });

  it("never classifies task_status or a receipt as an attention Interaction", () => {
    expect(
      DisplayBlockSchema.safeParse({
        kind: "task_status",
        blockId: "block-1",
        status: "running",
        title: "Indexing",
        summary: null,
        source: { threadId: "thread-1", messageId: "message-1", runId: "run-1" },
      }).success,
    ).toBe(true);
    for (const kind of ["collaboration_receipt", "task_status", "private_pair_receipt"]) {
      expect(InteractionViewSchema.safeParse({ ...inputView(), kind }).success).toBe(false);
    }
  });
});

describe("CARD-01 SessionControlView derivation", () => {
  const run = {
    id: "run-1",
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    createdAt,
    waitStartedAt: createdAt,
    executionLeaseActive: false,
  };

  it("projects takeover only from waiting_takeover", () => {
    expect(
      deriveSessionControlViews({
        runs: [{ ...run, status: "waiting_takeover" }],
        computers: [],
      }),
    ).toEqual([expect.objectContaining({ action: "takeover", runId: "run-1", computerId: null })]);
    expect(
      deriveSessionControlViews({
        runs: [{ ...run, status: "waiting_input" }],
        computers: [],
      }),
    ).toEqual([]);
  });

  it("projects return only when controlRunId matches and the user lease is live", () => {
    const now = new Date("2026-10-24T10:00:00.000Z");
    const computer = {
      id: "computer-1",
      botId: "bot-1",
      controlHolder: "user",
      controlBotId: "bot-1",
      controlRunId: "run-1",
      controlLeaseId: "lease-1",
      controlLeaseExpiresAt: "2026-10-24T10:15:00.000Z",
    };
    expect(
      deriveSessionControlViews({
        runs: [{ ...run, status: "waiting_takeover" }],
        computers: [computer],
        now,
      }).map((view) => view.action),
    ).toEqual(["return"]);
    expect(
      deriveSessionControlViews({
        runs: [{ ...run, status: "waiting_takeover" }],
        computers: [{ ...computer, controlLeaseExpiresAt: "2026-10-24T09:59:59.000Z" }],
        now,
      }).map((view) => view.action),
    ).toEqual(["takeover"]);
    expect(
      deriveSessionControlViews({
        runs: [{ ...run, status: "waiting_takeover" }],
        computers: [{ ...computer, controlRunId: "run-other" }],
        now,
      }).map((view) => view.action),
    ).toEqual(["takeover"]);
    expect(
      deriveSessionControlViews({
        runs: [{ ...run, status: "waiting_takeover", executionLeaseActive: true }],
        computers: [computer],
        now,
      }).map((view) => view.action),
    ).toEqual(["takeover"]);
  });

  it("resolves each delegated Run's control against its own Bot's Computer", () => {
    const now = new Date("2026-10-24T10:00:00.000Z");
    const views = deriveSessionControlViews({
      runs: [
        { ...run, id: "run-1", botId: "bot-1", status: "waiting_takeover" },
        { ...run, id: "run-2", botId: "bot-2", status: "waiting_takeover" },
      ],
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
        {
          id: "computer-2",
          botId: "bot-2",
          controlHolder: "user",
          controlBotId: "bot-2",
          controlRunId: "run-2",
          controlLeaseId: "lease-2",
          controlLeaseExpiresAt: "2026-10-24T10:15:00.000Z",
        },
      ],
      now,
    });
    expect(views).toEqual([
      expect.objectContaining({ action: "takeover", runId: "run-1", computerId: "computer-1" }),
      expect.objectContaining({ action: "return", runId: "run-2", computerId: "computer-2" }),
    ]);
  });
});
