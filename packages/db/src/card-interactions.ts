import {
  type ActionApprovalView,
  ActionApprovalViewSchema,
  type AttentionItem,
  type DisplayBlock,
  DisplayBlockSchema,
  deriveSessionControlViews,
  type GroupMembershipApprovalFacts,
  type InteractionView,
  type InterventionView,
  interactionViewFromIntervention,
  legacyInterventionId,
  type MessageBlock,
  PlanReviewViewSchema,
  presentationFromAskBlock,
  projectAttentionItems,
  projectGroupMembershipApproval,
  type SessionControlComputerFact,
  type SessionControlRunFact,
  type SessionControlView,
  type ThreadMessage,
} from "@rakazo/contracts";

export interface CardMessageFact {
  id: string;
  threadId: string;
  spaceId: string;
  botId: string | null;
  runId: string | null;
  createdAt: string;
  blocks: MessageBlock[];
}

export function cardMessageFact(
  message: Pick<ThreadMessage, "id" | "threadId" | "botId" | "runId" | "createdAt" | "blocks">,
  spaceId: string,
): CardMessageFact {
  return {
    id: message.id,
    threadId: message.threadId,
    spaceId,
    botId: message.botId ?? null,
    runId: message.runId ?? null,
    createdAt: message.createdAt,
    blocks: message.blocks,
  };
}

export type CardRunFact = SessionControlRunFact;
export type CardComputerFact = SessionControlComputerFact;

export interface ThreadCardSurface {
  interactions: InteractionView[];
  displayBlocks: DisplayBlock[];
  attention: AttentionItem[];
}

export interface ThreadCardSurfaceInput {
  spaceId: string;
  threadId: string;
  messages: readonly CardMessageFact[];
  /** Durable Interventions already projected by loadInterventionViews. */
  interventions: readonly InterventionView[];
  /** Current Runs that may carry a takeover/return control. */
  runs: readonly CardRunFact[];
  /** Current Computer row; history `computer` blocks are never consulted. */
  computer: CardComputerFact | null;
  /**
   * Business facts for group_membership. RT-12 owns persistence; CARD-01A only
   * defines and tests the strict projection.
   */
  groupMembershipApprovals?: readonly GroupMembershipApprovalFacts[];
  now?: Date;
}

export function legacyBlockInteractionId(
  messageId: string,
  block: "app_connect" | "mcp_approval" | "skill_draft",
): string {
  return `legacy_block:${block}:${messageId}`;
}

function messageSource(message: CardMessageFact) {
  return {
    spaceId: message.spaceId,
    threadId: message.threadId,
    messageId: message.id,
    runId: message.runId,
    botId: message.botId,
  };
}

function terminalDecision(status: string): "approved" | "denied" | null {
  if (status === "answered" || status === "completed") return "approved";
  if (status === "cancelled") return "denied";
  return null;
}

function approvalViewFromBlock(
  message: CardMessageFact,
  block: Extract<MessageBlock, { kind: "app_connect" | "mcp_approval" | "skill_draft" }>,
): ActionApprovalView | null {
  const status: InteractionView["status"] =
    block.kind === "app_connect"
      ? block.status === "pending"
        ? "pending"
        : "answered"
      : block.kind === "mcp_approval"
        ? block.status === "pending"
          ? "pending"
          : block.status === "connected"
            ? "answered"
            : "cancelled"
        : block.status === "draft"
          ? "pending"
          : "answered";
  const interactionId = legacyBlockInteractionId(message.id, block.kind);
  const presentation =
    block.kind === "app_connect"
      ? { text: block.name, detail: block.description }
      : block.kind === "mcp_approval"
        ? {
            text: block.name,
            detail: "allowAllTools: true",
          }
        : { text: block.name, detail: block.goal };
  const approval =
    block.kind === "app_connect"
      ? {
          kind: "connect.app_authorization" as const,
          authority: "business_transaction" as const,
          connectorId: block.connectorId ?? null,
          provider: block.provider,
          name: block.name,
          description: block.description,
        }
      : block.kind === "mcp_approval"
        ? {
            kind: "connect.mcp_assignment" as const,
            authority: "business_transaction" as const,
            serverId: block.serverId,
            name: block.name,
            transport: block.transport,
            endpoint: block.endpoint,
            needsOAuth: block.needsOAuth,
            allowAllTools: true as const,
          }
        : {
            kind: "skill_save" as const,
            authority: "business_transaction" as const,
            skillId: block.skillId,
            name: block.name,
            goal: block.goal,
            contentRevision: 1,
            playbook: block.playbook,
          };
  const parsed = ActionApprovalViewSchema.safeParse({
    kind: "action_approval",
    interactionId,
    revision: 1,
    status,
    createdAt: message.createdAt,
    expiresAt: null,
    attentionAt: message.createdAt,
    source: messageSource(message),
    presentation,
    decision: terminalDecision(status),
    approval,
  });
  return parsed.success ? parsed.data : null;
}

function planReviewViewFromAsk(
  message: CardMessageFact,
  ask: Extract<MessageBlock, { kind: "ask" }>,
): InteractionView | null {
  if (!ask.planReview || ask.status !== "pending") return null;
  const parsed = PlanReviewViewSchema.safeParse({
    kind: "plan_review",
    interactionId: ask.interventionId ?? legacyInterventionId(message.id),
    revision: 1,
    status: "pending",
    createdAt: message.createdAt,
    expiresAt: null,
    attentionAt: message.createdAt,
    source: messageSource(message),
    presentation: presentationFromAskBlock(ask),
    plan: ask.planReview,
    decision: null,
    feedback: null,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Project the bounded message page into the strict CARD-01 family. Legacy
 * `card`, `connect`, `computer`, receipt and plain display blocks are not
 * recovered here: the old MessageBlock remains the read-only replay path.
 */
export function interactionViewsFromMessages(messages: readonly CardMessageFact[]): {
  interactions: InteractionView[];
  displayBlocks: DisplayBlock[];
} {
  const interactions: InteractionView[] = [];
  const displayBlocks: DisplayBlock[] = [];
  for (const message of messages) {
    message.blocks.forEach((block, index) => {
      if (
        block.kind === "app_connect" ||
        block.kind === "mcp_approval" ||
        block.kind === "skill_draft"
      ) {
        const view = approvalViewFromBlock(message, block);
        if (view) interactions.push(view);
        return;
      }
      if (block.kind === "ask") {
        const planReview = planReviewViewFromAsk(message, block);
        if (planReview) interactions.push(planReview);
        return;
      }
      const display = displayBlockFrom(message, block, index);
      if (display) displayBlocks.push(display);
    });
  }
  return { interactions, displayBlocks };
}

const SUBAGENT_STATUS = {
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

const CLOUD_AGENT_STATUS = {
  running: "running",
  finished: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

function displayBlockFrom(
  message: CardMessageFact,
  block: MessageBlock,
  index: number,
): DisplayBlock | null {
  const blockId = `${message.id}:${index}:${block.kind}`;
  let candidate: unknown;
  if (block.kind === "text") {
    candidate = { kind: "markdown", blockId, text: block.text };
  } else if (block.kind === "chart") {
    candidate = { kind: "chart", blockId, name: block.name, spec: block.spec, data: block.data };
  } else if (block.kind === "image") {
    candidate = {
      kind: "media",
      blockId,
      mediaKind: "image",
      artifactId: block.artifactId,
      name: block.name,
      mimeType: block.mimeType,
      size: null,
    };
  } else if (block.kind === "file") {
    candidate = {
      kind: "media",
      blockId,
      mediaKind: "file",
      artifactId: block.artifactId,
      name: block.name,
      mimeType: block.mimeType,
      size: block.size,
    };
  } else if (block.kind === "subagent") {
    candidate = {
      kind: "task_status",
      blockId,
      status: SUBAGENT_STATUS[block.status],
      title: block.name,
      summary: block.progress ?? null,
      source: { threadId: message.threadId, messageId: message.id, runId: message.runId },
    };
  } else if (block.kind === "cloud_agent") {
    candidate = {
      kind: "task_status",
      blockId,
      status: CLOUD_AGENT_STATUS[block.status],
      title: block.title,
      summary: null,
      source: { threadId: message.threadId, messageId: message.id, runId: message.runId },
    };
  } else {
    return null;
  }
  const parsed = DisplayBlockSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Compose the thread-level CARD-01 surface. It is a read model over facts the
 * snapshot already loaded; it introduces no persistence and no new producers.
 */
export function projectThreadCardSurface(input: ThreadCardSurfaceInput): ThreadCardSurface {
  const fromMessages = interactionViewsFromMessages(input.messages);
  const interactions: InteractionView[] = [];
  const byId = new Map<string, InteractionView>();

  // The durable Intervention row is authoritative (revision, settled state).
  for (const view of input.interventions) {
    const projected = interactionViewFromIntervention(view);
    if (projected) byId.set(projected.interactionId, projected);
  }
  for (const view of fromMessages.interactions) {
    // A legacy plan-review ask can be synthesized as a generic input by the
    // older Intervention projection. The message binding wins there because it
    // is the only fact that proves the card reviews a plan version, not a tool.
    // A real plan_review row still wins over the message's revision-1 view.
    if (byId.get(view.interactionId)?.kind === "plan_review") continue;
    byId.set(view.interactionId, view);
  }
  for (const facts of input.groupMembershipApprovals ?? []) {
    const projected = projectGroupMembershipApproval(facts);
    if (projected) byId.set(projected.interactionId, projected);
  }
  interactions.push(...byId.values());

  const sessionControls: SessionControlView[] = deriveSessionControlViews({
    runs: input.runs,
    computer: input.computer,
    ...(input.now ? { now: input.now } : {}),
  });

  // Interaction-region order is frozen server-side so CARD-01B can render the
  // same order it tests. SessionControlView stays on its dedicated entry.
  const sortable = interactions
    .filter(
      (view): view is Exclude<InteractionView, { kind: "session_control" }> =>
        view.kind !== "session_control",
    )
    .sort(compareInteractionViews);
  const ordered: InteractionView[] = [...sortable, ...sessionControls];

  return {
    interactions: ordered,
    displayBlocks: fromMessages.displayBlocks,
    attention: projectAttentionItems(ordered),
  };
}

function compareInteractionViews(
  left: Exclude<InteractionView, { kind: "session_control" }>,
  right: Exclude<InteractionView, { kind: "session_control" }>,
): number {
  const leftPending = left.status === "pending";
  const rightPending = right.status === "pending";
  if (leftPending !== rightPending) return leftPending ? -1 : 1;
  if (leftPending) {
    const rank = { plan_review: 0, action_approval: 1, input_request: 2 } as const;
    const delta = rank[left.kind] - rank[right.kind];
    if (delta !== 0) return delta;
  }
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.interactionId === right.interactionId) return 0;
  return left.interactionId < right.interactionId ? -1 : 1;
}

/** Read-only helper for the execution snapshot's Intervention list. */
export function projectExecutionInteractions(
  interventions: readonly InterventionView[],
): InteractionView[] {
  return interventions
    .map((view) => interactionViewFromIntervention(view))
    .filter((view): view is InteractionView => view !== null);
}

/** Read-only helper for the execution snapshot's final result blocks. */
export function projectExecutionDisplayBlocks(
  blocks: readonly MessageBlock[],
  source: { threadId: string; messageId: string; runId: string | null },
): DisplayBlock[] {
  const message: CardMessageFact = {
    id: source.messageId,
    threadId: source.threadId,
    spaceId: "",
    botId: null,
    runId: source.runId,
    createdAt: "",
    blocks: [...blocks],
  };
  const projected: DisplayBlock[] = [];
  message.blocks.forEach((block, index) => {
    const display = displayBlockFrom(message, block, index);
    if (display) projected.push(display);
  });
  return projected;
}
