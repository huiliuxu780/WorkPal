import * as z from "zod";
import { Id } from "./ids.js";
import {
  InterventionDecisionSchema,
  InterventionPresentationSchema,
  InterventionStatusSchema,
  type InterventionView,
} from "./intervention.js";
import { McpTransportSchema } from "./mcp.js";
import { PlanReviewContentSchema, PlanReviewDecisionSchema } from "./run-plans.js";

/**
 * CARD-01 target projection. There is deliberately no generic `action` object:
 * every InteractionView member carries its own strict payload, and TypeScript
 * plus Zod exhaustiveness must point at every unhandled member when one is
 * added.
 *
 * These schemas are read models. They never carry an answer body, a secret, an
 * address, payment instructions, or ExternalEffect request/result payloads.
 */

export const InteractionViewKindSchema = z.enum([
  "input_request",
  "action_approval",
  "plan_review",
  "session_control",
]);
export type InteractionViewKind = z.infer<typeof InteractionViewKindSchema>;

/**
 * Addressable source of an Interaction. `messageId` is null only for
 * SessionControlView, which is derived from a Run and has no durable message.
 */
export const InteractionSourceSchema = z.strictObject({
  spaceId: Id,
  threadId: Id,
  messageId: Id.nullable(),
  runId: Id.nullable(),
  botId: Id.nullable(),
});
export type InteractionSource = z.infer<typeof InteractionSourceSchema>;

const interactionBaseShape = {
  interactionId: Id,
  revision: z.number().int().positive(),
  status: InterventionStatusSchema,
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  /** Trusted timestamp used by the attention queue; never invented from text. */
  attentionAt: z.string(),
  source: InteractionSourceSchema,
  presentation: InterventionPresentationSchema,
};

const InputRequestOptionSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1).max(200),
});

export const InputRequestPayloadSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("question"),
    prompt: z.string().max(4_000),
    placeholder: z.string().max(200).nullable(),
  }),
  z.strictObject({
    mode: z.literal("choice"),
    prompt: z.string().max(4_000),
    options: z.array(InputRequestOptionSchema).min(1).max(20),
  }),
  z.strictObject({
    mode: z.literal("form"),
    prompt: z.string().max(4_000),
    fields: z
      .array(
        z.strictObject({
          id: z.string().min(1),
          label: z.string().min(1).max(200),
          required: z.boolean(),
          secret: z.boolean(),
        }),
      )
      .min(1)
      .max(50),
  }),
  z.strictObject({
    mode: z.literal("secret"),
    prompt: z.string().max(4_000),
    purpose: z.enum(["otp", "password", "api_key"]).nullable(),
    credential: z
      .strictObject({
        name: z.string().min(1).max(64),
        origin: z.string().min(1).max(2_048),
        authType: z.enum(["bearer", "header", "basic", "login"]),
      })
      .nullable(),
  }),
  z.strictObject({
    mode: z.literal("saved_item"),
    prompt: z.string().max(4_000),
    itemKind: z.enum(["card", "address"]),
    items: z
      .array(
        z.strictObject({
          id: z.string().min(1),
          label: z.string().min(1).max(200),
          /** Masked display value only: last four digits or a redacted label. */
          display: z.string().min(1).max(120),
        }),
      )
      .min(1)
      .max(20),
  }),
]);
export type InputRequestPayload = z.infer<typeof InputRequestPayloadSchema>;

export const InputRequestViewSchema = z.strictObject({
  kind: z.literal("input_request"),
  ...interactionBaseShape,
  input: InputRequestPayloadSchema,
});
export type InputRequestView = z.infer<typeof InputRequestViewSchema>;

const ApprovalActionSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1).max(200),
});

/** Display-safe TaughtSkill playbook; the authoritative save is a business transaction. */
export const CardSkillPlaybookSchema = z.strictObject({
  whenToUse: z.string(),
  inputs: z.array(z.string()),
  steps: z.array(z.string()),
  howToCheck: z.string(),
  whatToReturn: z.string(),
  approvalBoundaries: z.string(),
  failureHandling: z.string(),
});

/**
 * Action approval payloads. The nine frozen kinds stay independent: a caller
 * cannot turn a connector assignment or a skill save into `requestApproval(tool)`.
 */
export const ActionApprovalPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("tool"),
    authority: z.literal("external_effect"),
    effectId: Id,
    effectStatus: z.string().min(1),
    actions: z.array(ApprovalActionSchema).max(10),
  }),
  z.strictObject({
    kind: z.literal("payment"),
    authority: z.literal("external_effect"),
    effectId: Id,
    effectStatus: z.string().min(1),
    amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    merchant: z.string().min(1).max(200),
    /** Display-only fragment; never a full card number. */
    cardLast4: z.string().regex(/^\d{4}$/),
  }),
  z.strictObject({
    kind: z.literal("outbound"),
    authority: z.literal("external_effect"),
    effectId: Id,
    effectStatus: z.string().min(1),
    channel: z.enum(["email", "message", "post"]),
    recipientCount: z.number().int().nonnegative(),
    subject: z.string().max(200).nullable(),
    /** Binds the decision to the exact content revision that was confirmed. */
    fingerprint: z.string().min(8).max(128),
  }),
  z.strictObject({
    kind: z.literal("routine"),
    authority: z.literal("business_transaction"),
    routineId: Id,
    action: z.enum(["pause", "resume", "update", "delete"]),
    cron: z.string().max(500).nullable(),
    timezone: z.string().max(100).nullable(),
  }),
  z.strictObject({
    kind: z.literal("install"),
    authority: z.literal("business_transaction"),
    capabilityKind: z.enum(["skill", "plugin", "mcp", "api", "graphql", "connection"]),
    name: z.string().min(1).max(200),
    source: z.string().min(1).max(500),
    version: z.string().max(100).nullable(),
  }),
  z.strictObject({
    kind: z.literal("skill_save"),
    authority: z.literal("business_transaction"),
    skillId: Id,
    // The existing draft editor and TaughtSkill.name allow empty/unbounded
    // names; rejecting them here would drop the whole draft interaction.
    name: z.string(),
    // Matches skills.start's existing goal limit; a stricter card schema would
    // silently drop a valid draft from the Interaction projection.
    goal: z.string().max(4_000),
    contentRevision: z.number().int().positive(),
    playbook: CardSkillPlaybookSchema,
  }),
  z.strictObject({
    kind: z.literal("connect.app_authorization"),
    authority: z.literal("business_transaction"),
    connectorId: Id.nullable(),
    provider: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    description: z.string().max(2_000).nullable(),
  }),
  z.strictObject({
    kind: z.literal("connect.mcp_assignment"),
    authority: z.literal("business_transaction"),
    serverId: Id,
    name: z.string().min(1).max(200),
    transport: McpTransportSchema,
    endpoint: z.string().max(2_048).nullable(),
    needsOAuth: z.boolean(),
    /**
     * The current assignment writes allowAllTools: true. The projection must
     * carry that risk scope explicitly; the card cannot say "authorize the
     * connection" without showing that every tool is allowed.
     */
    allowAllTools: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("group_membership"),
    authority: z.literal("business_transaction"),
    action: z.literal("add_bot_to_group"),
    groupId: Id,
    botId: Id,
    /** Stable message_group request identity; never a tool name or args blob. */
    messageGroupRequestId: Id,
    requestRevision: z.number().int().positive(),
    sourceThreadId: Id,
    sourceMessageId: Id,
    presentation: InterventionPresentationSchema,
  }),
]);
export type ActionApprovalPayload = z.infer<typeof ActionApprovalPayloadSchema>;

export const ActionApprovalViewSchema = z
  .strictObject({
    kind: z.literal("action_approval"),
    ...interactionBaseShape,
    decision: InterventionDecisionSchema.nullable(),
    approval: ActionApprovalPayloadSchema,
  })
  .superRefine((view, ctx) => {
    if (view.approval.kind !== "group_membership") return;
    if (
      view.approval.sourceThreadId !== view.source.threadId ||
      view.approval.sourceMessageId !== view.source.messageId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["approval", "sourceThreadId"],
        message: "Group membership source must match the Interaction source",
      });
    }
    if (JSON.stringify(view.approval.presentation) !== JSON.stringify(view.presentation)) {
      ctx.addIssue({
        code: "custom",
        path: ["approval", "presentation"],
        message: "Group membership presentation must match the Interaction presentation",
      });
    }
  });
export type ActionApprovalView = z.infer<typeof ActionApprovalViewSchema>;

export const PlanReviewViewSchema = z.strictObject({
  kind: z.literal("plan_review"),
  ...interactionBaseShape,
  /** Exact plan version under review. Never an ExternalEffect binding. */
  plan: PlanReviewContentSchema,
  decision: PlanReviewDecisionSchema.nullable(),
  feedback: z.string().max(2_000).nullable(),
});
export type PlanReviewView = z.infer<typeof PlanReviewViewSchema>;

export const SessionControlActionSchema = z.enum(["takeover", "return"]);
export type SessionControlAction = z.infer<typeof SessionControlActionSchema>;

export const SessionControlViewSchema = z.strictObject({
  kind: z.literal("session_control"),
  interactionId: Id,
  revision: z.number().int().positive(),
  /** Derived from current Run/lease facts, so only a live request is projected. */
  status: z.literal("pending"),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  attentionAt: z.string(),
  source: InteractionSourceSchema,
  presentation: InterventionPresentationSchema,
  action: SessionControlActionSchema,
  runId: Id,
  botId: Id,
  computerId: Id.nullable(),
  /** Execution lease held by the bot for this Run, if any. */
  executionLeaseActive: z.boolean(),
  controlLeaseExpiresAt: z.string().nullable(),
});
export type SessionControlView = z.infer<typeof SessionControlViewSchema>;

export const InteractionViewSchema = z.discriminatedUnion("kind", [
  InputRequestViewSchema,
  ActionApprovalViewSchema,
  PlanReviewViewSchema,
  SessionControlViewSchema,
]);
export type InteractionView = z.infer<typeof InteractionViewSchema>;

/** Server-projected capability. The Web never reads the deployment env var. */
export const InteractionCapabilitiesSchema = z.strictObject({
  cardsUnifiedV2: z.literal(true),
});
export type InteractionCapabilities = z.infer<typeof InteractionCapabilitiesSchema>;

export const DISPLAY_BLOCK_KINDS = [
  "markdown",
  "table",
  "chart",
  "collection",
  "media",
  "html",
  "task_status",
  "page",
  "voice",
] as const;
export const DisplayBlockKindSchema = z.enum(DISPLAY_BLOCK_KINDS);
export type DisplayBlockKind = z.infer<typeof DisplayBlockKindSchema>;

export const TaskStatusValueSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
export type TaskStatusValue = z.infer<typeof TaskStatusValueSchema>;

/**
 * Display-only projection. `task_status` is a display member, never a pending
 * Interaction and never an attention source. `blockId` is stable so a client
 * can key a block across refreshes.
 */
export const DisplayBlockSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("markdown"),
    blockId: Id,
    text: z.string(),
  }),
  z.strictObject({
    kind: z.literal("table"),
    blockId: Id,
    columns: z.array(InputRequestOptionSchema).min(1),
    rows: z.array(z.array(z.string())).max(10_000),
  }),
  z.strictObject({
    kind: z.literal("chart"),
    blockId: Id,
    name: z.string(),
    spec: z.unknown(),
    data: z.array(z.unknown()),
  }),
  z.strictObject({
    kind: z.literal("collection"),
    blockId: Id,
    title: z.string().max(200).nullable(),
    items: z
      .array(
        z.strictObject({
          id: z.string().min(1),
          label: z.string().min(1).max(200),
          value: z.string().max(2_000),
          detail: z.string().max(2_000).nullable(),
        }),
      )
      .max(200),
  }),
  z.strictObject({
    kind: z.literal("media"),
    blockId: Id,
    mediaKind: z.enum(["image", "file"]),
    artifactId: Id,
    name: z.string().min(1).max(500),
    mimeType: z.string().min(1).max(200),
    size: z.number().int().nonnegative().nullable(),
  }),
  z.strictObject({
    kind: z.literal("html"),
    blockId: Id,
    artifactId: Id,
    title: z.string().max(500).nullable(),
    sandboxed: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("task_status"),
    blockId: Id,
    status: TaskStatusValueSchema,
    title: z.string().min(1).max(500),
    summary: z.string().max(2_000).nullable(),
    source: z.strictObject({
      threadId: Id,
      messageId: Id,
      runId: Id.nullable(),
    }),
  }),
  z.strictObject({
    kind: z.literal("page"),
    blockId: Id,
    pageId: Id,
    title: z.string().min(1).max(500),
    available: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("voice"),
    blockId: Id,
    artifactId: Id.nullable(),
    durationMs: z.number().int().nonnegative(),
    transcript: z.string().max(20_000).nullable(),
  }),
]);
export type DisplayBlock = z.infer<typeof DisplayBlockSchema>;

/** Pending cards sort before terminal history. */
const PENDING_KIND_RANK: Record<Exclude<InteractionViewKind, "session_control">, number> = {
  plan_review: 0,
  action_approval: 1,
  input_request: 2,
};

export type SortableInteractionView = Exclude<InteractionView, { kind: "session_control" }>;

/**
 * Frozen interaction-region ordering:
 * pending before terminal; pending by PlanReviewView → ActionApprovalView →
 * InputRequestView; both groups then createdAt ASC → stableId ASC.
 * SessionControlView has a dedicated entry and must not use this comparator.
 */
export function compareInteractionViewsForDisplay(
  left: InteractionView,
  right: InteractionView,
): number {
  if (left.kind === "session_control" || right.kind === "session_control") {
    throw new Error("SessionControlView has a dedicated entry and is not sorted with cards");
  }
  const leftPending = left.status === "pending";
  const rightPending = right.status === "pending";
  if (leftPending !== rightPending) return leftPending ? -1 : 1;
  if (leftPending) {
    const rank =
      PENDING_KIND_RANK[left.kind as keyof typeof PENDING_KIND_RANK] -
      PENDING_KIND_RANK[right.kind as keyof typeof PENDING_KIND_RANK];
    if (rank !== 0) return rank;
  }
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.interactionId === right.interactionId) return 0;
  return left.interactionId < right.interactionId ? -1 : 1;
}

export const AttentionItemSchema = z.strictObject({
  stableId: Id,
  interactionId: Id,
  revision: z.number().int().positive(),
  kind: InteractionViewKindSchema,
  status: z.literal("pending"),
  attentionAt: z.string(),
  expiresAt: z.string().nullable(),
  source: InteractionSourceSchema,
  presentation: InterventionPresentationSchema,
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

/** Dedupe key frozen by CARD-01: interactionId + revision. */
export function attentionDedupeKey(item: Pick<AttentionItem, "interactionId" | "revision">) {
  return `${item.interactionId}\u0000${item.revision}`;
}

/** expiresAt ASC NULLS LAST → attentionAt ASC → stableId ASC. */
export function compareAttentionItems(left: AttentionItem, right: AttentionItem): number {
  if (left.expiresAt !== right.expiresAt) {
    if (left.expiresAt === null) return 1;
    if (right.expiresAt === null) return -1;
    return left.expiresAt < right.expiresAt ? -1 : 1;
  }
  if (left.attentionAt !== right.attentionAt) {
    return left.attentionAt < right.attentionAt ? -1 : 1;
  }
  if (left.stableId === right.stableId) return 0;
  return left.stableId < right.stableId ? -1 : 1;
}

/**
 * Attention DTO projection only. CARD-01A does not expose a query RPC, paging
 * or a Web queue; CARD-01D owns those.
 *
 * Sources are already-restricted InteractionViews: durable Interventions,
 * current valid SessionControls, and strictly mapped business approvals.
 * Plain Runs, Run history, background work, collaboration receipts, private
 * pair receipts, task_status and PD-01 Retry never appear here because they are
 * not InteractionViews in the first place.
 */
export function projectAttentionItems(
  views: readonly InteractionView[],
  options: { excludeInteractionIds?: ReadonlySet<string> } = {},
): AttentionItem[] {
  const seen = new Set<string>();
  const items: AttentionItem[] = [];
  for (const view of views) {
    if (view.status !== "pending") continue;
    if (options.excludeInteractionIds?.has(view.interactionId)) continue;
    const item: AttentionItem = {
      stableId: view.interactionId,
      interactionId: view.interactionId,
      revision: view.revision,
      kind: view.kind,
      status: "pending",
      attentionAt: view.attentionAt,
      expiresAt: view.expiresAt,
      source: view.source,
      presentation: view.presentation,
    };
    const key = attentionDedupeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items.sort(compareAttentionItems);
}

function approvalDecision(view: InterventionView): "approved" | "denied" | null {
  return view.approval?.decision ?? null;
}

/**
 * Project one durable InterventionView onto the strict CARD-01 family.
 * Returns null for malformed or unimplemented combinations instead of guessing
 * a type from optional fields.
 */
export function interactionViewFromIntervention(view: InterventionView): InteractionView | null {
  const source: InteractionSource = {
    spaceId: view.spaceId,
    threadId: view.threadId,
    messageId: view.messageId,
    runId: view.runId,
    botId: view.botId,
  };
  const base = {
    interactionId: view.id,
    revision: view.revision,
    status: view.status,
    createdAt: view.createdAt,
    expiresAt: view.expiresAt ?? null,
    attentionAt: view.createdAt,
    source,
    presentation: view.presentation ?? { text: "" },
  };

  if (view.kind === "plan_review") {
    if (!view.planReview) return null;
    const parsed = PlanReviewViewSchema.safeParse({
      kind: "plan_review",
      ...base,
      plan: view.planReview.content,
      decision: view.planReview.decision ?? null,
      feedback: view.planReview.feedback ?? null,
    });
    return parsed.success ? parsed.data : null;
  }

  if (view.kind === "approval" && view.approval) {
    const parsed = ActionApprovalViewSchema.safeParse({
      kind: "action_approval",
      ...base,
      decision: approvalDecision(view),
      approval: {
        kind: "tool",
        authority: "external_effect",
        effectId: view.approval.effectId,
        effectStatus: view.approval.effectStatus,
        actions: view.approval.actions ?? [],
      },
    });
    return parsed.success ? parsed.data : null;
  }

  if (view.kind === "input" && view.input) {
    const input = inputPayloadFromIntervention(view);
    if (!input) return null;
    const parsed = InputRequestViewSchema.safeParse({
      kind: "input_request",
      ...base,
      input,
    });
    return parsed.success ? parsed.data : null;
  }

  return null;
}

function inputPayloadFromIntervention(view: InterventionView): InputRequestPayload | null {
  const prompt = view.presentation?.text ?? "";
  const input = view.input;
  if (!input) {
    return { mode: "question", prompt, placeholder: null };
  }
  if (input.mode === "secret") {
    return {
      mode: "secret",
      prompt,
      purpose: input.purpose ?? null,
      credential: view.presentation?.credential ?? null,
    };
  }
  if (input.mode === "choice") {
    const options = input.actions?.map((action) => ({ id: action.id, label: action.label })) ?? [];
    if (options.length === 0) return null;
    return { mode: "choice", prompt, options };
  }
  return { mode: "question", prompt, placeholder: null };
}

export interface SessionControlRunFact {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  status: string;
  waitKind?: string | null;
  createdAt: Date | string;
  waitStartedAt?: Date | string | null;
  executionLeaseActive: boolean;
}

export interface SessionControlComputerFact {
  id: string;
  controlHolder: string;
  controlBotId: string | null;
  controlRunId: string | null;
  controlLeaseId: string | null;
  controlLeaseExpiresAt: Date | string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Derive current SessionControlViews from Run status, the execution lease, and
 * the Computer's user control lease. A historical `computer` message block is
 * never an input: only current facts can grant a takeover or hand-back action.
 *
 * - takeover requires Run status waiting_takeover.
 * - return requires Computer.controlRunId === run.id, a live user control
 *   lease for the same Bot, and no active bot execution lease.
 */
export function deriveSessionControlViews(input: {
  runs: readonly SessionControlRunFact[];
  computer: SessionControlComputerFact | null;
  now?: Date;
}): SessionControlView[] {
  const now = input.now ?? new Date();
  const computer = input.computer;
  const controlLeaseExpiresAt = computer?.controlLeaseExpiresAt
    ? new Date(computer.controlLeaseExpiresAt)
    : null;
  const userLeaseActive = Boolean(
    computer &&
      computer.controlHolder === "user" &&
      computer.controlLeaseId &&
      controlLeaseExpiresAt &&
      controlLeaseExpiresAt.getTime() > now.getTime(),
  );
  const views: SessionControlView[] = [];
  for (const run of input.runs) {
    const createdAt = iso(run.waitStartedAt ?? run.createdAt);
    // A live user takeover bound to this Run is the current action; it must
    // win over the original waiting_takeover request, otherwise the card would
    // keep asking the user to take control they already hold.
    const returnEligible = Boolean(
      computer &&
        userLeaseActive &&
        !run.executionLeaseActive &&
        computer.controlBotId === run.botId &&
        computer.controlRunId === run.id,
    );
    if (returnEligible && computer) {
      const parsed = SessionControlViewSchema.safeParse({
        kind: "session_control",
        interactionId: `session_control:return:${run.id}`,
        revision: 1,
        status: "pending",
        createdAt,
        expiresAt: controlLeaseExpiresAt ? controlLeaseExpiresAt.toISOString() : null,
        attentionAt: createdAt,
        source: {
          spaceId: run.spaceId,
          threadId: run.threadId,
          messageId: null,
          runId: run.id,
          botId: run.botId,
        },
        presentation: { text: "return" },
        action: "return",
        runId: run.id,
        botId: run.botId,
        computerId: computer.id,
        executionLeaseActive: false,
        controlLeaseExpiresAt: controlLeaseExpiresAt ? controlLeaseExpiresAt.toISOString() : null,
      });
      if (parsed.success) views.push(parsed.data);
      continue;
    }
    if (run.status !== "waiting_takeover") continue;
    const parsed = SessionControlViewSchema.safeParse({
      kind: "session_control",
      interactionId: `session_control:takeover:${run.id}`,
      revision: 1,
      status: "pending",
      createdAt,
      expiresAt: null,
      attentionAt: createdAt,
      source: {
        spaceId: run.spaceId,
        threadId: run.threadId,
        messageId: null,
        runId: run.id,
        botId: run.botId,
      },
      presentation: { text: "takeover" },
      action: "takeover",
      runId: run.id,
      botId: run.botId,
      computerId: computer?.id ?? null,
      executionLeaseActive: run.executionLeaseActive,
      controlLeaseExpiresAt: null,
    });
    if (parsed.success) views.push(parsed.data);
  }
  return views;
}

export interface GroupMembershipApprovalFacts {
  interactionId: string;
  revision: number;
  groupId: string;
  botId: string;
  messageGroupRequestId: string;
  requestRevision: number;
  sourceSpaceId: string;
  sourceThreadId: string;
  sourceMessageId: string;
  sourceRunId: string | null;
  sourceBotId: string | null;
  createdAt: string;
  attentionAt?: string;
  expiresAt: string | null;
  presentation: z.infer<typeof InterventionPresentationSchema>;
  canManageMembers: boolean;
}

/**
 * Strict group membership approval projection. A user without member
 * management permission gets no ActionApprovalView at all; the existing
 * X-GROUP-FAIL fact owns that path. Approval only authorizes adding this Bot to
 * this standard group for the bound message_group request.
 */
export function projectGroupMembershipApproval(
  facts: GroupMembershipApprovalFacts,
): ActionApprovalView | null {
  if (!facts.canManageMembers) return null;
  const parsed = ActionApprovalViewSchema.safeParse({
    kind: "action_approval",
    interactionId: facts.interactionId,
    revision: facts.revision,
    status: "pending",
    createdAt: facts.createdAt,
    expiresAt: facts.expiresAt,
    attentionAt: facts.attentionAt ?? facts.createdAt,
    source: {
      spaceId: facts.sourceSpaceId,
      threadId: facts.sourceThreadId,
      messageId: facts.sourceMessageId,
      runId: facts.sourceRunId,
      botId: facts.sourceBotId,
    },
    presentation: facts.presentation,
    decision: null,
    approval: {
      kind: "group_membership",
      authority: "business_transaction",
      action: "add_bot_to_group",
      groupId: facts.groupId,
      botId: facts.botId,
      messageGroupRequestId: facts.messageGroupRequestId,
      requestRevision: facts.requestRevision,
      sourceThreadId: facts.sourceThreadId,
      sourceMessageId: facts.sourceMessageId,
      presentation: facts.presentation,
    },
  });
  return parsed.success ? parsed.data : null;
}
