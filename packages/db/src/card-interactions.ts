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
  MAX_PRESENTATION_TEXT_CHARS,
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
import {
  ACTIVE_RUN_STATUSES,
  cloudAgentHttpsUrl,
  groupVoiceChats,
  speechFromBlocks,
  voiceChatDuration,
} from "@rakazo/core";
import { CHAT_GROUP_KIND_AGENT_PAIR } from "./agent-pairs.js";
import type { Prisma } from "./client.js";

export interface CardMessageFact {
  id: string;
  threadId: string;
  spaceId: string;
  botId: string | null;
  runId: string | null;
  createdAt: string;
  role?: string;
  callId?: string | null;
  blocks: MessageBlock[];
}

export function cardMessageFact(
  message: Pick<ThreadMessage, "id" | "threadId" | "botId" | "runId" | "createdAt" | "blocks"> & {
    role?: ThreadMessage["role"];
    callId?: string | null;
  },
  spaceId: string,
): CardMessageFact {
  return {
    id: message.id,
    threadId: message.threadId,
    spaceId,
    botId: message.botId ?? null,
    runId: message.runId ?? null,
    createdAt: message.createdAt,
    role: message.role,
    callId: message.callId ?? null,
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
  /** Current Computer rows keyed by the Bot that owns them. */
  computers?: readonly CardComputerFact[];
  /**
   * Business facts for group_membership. RT-12 owns persistence; CARD-01A only
   * defines and tests the strict projection.
   */
  groupMembershipApprovals?: readonly GroupMembershipApprovalFacts[];
  now?: Date;
}

async function queryBotComputerFacts(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; botIds: readonly string[] },
): Promise<{ botIds: Set<string>; computers: CardComputerFact[] }> {
  const botIds = [...new Set(input.botIds)];
  if (botIds.length === 0) return { botIds: new Set(), computers: [] };
  const bots = await tx.bot.findMany({
    where: { id: { in: botIds }, spaceId: input.spaceId, archivedAt: null },
    select: {
      id: true,
      computer: {
        select: {
          id: true,
          controlHolder: true,
          controlBotId: true,
          controlRunId: true,
          controlLeaseId: true,
          controlLeaseExpiresAt: true,
        },
      },
    },
  });
  return {
    botIds: new Set(bots.map((bot) => bot.id)),
    computers: bots.flatMap((bot) =>
      bot.computer
        ? [
            {
              id: bot.computer.id,
              botId: bot.id,
              controlHolder: bot.computer.controlHolder,
              controlBotId: bot.computer.controlBotId,
              controlRunId: bot.computer.controlRunId,
              controlLeaseId: bot.computer.controlLeaseId,
              controlLeaseExpiresAt: bot.computer.controlLeaseExpiresAt,
            },
          ]
        : [],
    ),
  };
}

/**
 * Current Computer facts for the Bots behind a Thread's active Runs. A Run
 * executing directly in a group needs its own Computer to show takeover/return;
 * a delegated Run needs the Computer of the Bot executing it.
 */
export async function loadBotComputerFacts(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; botIds: readonly string[] },
): Promise<CardComputerFact[]> {
  return (await queryBotComputerFacts(tx, input)).computers;
}

const ORIGIN_CONTROL_MAX_DEPTH = 8;

const ORIGIN_CONTROL_RUN_SELECT = {
  id: true,
  spaceId: true,
  threadId: true,
  botId: true,
  status: true,
  waitKind: true,
  createdAt: true,
  waitStartedAt: true,
  leaseOwner: true,
  leaseExpiresAt: true,
  originThreadId: true,
  originRunId: true,
} as const;

type OriginControlCandidate = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  status: string;
  waitKind: string | null;
  createdAt: Date;
  waitStartedAt: Date | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  originThreadId: string | null;
  originRunId: string | null;
};

/**
 * RT-05F publishes a delegated Run's takeover request into its first visible
 * origin Thread while the Run itself stays bound to a hidden pair Thread, so
 * the thread's headline Run cannot represent it and `computer` message blocks
 * are display-only history. Walk the persisted origin chain and return the
 * active Runs whose visible origin is this Thread, already re-based onto the
 * visible Thread. The caller derives SessionControlViews from these facts; only
 * a live takeover request or a user-held return produces a view.
 *
 * Pair Threads are reused across visible origins, so a shared pair Thread is
 * never sufficient ancestry: every hop below the visible Thread must name an
 * eligible parent Run from the previous generation, matching the run-level
 * `originRunId` chain that `resolveVisibleOrigin` follows.
 */
export async function loadOriginControlFacts(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string },
): Promise<{ runs: CardRunFact[]; computers: CardComputerFact[] }> {
  const orderBy = [{ createdAt: "asc" as const }, { id: "asc" as const }];
  let candidates: OriginControlCandidate[] = await tx.run.findMany({
    where: {
      spaceId: input.spaceId,
      originThreadId: input.threadId,
      originRunId: { not: null },
      // readOrigin requires the full triple before presenting in an origin.
      originMessageId: { not: null },
      // message_group presents its waits in the target group, not the source.
      trigger: { not: "message_group" },
    },
    select: ORIGIN_CONTROL_RUN_SELECT,
    orderBy,
  });
  const controlRuns: OriginControlCandidate[] = [];
  const seenRuns = new Set<string>();
  for (let depth = 0; depth < ORIGIN_CONTROL_MAX_DEPTH; depth += 1) {
    if (candidates.length === 0) break;
    for (const run of candidates) {
      if (seenRuns.has(run.id)) continue;
      seenRuns.add(run.id);
      if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) controlRuns.push(run);
    }
    // Reuse across origins and depths is legitimate: the same pair Thread can
    // appear in several chains, so traversal is bounded by depth and by the
    // run-level parent match instead of a global seen-thread set.
    const nextThreadIds = [...new Set(candidates.map((run) => run.threadId))];
    if (nextThreadIds.length === 0) break;
    // Only a hidden pair Thread continues the chain; a visible ancestor ends it.
    const pairThreads = await tx.thread.findMany({
      where: {
        id: { in: nextThreadIds },
        spaceId: input.spaceId,
        group: { kind: CHAT_GROUP_KIND_AGENT_PAIR },
      },
      select: { id: true },
    });
    const pairThreadIds = new Set(pairThreads.map((thread) => thread.id));
    const eligibleParents = candidates.filter((run) => pairThreadIds.has(run.threadId));
    if (eligibleParents.length === 0) break;
    const parentThreadById = new Map(eligibleParents.map((run) => [run.id, run.threadId]));
    const fetched = await tx.run.findMany({
      where: {
        spaceId: input.spaceId,
        originThreadId: { in: [...pairThreadIds] },
        originRunId: { in: [...parentThreadById.keys()] },
        originMessageId: { not: null },
        trigger: { not: "message_group" },
      },
      select: ORIGIN_CONTROL_RUN_SELECT,
      orderBy,
    });
    candidates = fetched.filter(
      (run) => run.originRunId && parentThreadById.get(run.originRunId) === run.originThreadId,
    );
  }
  if (controlRuns.length === 0) return { runs: [], computers: [] };
  const bots = await queryBotComputerFacts(tx, {
    spaceId: input.spaceId,
    botIds: controlRuns.map((run) => run.botId),
  });
  return {
    runs: controlRuns
      .filter((run) => bots.botIds.has(run.botId))
      .map((run) => ({
        id: run.id,
        spaceId: run.spaceId,
        // The Run executes in a hidden pair Thread; its control is presented
        // in this visible origin Thread.
        threadId: input.threadId,
        botId: run.botId,
        status: run.status,
        waitKind: run.waitKind,
        createdAt: run.createdAt,
        waitStartedAt: run.waitStartedAt,
        executionLeaseActive: Boolean(
          (run.status === "leased" || run.status === "running") &&
            run.leaseOwner &&
            (!run.leaseExpiresAt || run.leaseExpiresAt.getTime() > Date.now()),
        ),
      })),
    computers: bots.computers,
  };
}

export function legacyBlockInteractionId(
  messageId: string,
  block: "app_connect" | "mcp_approval" | "skill_draft",
  blockIndex: number,
): string {
  // A message may carry several approvals of the same kind (onboarding posts
  // every suggested app_connect together), so the message id alone would make
  // them overwrite each other in the projection map.
  return `legacy_block:${block}:${messageId}:${blockIndex}`;
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
  blockIndex: number,
): ActionApprovalView | null {
  // Stored blocks are cast rather than parsed, so a pre-upgrade row can omit a
  // schema-defaulted status. The MCP resolver treats a missing status as open;
  // the strict projection must agree or the authorization disappears.
  const blockStatus = "status" in block ? (block.status as string | undefined) : undefined;
  const status: InteractionView["status"] =
    block.kind === "app_connect"
      ? blockStatus === "pending"
        ? "pending"
        : "answered"
      : block.kind === "mcp_approval"
        ? blockStatus === "connected"
          ? "answered"
          : blockStatus === "dismissed"
            ? "cancelled"
            : "pending"
        : blockStatus === "draft"
          ? "pending"
          : blockStatus === "discarded"
            ? "cancelled"
            : "answered";
  const interactionId = legacyBlockInteractionId(message.id, block.kind, blockIndex);
  const presentation =
    block.kind === "app_connect"
      ? { text: block.name, detail: block.description }
      : block.kind === "mcp_approval"
        ? {
            text: block.name,
            detail: "allowAllTools: true",
          }
        : {
            text: block.name.slice(0, MAX_PRESENTATION_TEXT_CHARS),
            detail: block.goal,
          };
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
        const view = approvalViewFromBlock(message, block, index);
        if (view) interactions.push(view);
        return;
      }
      if (block.kind === "ask") {
        const planReview = planReviewViewFromAsk(message, block);
        if (planReview) interactions.push(planReview);
        return;
      }
      displayBlocks.push(...displayBlocksFrom(message, block, index));
    });
  }
  displayBlocks.push(...voiceDisplayBlocks(messages));
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

const DISPLAY_TABLE_MAX_ROWS = 10_000;
const DISPLAY_TABLE_MAX_COLUMNS = 20;
const DISPLAY_CELL_MAX_CHARS = 4_000;
const DISPLAY_COLLECTION_MAX_ITEMS = 200;
const DISPLAY_COLLECTION_MAX_LABEL_CHARS = 200;
const DISPLAY_COLLECTION_MAX_VALUE_CHARS = 2_000;

function displayCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, DISPLAY_CELL_MAX_CHARS);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return (JSON.stringify(value) ?? "").slice(0, DISPLAY_CELL_MAX_CHARS);
  } catch {
    return String(value).slice(0, DISPLAY_CELL_MAX_CHARS);
  }
}

/**
 * The accessible data table that accompanies a chart's real data rows.
 * Returns null when the data exceeds the table limits: a silently clipped
 * table would claim to be the chart's full data, so the chart card simply
 * carries no companion table instead.
 */
function chartDataTable(blockId: string, data: readonly unknown[]): unknown | null {
  const rows = data.filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" && row !== null && !Array.isArray(row),
  );
  if (rows.length === 0) return null;
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (keys.length === 0) return null;
  if (rows.length > DISPLAY_TABLE_MAX_ROWS || keys.length > DISPLAY_TABLE_MAX_COLUMNS) {
    return null;
  }
  if (keys.some((key) => key.length > DISPLAY_COLLECTION_MAX_LABEL_CHARS)) return null;
  if (
    rows.some((row) => keys.some((key) => displayCell(row[key]).length >= DISPLAY_CELL_MAX_CHARS))
  ) {
    return null;
  }
  return {
    kind: "table",
    blockId: `${blockId}:table`,
    columns: keys.map((key, index) => ({
      id: `column-${index + 1}`,
      label: key || `Column ${index + 1}`,
    })),
    rows: rows.map((row) => keys.map((key) => displayCell(row[key]))),
  };
}

/**
 * The collection card is a read-only projection of a legacy `card` KV. When
 * the lines exceed what the display schema can carry, the projection is
 * skipped so the complete legacy card stays visible instead of silently
 * losing the excess.
 */
function collectionProjection(block: Extract<MessageBlock, { kind: "card" }>): unknown | null {
  if (block.lines.length > DISPLAY_COLLECTION_MAX_ITEMS) return null;
  if (
    block.lines.some(
      (line) =>
        line.k.trim().length > DISPLAY_COLLECTION_MAX_LABEL_CHARS ||
        line.v.length > DISPLAY_COLLECTION_MAX_VALUE_CHARS,
    )
  ) {
    return null;
  }
  return block.lines.map((line, lineIndex) => ({
    id: `line-${lineIndex + 1}`,
    label: line.k.trim() || `Item ${lineIndex + 1}`,
    value: line.v,
    detail: null,
  }));
}

function displayBlocksFrom(
  message: CardMessageFact,
  block: MessageBlock,
  index: number,
): DisplayBlock[] {
  const blockId = `${message.id}:${index}:${block.kind}`;
  const candidates: unknown[] = [];
  if (block.kind === "text") {
    candidates.push({ kind: "markdown", blockId, text: block.text });
  } else if (block.kind === "card") {
    const items = collectionProjection(block);
    if (items) {
      candidates.push({
        kind: "collection",
        blockId,
        title: null,
        items,
      });
    }
  } else if (block.kind === "chart") {
    candidates.push({
      kind: "chart",
      blockId,
      name: block.name,
      spec: block.spec,
      data: block.data,
    });
    const table = chartDataTable(blockId, block.data);
    if (table) candidates.push(table);
  } else if (block.kind === "image") {
    candidates.push({
      kind: "media",
      blockId,
      mediaKind: "image",
      artifactId: block.artifactId,
      name: block.name,
      mimeType: block.mimeType,
      size: null,
    });
  } else if (block.kind === "file") {
    const mimeType = block.mimeType.toLowerCase();
    if (mimeType === "text/html") {
      // A title beyond the schema cap would be silently clipped, so such a
      // document keeps its complete legacy card instead.
      if (block.name.length <= 500) {
        candidates.push({
          kind: "html",
          blockId,
          artifactId: block.artifactId,
          title: block.name || null,
          sandboxed: true,
        });
      }
    } else if (mimeType === "text/markdown" || mimeType === "application/pdf") {
      if (block.name.length <= 500) {
        candidates.push({
          kind: "page",
          blockId,
          pageId: block.artifactId,
          title: block.name,
          available: true,
        });
      }
    } else {
      candidates.push({
        kind: "media",
        blockId,
        mediaKind: "file",
        artifactId: block.artifactId,
        name: block.name,
        mimeType: block.mimeType,
        size: block.size,
      });
    }
  } else if (block.kind === "subagent") {
    candidates.push({
      kind: "task_status",
      blockId,
      status: SUBAGENT_STATUS[block.status],
      title: block.name,
      // The legacy subagent card showed `result || progress`; the unified
      // card must surface the final result, not stale running progress.
      summary: block.result ?? block.progress ?? null,
      source: { threadId: message.threadId, messageId: message.id, runId: message.runId },
    });
  } else if (block.kind === "cloud_agent") {
    candidates.push({
      kind: "task_status",
      blockId,
      status: CLOUD_AGENT_STATUS[block.status],
      title: block.title,
      summary: null,
      // The legacy CloudAgentCard linked to the PR or the agent URL; the
      // unified task card must keep that destination reachable.
      destination: cloudAgentHttpsUrl(block.prUrl) ?? cloudAgentHttpsUrl(block.url) ?? null,
      source: { threadId: message.threadId, messageId: message.id, runId: message.runId },
    });
  }
  return candidates.flatMap((candidate) => {
    const parsed = DisplayBlockSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

function voiceDisplayBlocks(messages: readonly CardMessageFact[]): DisplayBlock[] {
  const groups = groupVoiceChats(
    messages.map((message) => ({
      id: message.id,
      role: message.role ?? "bot",
      ...(message.runId ? { runId: message.runId } : {}),
      ...(message.callId ? { callId: message.callId } : {}),
      createdAt: message.createdAt,
      blocks: message.blocks,
    })),
  );
  const blocks: DisplayBlock[] = [];
  for (const group of groups) {
    if (group.kind !== "voiceChat") continue;
    const anchor = group.marker ?? group.messages[0];
    if (!anchor) continue;
    const transcript = group.messages
      .filter((message) => message !== group.marker)
      .map((message) => speechFromBlocks(message.blocks).trim())
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 20_000);
    const parsed = DisplayBlockSchema.safeParse({
      kind: "voice",
      blockId: `${anchor.id}:voice`,
      artifactId: null,
      durationMs: voiceChatDuration(group) * 1_000,
      transcript: transcript || null,
    });
    if (parsed.success) blocks.push(parsed.data);
  }
  return blocks;
}

/**
 * Upgrade a durable generic input Intervention to a plan-review view without
 * losing the Intervention's lifecycle. The message supplies the plan content;
 * revision, status, expiry, source, and presentation stay authoritative.
 */
function upgradeLegacyPlanReview(
  authoritative: Extract<InteractionView, { kind: "input_request" }>,
  legacy: Extract<InteractionView, { kind: "plan_review" }>,
): InteractionView | null {
  const parsed = PlanReviewViewSchema.safeParse({
    ...legacy,
    interactionId: authoritative.interactionId,
    revision: authoritative.revision,
    status: authoritative.status,
    createdAt: authoritative.createdAt,
    expiresAt: authoritative.expiresAt,
    attentionAt: authoritative.attentionAt,
    source: authoritative.source,
    presentation: authoritative.presentation,
    decision: null,
    feedback: null,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Merge durable Interventions with message-derived views. Durable rows are
 * authoritative; a message may upgrade a generic input to plan review but can
 * never overwrite a settled lifecycle. Shared by the thread and execution
 * projections so both surfaces agree on the same interaction id.
 */
export function mergeCardInteractions(
  durable: readonly InterventionView[],
  messageViews: readonly InteractionView[],
): Map<string, InteractionView> {
  const byId = new Map<string, InteractionView>();
  for (const view of durable) {
    const projected = interactionViewFromIntervention(view);
    if (projected) byId.set(projected.interactionId, projected);
  }
  for (const view of messageViews) {
    const existing = byId.get(view.interactionId);
    if (!existing) {
      byId.set(view.interactionId, view);
      continue;
    }
    // A legacy plan-review ask can be synthesized as a generic input by the
    // older Intervention projection. The message binding wins there because it
    // is the only fact that proves the card reviews a plan version, not a tool.
    // A real plan_review row still wins over the message's revision-1 view.
    if (existing.kind === "plan_review") continue;
    if (view.kind === "plan_review") {
      if (existing.kind === "input_request") {
        const upgraded = upgradeLegacyPlanReview(existing, view);
        if (upgraded) byId.set(view.interactionId, upgraded);
      }
      // Never let a message-derived pending view overwrite a settled durable
      // one; a stopped or expired run must stay non-actionable history.
      continue;
    }
    byId.set(view.interactionId, view);
  }
  return byId;
}

/**
 * Compose the thread-level CARD-01 surface. It is a read model over facts the
 * snapshot already loaded; it introduces no persistence and no new producers.
 */
export function projectThreadCardSurface(input: ThreadCardSurfaceInput): ThreadCardSurface {
  const fromMessages = interactionViewsFromMessages(input.messages);
  const byId = mergeCardInteractions(input.interventions, fromMessages.interactions);
  for (const facts of input.groupMembershipApprovals ?? []) {
    const projected = projectGroupMembershipApproval(facts);
    if (projected) byId.set(projected.interactionId, projected);
  }
  const interactions = [...byId.values()];

  const sessionControls: SessionControlView[] = deriveSessionControlViews({
    runs: input.runs,
    computers: input.computers ?? [],
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

/**
 * Execution snapshots need the same message-backed approvals as the Thread
 * surface: MCP assignment and app authorization are persisted as message
 * blocks without an Intervention row. Merge them with the durable views over
 * the snapshot's bounded message window.
 */
export function projectExecutionCardInteractions(input: {
  messages: readonly CardMessageFact[];
  interventions: readonly InterventionView[];
}): InteractionView[] {
  const fromMessages = interactionViewsFromMessages(input.messages);
  return [...mergeCardInteractions(input.interventions, fromMessages.interactions).values()];
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
    role: "bot",
    blocks: [...blocks],
  };
  const projected: DisplayBlock[] = [];
  message.blocks.forEach((block, index) => {
    projected.push(...displayBlocksFrom(message, block, index));
  });
  return projected;
}
