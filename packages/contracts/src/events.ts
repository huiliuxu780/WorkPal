import * as z from "zod";
import { AvatarBodyColorSchema } from "./bot-avatar.js";
import { botSecretDestinationSchema } from "./bot-secrets.js";
import { Id } from "./ids.js";
import { InterventionEventPayloadSchema } from "./intervention.js";
import { McpTransportSchema } from "./mcp.js";
import { OutboundDraftStateSchema } from "./outbound-draft.js";
import {
  PlanReviewContentSchema,
  PlanReviewDecisionSchema,
  PlanReviewSourceSchema,
  PlanReviewStatusSchema,
  RunPlanRevisionSchema,
} from "./run-plans.js";
import { RunStepSnapshotSchema } from "./run-steps.js";
import { RunTodoSnapshotSchema } from "./run-todos.js";

export const ProductEventType = z.enum([
  "thread.message.created",
  "thread.cleared",
  "thread.message.updated",
  "thread.message.reaction",
  "thread.progress",
  "plan.revised",
  "plan.review_submitted",
  "plan.review_decided",
  "step.created",
  "step.queued",
  "step.started",
  "step.completed",
  "step.failed",
  "step.retrying",
  "step.skipped",
  "step.cancelled",
  "step.blocked",
  "todo.created",
  "todo.updated",
  "todo.resolved",
  "todo.deferred",
  "thread.artifact",
  "thread.ask",
  "thread.choice",
  "thread.meta",
  "thread.computer",
  "thread.subagent",
  "thread.turn.routed",
  "thread.turn.handed_off",
  "thread.collaboration.requested",
  "thread.collaboration.result",
  "subagent.started",
  "subagent.progress",
  "subagent.completed",
  "subagent.failed",
  "subagent.cancelled",
  "thread.cloud_agent",
  "thread.call.ended",
  "run.started",
  "run.checkpointed",
  "run.waiting_input",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.retried",
  "run.manual_retry_requested",
  "task.amended",
  "budget.exceeded",
  "delivery.created",
  "delivery.sent",
  "delivery.failed",
  "approval.requested",
  "approval.resolved",
  "intervention.created",
  "intervention.resolved",
  "outbound.draft.updated",
  "computer.status",
  "computer.takeover.requested",
  "computer.takeover.granted",
  "computer.takeover.released",
  "computer.command",
  "memory.revised",
  "routine.created",
  "routine.updated",
  "routine.fired",
  "skill.teaching.started",
  "skill.teaching.stopped",
  "skill.draft.created",
  "skill.saved",
  "effect.recorded",
  "agent.tool.called",
  "agent.tool.completed",
  "effect.reconciled",
  "usage.recorded",
  "bot.spawned",
  "bot.updated",
  "bot.archived",
  "bot.deleted",
  "group.created",
  "group.updated",
  "group.handoff",
  /** Liveness only: never persisted, never applied to a snapshot, always seq 0. */
  "heartbeat",
]);
export type ProductEventType = z.infer<typeof ProductEventType>;

export const TaskAmendmentApplicationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("active_steering"), targetRunId: Id }),
  z.strictObject({ kind: z.literal("queued_update_only"), targetRunId: Id }),
  z.strictObject({
    kind: z.literal("completed_follow_up"),
    targetRunId: Id,
    followUpRunId: Id,
  }),
  z.strictObject({
    kind: z.literal("failed_record_only"),
    targetRunId: Id,
    requiresExplicitRetry: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("cancelled_record_only"),
    targetRunId: Id,
    requiresExplicitRetry: z.literal(true),
  }),
]);
export type TaskAmendmentApplication = z.infer<typeof TaskAmendmentApplicationSchema>;

/** Event.id remains the durable eventId; these fields can be read by older clients. */
export const EventEnvelopeMeta = z.object({
  eventId: Id,
  schemaVersion: z.number().int().positive(),
  causationId: Id.optional(),
  parentRunId: Id.optional(),
});
export type EventEnvelopeMeta = z.infer<typeof EventEnvelopeMeta>;

export const PlanReviewSubmittedPayloadSchema = z
  .object({
    planId: Id,
    runId: Id,
    contentVersion: z.number().int().positive(),
    revision: z.number().int().positive(),
    source: PlanReviewSourceSchema,
    /** Typed plan_review Intervention the reviewer resolves. */
    interventionId: Id,
  })
  .strict();
export type PlanReviewSubmittedPayload = z.infer<typeof PlanReviewSubmittedPayloadSchema>;

export const PlanReviewDecidedPayloadSchema = z
  .object({
    planId: Id,
    runId: Id,
    contentVersion: z.number().int().positive(),
    decision: PlanReviewDecisionSchema,
    reviewStatus: PlanReviewStatusSchema,
    interventionId: Id,
    decidedByUserId: Id.optional(),
    feedback: z.string().max(2000).optional(),
  })
  .strict();
export type PlanReviewDecidedPayload = z.infer<typeof PlanReviewDecidedPayloadSchema>;

export const ProductEventPayloadSchemas = {
  "plan.revised": RunPlanRevisionSchema,
  "plan.review_submitted": PlanReviewSubmittedPayloadSchema,
  "plan.review_decided": PlanReviewDecidedPayloadSchema,
  "step.created": RunStepSnapshotSchema,
  "step.queued": RunStepSnapshotSchema,
  "step.started": RunStepSnapshotSchema,
  "step.completed": RunStepSnapshotSchema,
  "step.failed": RunStepSnapshotSchema,
  "step.retrying": RunStepSnapshotSchema,
  "step.skipped": RunStepSnapshotSchema,
  "step.cancelled": RunStepSnapshotSchema,
  "step.blocked": RunStepSnapshotSchema,
  "todo.created": RunTodoSnapshotSchema,
  "todo.updated": RunTodoSnapshotSchema,
  "todo.resolved": RunTodoSnapshotSchema,
  "todo.deferred": RunTodoSnapshotSchema,
  "run.retried": z.object({ attempt: z.number().int().positive(), reason: z.string() }),
  "run.manual_retry_requested": z.object({
    sourceRunId: Id,
    taskId: Id,
    actorUserId: Id,
  }),
  "task.amended": z
    .object({
      taskId: Id,
      messageId: Id,
      /** Server-assigned amendment sequence within the Task. */
      seq: z.number().int().positive(),
      /** Task aggregate revision after this amendment: seq + 1. */
      revision: z.number().int().positive(),
      actorUserId: Id.optional(),
      source: z.enum(["explicit", "ask_answer", "choice_answer"]),
      /** RT-14 application result. Older RT-13 events legitimately omit it. */
      application: TaskAmendmentApplicationSchema.optional(),
    })
    .strict()
    .refine((payload) => payload.revision === payload.seq + 1, {
      message: "revision must equal the original revision plus this amendment",
      path: ["revision"],
    }),
  "effect.reconciled": z.union([
    z.object({
      executionId: z.string().min(1),
      kind: z.string().min(1),
      sourceEffectId: Id,
      reuse: z.literal("manual_retry"),
    }),
    z.object({
      executionId: z.string().min(1),
      kind: z.string().min(1),
      legacy: z.boolean().optional(),
      sourceEffectId: z.never().optional(),
      reuse: z.never().optional(),
    }),
  ]),
  "budget.exceeded": z.object({ reason: z.string(), limit: z.number().nonnegative().optional() }),
  "delivery.created": z.object({ deliveryId: Id, sourceRunId: Id }),
  "delivery.sent": z.object({ deliveryId: Id, messageId: Id }),
  "delivery.failed": z.object({ deliveryId: Id, reason: z.string() }),
  "approval.requested": z.object({ approvalEffectId: Id }),
  "approval.resolved": z.object({
    approvalEffectId: Id,
    decision: z.enum(["approved", "denied", "expired"]),
    /** Older events lack this field; new decisions record the authorized Run owner. */
    decidedByUserId: Id.optional(),
  }),
  "intervention.created": InterventionEventPayloadSchema,
  "intervention.resolved": InterventionEventPayloadSchema,
  "outbound.draft.updated": z
    .object({
      interventionId: Id,
      state: OutboundDraftStateSchema,
    })
    .strict(),
  // Run↔Artifact membership changes. Safe metadata only; the bytes never
  // ride along. Emitted so an Artifact change moves the Run's snapshot `rev`.
  "thread.artifact": z
    .object({
      artifactId: Id,
      action: z.enum(["attached", "detached"]),
      name: z.string(),
      mimeType: z.string(),
      size: z.number().int().nonnegative().optional(),
    })
    .strict(),
} as const;

const stepStatusByType: Partial<Record<ProductEventType, string>> = {
  "step.created": "pending",
  "step.queued": "queued",
  "step.started": "running",
  "step.completed": "completed",
  "step.failed": "failed",
  "step.retrying": "retrying",
  "step.skipped": "skipped",
  "step.cancelled": "cancelled",
  "step.blocked": "blocked",
};

export function assertProductEventPayload(
  type: ProductEventType,
  payload: Record<string, unknown>,
): void {
  const schema = ProductEventPayloadSchemas[type as keyof typeof ProductEventPayloadSchemas];
  schema?.parse(payload);
  if (stepStatusByType[type] && payload.status !== stepStatusByType[type]) {
    throw new Error(`Step event ${type} has an invalid status`);
  }
}

export const MessageRole = z.enum(["user", "bot", "system"]);
export const BotMessageIntent = z.enum(["request", "result", "question", "status", "fyi"]);
export type BotMessageIntent = z.infer<typeof BotMessageIntent>;

export const MAX_CHART_DATA_ROWS = 5_000;

const ChartSpec = z.record(z.string(), z.any());

function embeddedChartRowCount(spec: Record<string, unknown>): number {
  const specData = Array.isArray(spec.data) ? spec.data.length : 0;
  const markData = Array.isArray(spec.marks)
    ? spec.marks.reduce((total, mark) => {
        if (!mark || typeof mark !== "object" || !Array.isArray(mark.data)) return total;
        return total + mark.data.length;
      }, 0)
    : 0;
  return specData + markData;
}

const ChartBlock = z
  .object({
    kind: z.literal("chart"),
    name: z.string(),
    /** Declarative Observable Plot spec, validated by render_plot before publish.
        z.any keeps the inferred type JSON-assignable for persistence. */
    spec: ChartSpec,
    data: z.array(z.any()).max(MAX_CHART_DATA_ROWS),
  })
  .superRefine((block, ctx) => {
    if (block.data.length + embeddedChartRowCount(block.spec) <= MAX_CHART_DATA_ROWS) return;
    ctx.addIssue({
      code: "custom",
      message: `Chart data exceeds the ${MAX_CHART_DATA_ROWS.toLocaleString("en-US")}-row limit`,
    });
  });

export const SecretAskPurpose = z.enum(["otp", "password", "api_key"]);
export type SecretAskPurpose = z.infer<typeof SecretAskPurpose>;

/**
 * Structured inline identity for a text block. `text` is the plain projection
 * used by history and quotes; `bot_mention` keeps the stable Bot id so a
 * renderer can link to the user's long-term chat without parsing `@name`.
 */
export const MessageInline = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("bot_mention"), botId: Id, label: z.string().min(1).max(200) }),
]);
export type MessageInline = z.infer<typeof MessageInline>;

export const CollaborationReceiptTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("group"), groupId: Id, threadId: Id }),
  z.object({ kind: z.literal("bot"), botId: Id }),
]);
export type CollaborationReceiptTarget = z.infer<typeof CollaborationReceiptTarget>;

export const DestinationLocator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("group_message"), groupId: Id, threadId: Id, messageId: Id }),
  z.object({ kind: z.literal("pair_message"), pairThreadId: Id, messageId: Id }),
]);
export type DestinationLocator = z.infer<typeof DestinationLocator>;

export const CollaborationReceiptBlock = z.object({
  kind: z.literal("collaboration_receipt"),
  target: CollaborationReceiptTarget,
  state: z.enum(["sent", "failed", "completed", "cancelled"]),
  /** Navigation only; the destination renderer authorizes the reader again. */
  destination: DestinationLocator.nullable(),
  /** User-safe labels; internal ids and execution states never belong here. */
  display: z
    .object({
      groupName: z.string().min(1).max(200),
      topic: z.string().min(1).max(200),
    })
    .optional(),
});
export type CollaborationReceiptBlock = z.infer<typeof CollaborationReceiptBlock>;

export const MessageBlock = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    /** Present only on messages written with typed mention identity. */
    inlines: z.array(MessageInline).min(1).optional(),
  }),
  z.object({
    kind: z.literal("card"),
    lines: z.array(z.object({ k: z.string(), v: z.string() })),
  }),
  z.object({
    kind: z.literal("ask"),
    text: z.string(),
    /** Server-minted Intervention id. Absent on asks created before the table existed. */
    interventionId: Id.optional(),
    approvalEffectId: Id.optional(),
    detail: z.string().optional(),
    input: z.enum(["text", "secret"]).optional(),
    /** Why the secret is needed; drives field label on the masked card. */
    purpose: SecretAskPurpose.optional(),
    // Records what the runtime could produce under either deployment mode, so
    // an ask persisted before an owner toggles the private-HTTP flag still
    // validates on replay.
    credential: botSecretDestinationSchema({ allowPrivateHttpOrigin: true }).optional(),
    status: z.enum(["pending", "answered", "expired"]).optional(),
    answer: z.string().optional(),
    actions: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          outcome: z.enum(["created", "cancelled"]).optional(),
        }),
      )
      .optional(),
    /**
     * UX-02 unified plan review: the exact plan version this ask reviews.
     * Present only on plan_review asks; `answer` records the taken action id
     * (approve | request_changes | reject). A plan review is never a tool
     * authorization, so it carries no approvalEffectId.
     */
    planReview: PlanReviewContentSchema.optional(),
  }),
  z.object({
    kind: z.literal("choice"),
    question: z.string(),
    subtitle: z.string().optional(),
    options: z.array(z.object({ id: z.string(), letter: z.string(), label: z.string() })),
    /** Set once the user picks an option; renders the picker as answered. */
    answerId: z.string().optional(),
  }),
  z.object({
    /** Inline app authorization card (Composio-backed): logo, name, one-line
        description, and an Authorize button that flips to connected. */
    kind: z.literal("app_connect"),
    connectorId: z.string().optional(),
    provider: z.string(),
    name: z.string(),
    description: z.string(),
    logo: z.string().nullable(),
    status: z.enum(["pending", "connected"]),
  }),
  z.object({
    kind: z.literal("connect"),
    name: z.string(),
    initial: z.string(),
    color: z.string(),
    status: z.enum(["pending", "connected"]),
  }),
  z.object({
    kind: z.literal("computer"),
    state: z.string(),
    text: z.string(),
  }),
  z.object({
    /** Transcript card left in the thread when the bot hangs up a voice call. */
    kind: z.literal("voice_call"),
    /** Absent when the call had no client nonce to derive an id from. */
    callId: z.string().optional(),
    title: z.string(),
    farewell: z.string(),
  }),
  z.object({ kind: z.literal("meta"), text: z.string() }),
  z.object({
    kind: z.literal("progress"),
    text: z.string(),
    /** Provider-generated tool status rather than assistant-authored narration. */
    activity: z.literal(true).optional(),
    pendingToolNames: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("steps"),
    steps: z.array(z.object({ label: z.string(), count: z.number().int().positive() })),
    durationMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("subagent"),
    agentId: z.string(),
    name: z.string(),
    task: z.string(),
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    progress: z.string().optional(),
    result: z.string().optional(),
  }),
  z.object({
    kind: z.literal("child_bot"),
    botId: z.string(),
    name: z.string(),
    title: z.string().optional(),
    status: z.enum(["created", "archived", "deleted"]),
  }),
  z.object({
    kind: z.literal("avatar_change"),
    changeId: z.string(),
    beforeMode: z.enum(["legacy", "character", "upload"]),
    beforeCharacter: z.enum(["dot", "treble", "wave", "bounce"]).nullable(),
    beforeBodyColor: AvatarBodyColorSchema.optional(),
    afterMode: z.enum(["character", "upload"]),
    afterCharacter: z.enum(["dot", "treble", "wave", "bounce"]).nullable(),
    afterBodyColor: AvatarBodyColorSchema.optional(),
  }),
  z.object({
    /** Compact card for a remote cloud coding agent (not the bot computer). */
    kind: z.literal("cloud_agent"),
    agentId: z.string(),
    title: z.string(),
    status: z.enum(["running", "finished", "failed", "cancelled"]),
    url: z.string(),
    branch: z.string().optional(),
    prUrl: z.string().optional(),
    latestRunId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("skill_draft"),
    skillId: Id,
    name: z.string(),
    goal: z.string(),
    playbook: z.object({
      whenToUse: z.string(),
      inputs: z.array(z.string()),
      steps: z.array(z.string()),
      howToCheck: z.string(),
      whatToReturn: z.string(),
      approvalBoundaries: z.string(),
      failureHandling: z.string(),
    }),
    status: z.enum(["draft", "saved", "discarded"]),
  }),
  ChartBlock,
  z.object({
    /** Approval card for an agent-created MCP server. The user completes the
        OAuth popup (or confirms no authorization is needed) in the UI. The
        status persists so the card renders its decision after a remount. */
    kind: z.literal("mcp_approval"),
    name: z.string(),
    serverId: Id,
    transport: McpTransportSchema,
    endpoint: z.string().nullable(),
    needsOAuth: z.boolean(),
    status: z.enum(["pending", "connected", "dismissed"]).default("pending"),
  }),
  z.object({
    kind: z.literal("image"),
    artifactId: Id,
    mimeType: z.string(),
    name: z.string(),
  }),
  z.object({
    kind: z.literal("file"),
    artifactId: Id,
    mimeType: z.string(),
    name: z.string(),
    size: z.number().int().nonnegative(),
    /**
     * Stable deliverable family id (the first version's own artifact id).
     * Missing on rows written before CHAT-CHROME-01; the API backfills it on
     * the read boundary from the artifact row.
     */
    rootArtifactId: Id.optional(),
    /** The concrete published version this message carries. */
    version: z.number().int().positive().optional(),
    /** Latest version already published with a message in the same family. */
    latestVersion: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("handoff"),
    fromBotId: Id,
    toBotId: Id,
    text: z.string(),
    /** Links ownership transfers in one user-started group turn. */
    hop: z.number().int().positive().optional(),
  }),
  CollaborationReceiptBlock,
  z.object({
    /** A group-chat message delivered into a member bot's own thread. */
    kind: z.literal("channel_message"),
    provider: z.string(),
    /** Per-message network when a provider spans multiple transports. */
    transport: z.string().optional(),
    channelId: Id,
    fromAddress: z.string(),
    fromLabel: z.string(),
    text: z.string(),
    hop: z.number().int().nonnegative().optional(),
  }),
  z.object({
    /** Shown in the sending bot's own chat, so the user can see what it sent. */
    kind: z.literal("bot_message_sent"),
    toBotId: Id,
    toBotName: z.string(),
    text: z.string(),
    intent: BotMessageIntent.optional(),
  }),
  z.object({
    /** Delivered into the receiving bot's own chat as the prompt that woke it. */
    kind: z.literal("bot_message_received"),
    fromBotId: Id,
    fromBotName: z.string(),
    text: z.string(),
    intent: BotMessageIntent.optional(),
    /** Sender-thread echo this delivery answers, when applicable. */
    returnToMessageId: Id.optional(),
    /** Links in a bot-started chain; absent when a person started it. */
    hop: z.number().int().nonnegative().optional(),
  }),
  z.object({
    /**
     * X-GROUP-FAIL: the cross-group request stopped before any work started
     * because the requesting user may not manage the target group's members.
     * A server-written fact, never a model-authored card: the no-permission
     * branch must stay distinct from a tool approval and from generic failures.
     */
    kind: z.literal("group_membership_failure"),
    groupId: Id,
    groupName: z.string().min(1).max(200),
    botId: Id,
    reason: z.literal("member_permission"),
  }),
]);
export type MessageBlock = z.infer<typeof MessageBlock>;

/**
 * Something the bot did on its computer, shown in the terminal's Activity view: a shell
 * command (with a redacted output tail) or a file/app action, whose `command` is the path or
 * app name.
 */
export const COMPUTER_COMMAND_OUTPUT_MAX_CHARS = 16_000;
export const ComputerCommandKind = z.enum([
  "shell",
  "write_file",
  "attach_file",
  "open_path",
  "launch_app",
]);
export type ComputerCommandKind = z.infer<typeof ComputerCommandKind>;
export const ComputerCommandSchema = z.object({
  executionId: z.string(),
  kind: ComputerCommandKind,
  command: z.string(),
  cwd: z.string(),
  status: z.enum(["running", "done"]),
  exitCode: z.number().int().nullable(),
  output: z.string(),
  /** Size written by write_file. */
  bytes: z.number().int().nonnegative().optional(),
});
export type ComputerCommand = z.infer<typeof ComputerCommandSchema>;

/**
 * Collapse running/done events into one entry per command, in start order. A finished
 * command stays finished, so history and live events can be merged in either order.
 */
export function foldComputerCommands<T extends ComputerCommand>(events: T[]): T[] {
  const byId = new Map<string, T>();
  for (const event of events) {
    if (byId.get(event.executionId)?.status === "done" && event.status === "running") continue;
    byId.set(event.executionId, event);
  }
  return [...byId.values()];
}

export const ProductEventSchema = z.object({
  id: Id,
  /** Alias of id in v2; absent on legacy event JSON. */
  eventId: Id.optional(),
  schemaVersion: z.number().int().positive().optional(),
  causationId: Id.optional(),
  parentRunId: Id.optional(),
  spaceId: Id,
  threadId: Id,
  botId: Id,
  seq: z.number().int().nonnegative(),
  type: ProductEventType,
  runId: Id.optional(),
  createdAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type ProductEvent = z.infer<typeof ProductEventSchema>;

export const ThreadMessageSchema = z.object({
  id: Id,
  threadId: Id,
  seq: z.number().int().nonnegative(),
  role: MessageRole,
  blocks: z.array(MessageBlock),
  botId: Id.optional(),
  replyToMessageId: Id.optional(),
  replyQuote: z.string().optional(),
  runId: Id.optional(),
  /** Set when the message was sent from a live voice call; groups one call's transcript. */
  callId: z.string().optional(),
  createdAt: z.string(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

export function canReactToThreadMessage(message: Pick<ThreadMessage, "id" | "blocks">): boolean {
  return (
    !message.id.startsWith("progress:") &&
    !message.id.startsWith("subagent:") &&
    !message.blocks.some((block) => block.kind === "channel_message")
  );
}
