import {
  type GroupMembershipApprovalFacts,
  InterventionPresentationSchema,
  type InterventionStatus,
  type MessageBlock,
} from "@rakazo/contracts";
import { CHAT_GROUP_KIND_STANDARD } from "./agent-pairs.js";
import { lockThreadsForBackgroundTasks } from "./background-task-registration.js";
import type { Prisma } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { lockOwnedGroup } from "./group-thread-locks.js";
import { lockRun } from "./locks.js";
import { deliverGroupMessageInTransaction } from "./message-group-delivery.js";
import { createThreadMessageInTransaction } from "./messages.js";

export const GROUP_MEMBERSHIP_REQUEST_REVISION = 1;

export type GroupMembershipTargetInspection =
  | {
      ok: true;
      group: { id: string; name: string; threadId: string; leadBotId: string | null };
      bot: { id: string; name: string };
      isMember: boolean;
    }
  | {
      ok: false;
      reason: "group_unavailable" | "bot_unavailable" | "not_manageable";
    };

/**
 * The target group and Bot as the requesting user may use them right now.
 * Group management in this repository is ownership: a standard group belongs
 * to exactly one user, so `canManageMembers` is that user acting on their own
 * group and their own Bot. Nothing here widens reads beyond the caller's
 * already-authorized scope; an unreadable group stays the tool's existing
 * "no group" failure and never reaches this inspection.
 */
export async function inspectGroupMembershipTarget(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; userId: string; botId: string; groupId: string },
): Promise<GroupMembershipTargetInspection> {
  const group = await tx.chatGroup.findFirst({
    where: {
      id: input.groupId,
      spaceId: input.spaceId,
      kind: CHAT_GROUP_KIND_STANDARD,
      archivedAt: null,
      thread: { spaceId: input.spaceId },
    },
    select: {
      id: true,
      name: true,
      userId: true,
      leadBotId: true,
      thread: { select: { id: true } },
    },
  });
  if (!group?.thread) return { ok: false, reason: "group_unavailable" };
  const bot = await tx.bot.findFirst({
    where: {
      id: input.botId,
      spaceId: input.spaceId,
      userId: input.userId,
      archivedAt: null,
    },
    select: { id: true, name: true },
  });
  if (!bot) return { ok: false, reason: "bot_unavailable" };
  if (group.userId !== input.userId) return { ok: false, reason: "not_manageable" };
  const membership = await tx.chatGroupMember.findUnique({
    where: { groupId_botId: { groupId: group.id, botId: bot.id } },
    select: { id: true },
  });
  return {
    ok: true,
    group: {
      id: group.id,
      name: group.name,
      threadId: group.thread.id,
      leadBotId: group.leadBotId,
    },
    bot,
    isMember: Boolean(membership),
  };
}

export function buildGroupMembershipPresentation(input: { botName: string; groupName: string }): {
  text: string;
  detail: string;
} {
  const bot = input.botName.replace(/\s+/g, " ").trim() || "this Bot";
  const group = input.groupName.replace(/\s+/g, " ").trim() || "this room";
  return {
    text: `Add ${bot} to “${group}”?`,
    detail: `Joining lets ${bot} read the room, speak there, and continue this request. It does not grant any other room, file, connector, or credential access.`,
  };
}

export type GroupMembershipRequestInput = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  groupId: string;
  groupName: string;
  sourceThreadId: string;
  sourceRunId: string;
  requestMessageId: string | null;
  cardMessageId: string;
  interventionId: string;
  deliveryKey: string;
  requestRevision: number;
  message: string;
  topic: string | null;
  presentation: { text: string; detail?: string };
  expiresAt: Date | null;
};

export async function createGroupMembershipRequestInTransaction(
  tx: Prisma.TransactionClient,
  input: GroupMembershipRequestInput,
): Promise<void> {
  await tx.groupMembershipRequest.create({
    data: {
      id: input.id,
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      groupId: input.groupId,
      groupName: input.groupName,
      sourceThreadId: input.sourceThreadId,
      sourceRunId: input.sourceRunId,
      requestMessageId: input.requestMessageId,
      cardMessageId: input.cardMessageId,
      interventionId: input.interventionId,
      deliveryKey: input.deliveryKey,
      requestRevision: input.requestRevision,
      message: input.message,
      topic: input.topic,
      presentation: input.presentation as Prisma.InputJsonValue,
      expiresAt: input.expiresAt,
    },
  });
}

export async function loadGroupMembershipRequestForIntervention(
  tx: Prisma.TransactionClient,
  interventionId: string,
) {
  return tx.groupMembershipRequest.findUnique({ where: { interventionId } });
}

/**
 * Facts for the unified Interaction projection. Pending requests always
 * project; terminal ones only inside the snapshot's bounded window (the Run
 * list it already loads, or the card message on the current page). Never an
 * unbounded history read.
 */
export async function loadGroupMembershipApprovalFacts(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    userId: string;
    threadId: string;
    messageIds: readonly string[];
    recentRunIds: readonly string[];
  },
): Promise<GroupMembershipApprovalFacts[]> {
  const requests = await tx.groupMembershipRequest.findMany({
    where: {
      spaceId: input.spaceId,
      userId: input.userId,
      sourceThreadId: input.threadId,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  if (requests.length === 0) return [];
  const interventionIds = requests
    .map((request) => request.interventionId)
    .filter((id): id is string => Boolean(id));
  if (interventionIds.length === 0) return [];
  const interventions = await tx.intervention.findMany({
    where: { id: { in: interventionIds } },
  });
  const interventionById = new Map(interventions.map((row) => [row.id, row]));
  const messageIds = new Set(input.messageIds);
  const runIds = new Set(input.recentRunIds);
  const groupIds = [...new Set(requests.map((request) => request.groupId))];
  const groups = await tx.chatGroup.findMany({
    where: {
      id: { in: groupIds },
      spaceId: input.spaceId,
      kind: CHAT_GROUP_KIND_STANDARD,
      archivedAt: null,
    },
    select: { id: true, userId: true },
  });
  const managedGroupIds = new Set(
    groups.filter((group) => group.userId === input.userId).map((group) => group.id),
  );
  // X-GROUP-FAIL is the only card for a request that could not be applied for
  // lack of member-management permission; the cancelled approval must not
  // linger beside it. The failure replaces the ask blocks in the same Message.
  const cardMessageIds = requests
    .map((request) => request.cardMessageId)
    .filter((id): id is string => Boolean(id));
  const cardMessages =
    cardMessageIds.length > 0
      ? await tx.message.findMany({
          where: { id: { in: cardMessageIds } },
          select: { id: true, blocks: true },
        })
      : [];
  const failedCardMessageIds = new Set(
    cardMessages
      .filter(
        (message) =>
          Array.isArray(message.blocks) &&
          message.blocks.some(
            (block) => (block as { kind?: unknown }).kind === "group_membership_failure",
          ),
      )
      .map((message) => message.id),
  );

  const facts: GroupMembershipApprovalFacts[] = [];
  for (const request of requests) {
    const intervention = request.interventionId
      ? interventionById.get(request.interventionId)
      : undefined;
    if (!intervention) continue;
    if (request.cardMessageId && failedCardMessageIds.has(request.cardMessageId)) continue;
    const pending = intervention.status === "pending";
    if (
      !pending &&
      !runIds.has(intervention.runId) &&
      !messageIds.has(intervention.messageId) &&
      !(request.cardMessageId ? messageIds.has(request.cardMessageId) : false)
    ) {
      continue;
    }
    const presentation = InterventionPresentationSchema.safeParse(request.presentation);
    if (!presentation.success) continue;
    const interactionMessageId = request.cardMessageId ?? intervention.messageId;
    const decision =
      intervention.decision === "approved" || intervention.decision === "denied"
        ? intervention.decision
        : null;
    facts.push({
      interactionId: intervention.id,
      revision: intervention.revision,
      groupId: request.groupId,
      botId: request.botId,
      messageGroupRequestId: request.id,
      requestRevision: request.requestRevision,
      sourceSpaceId: request.spaceId,
      sourceThreadId: request.sourceThreadId,
      sourceMessageId: interactionMessageId,
      sourceRunId: request.sourceRunId,
      sourceBotId: request.botId,
      createdAt: request.createdAt.toISOString(),
      expiresAt: intervention.expiresAt ? intervention.expiresAt.toISOString() : null,
      status: intervention.status as InterventionStatus,
      decision,
      presentation: presentation.data,
      canManageMembers: managedGroupIds.has(request.groupId),
    });
  }
  return facts;
}

export type MembershipDecisionInput = {
  spaceId: string;
  threadId: string;
  executionThreadId: string;
  runId: string;
  interventionId: string;
  answeredByUserId: string;
  answer: string;
  clientSubmissionId: string;
  /** The request revision the card displayed; a mismatch is a stale card. */
  expectedRevision?: number;
};

export type MembershipDecisionOutcome =
  | {
      ok: true;
      threadId: string;
      seq: number;
      delivery?: {
        targetRunId: string;
        targetThreadId: string;
        targetEventSeq: number;
      };
    }
  | { ok: false; reason: "not_found" | "conflict" };

/**
 * The group-membership business branch of `threads.resolveIntervention`.
 * Membership change, target message, Task/Run, source receipt and the
 * Intervention settlement commit together; a denial, expiry or unavailable
 * target writes none of them. The original request content comes from the
 * bound row, never from the card copy or from a regenerated tool call.
 */
export async function resolveGroupMembershipDecisionInTransaction(
  tx: Prisma.TransactionClient,
  input: MembershipDecisionInput,
  settle: (
    status: "answered" | "expired" | "cancelled",
    decision?: "approved" | "denied",
  ) => Promise<unknown>,
): Promise<MembershipDecisionOutcome> {
  const request = await loadGroupMembershipRequestForIntervention(tx, input.interventionId);
  if (!request) return { ok: false, reason: "not_found" };
  if (
    request.spaceId !== input.spaceId ||
    request.sourceThreadId !== input.threadId ||
    request.sourceRunId !== input.runId ||
    request.userId !== input.answeredByUserId ||
    (input.expectedRevision !== undefined && input.expectedRevision !== request.requestRevision)
  ) {
    return { ok: false, reason: "conflict" };
  }
  const decision =
    input.answer === "approve" || input.answer === "allow"
      ? ("approved" as const)
      : input.answer === "deny" || input.answer === "reject"
        ? ("denied" as const)
        : null;
  if (!decision) return { ok: false, reason: "conflict" };

  const intervention = await tx.intervention.findUnique({
    where: { id: input.interventionId },
  });
  if (
    !intervention ||
    intervention.status !== "pending" ||
    intervention.spaceId !== input.spaceId ||
    intervention.threadId !== input.threadId ||
    intervention.runId !== input.runId ||
    (request.cardMessageId && intervention.messageId !== request.cardMessageId)
  ) {
    return { ok: false, reason: "conflict" };
  }
  if (intervention.expiresAt && intervention.expiresAt.getTime() <= Date.now()) {
    await settle("expired");
    return { ok: false, reason: "conflict" };
  }

  await lockRun(tx, input.runId);
  const run = await tx.run.findFirst({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.executionThreadId,
      botId: request.botId,
      userId: request.userId,
      status: "waiting_input",
    },
    select: {
      id: true,
      spaceId: true,
      threadId: true,
      botId: true,
      userId: true,
      orchestration: true,
      sourceMessageId: true,
    },
  });
  if (!run) return { ok: false, reason: "conflict" };
  const message = await tx.message.findFirst({
    where: { id: intervention.messageId, threadId: input.threadId, runId: input.runId },
    select: { id: true, blocks: true },
  });
  if (!message) return { ok: false, reason: "conflict" };
  const parsedBlocks = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : null;
  if (!parsedBlocks) return { ok: false, reason: "conflict" };
  const ask = parsedBlocks.find(
    (block) =>
      block.kind === "ask" &&
      block.interventionId === input.interventionId &&
      block.status !== "answered" &&
      block.status !== "expired",
  );
  if (!ask || ask.kind !== "ask") return { ok: false, reason: "conflict" };

  let delivery: { targetRunId: string; targetThreadId: string; targetEventSeq: number } | undefined;
  if (decision === "approved") {
    const firstLook = await inspectGroupMembershipTarget(tx, {
      spaceId: request.spaceId,
      userId: request.userId,
      botId: request.botId,
      groupId: request.groupId,
    });
    if (!firstLook.ok) {
      return settleUnavailableApproval(
        tx,
        input,
        parsedBlocks,
        ask,
        message.id,
        run,
        request,
        firstLook.reason,
        settle,
      );
    }
    await lockThreadsForBackgroundTasks(tx, [firstLook.group.threadId]);
    await lockOwnedGroup(tx, { spaceId: request.spaceId, userId: request.userId }, request.groupId);
    const target = await inspectGroupMembershipTarget(tx, {
      spaceId: request.spaceId,
      userId: request.userId,
      botId: request.botId,
      groupId: request.groupId,
    });
    if (!target.ok) {
      return settleUnavailableApproval(
        tx,
        input,
        parsedBlocks,
        ask,
        message.id,
        run,
        request,
        target.reason,
        settle,
      );
    }

    if (!target.isMember) {
      await tx.chatGroupMember.createMany({
        data: [{ groupId: target.group.id, botId: request.botId }],
        skipDuplicates: true,
      });
      if (!target.group.leadBotId) {
        await tx.chatGroup.update({
          where: { id: target.group.id },
          data: { leadBotId: request.botId },
        });
      }
    }
    const delivered = await deliverGroupMessageInTransaction(tx, {
      sourceRun: {
        id: run.id,
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        userId: run.userId,
        orchestration: run.orchestration,
      },
      sourceThreadId: request.sourceThreadId,
      sender: { id: request.botId, name: target.bot.name },
      group: { id: target.group.id, name: target.group.name, threadId: target.group.threadId },
      message: request.message,
      topic: request.topic ?? receiptTopic(request.message),
      deliveryKey: request.deliveryKey,
    });
    const claimed = await tx.groupMembershipRequest.updateMany({
      where: { id: request.id, targetRunId: null },
      data: {
        receiptMessageId: delivered.receiptMessageId,
        targetMessageId: delivered.targetMessageId,
        targetRunId: delivered.targetRunId,
      },
    });
    if (claimed.count !== 1) return { ok: false, reason: "conflict" };
    delivery = {
      targetRunId: delivered.targetRunId,
      targetThreadId: target.group.threadId,
      targetEventSeq: delivered.targetEventSeq,
    };
  }

  const updated = markAskSettled(
    parsedBlocks,
    ask,
    "answered",
    decision === "approved" ? "approve" : "deny",
  );
  await tx.message.update({ where: { id: message.id }, data: { blocks: updated } });
  const event = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: run.botId,
    type: "thread.message.updated",
    runId: input.runId,
    payload: { messageId: message.id, role: "bot", blocks: updated },
  });
  await queueResumedRun(tx, input);
  await settle("answered", decision);
  return { ok: true, threadId: event.threadId, seq: event.seq, ...(delivery ? { delivery } : {}) };
}

/**
 * The approved request can no longer be applied exactly as shown (group or
 * Bot unavailable, or manage permission gone). The card settles as cancelled,
 * nothing is written to the target group, and the source Run resumes so its
 * tool replay can tell the user no work started.
 */
async function settleUnavailableApproval(
  tx: Prisma.TransactionClient,
  input: MembershipDecisionInput,
  blocks: MessageBlock[],
  ask: Extract<MessageBlock, { kind: "ask" }>,
  messageId: string,
  run: { botId: string },
  request: {
    botId: string;
    groupId: string;
    groupName: string;
    deliveryKey: string;
  },
  reason: "group_unavailable" | "bot_unavailable" | "not_manageable",
  settle: (
    status: "answered" | "expired" | "cancelled",
    decision?: "approved" | "denied",
  ) => Promise<unknown>,
): Promise<MembershipDecisionOutcome> {
  const updated =
    reason === "not_manageable"
      ? ([
          {
            kind: "group_membership_failure",
            groupId: request.groupId,
            groupName: request.groupName.slice(0, 200),
            botId: request.botId,
            reason: "member_permission",
          } satisfies MessageBlock,
        ] as MessageBlock[])
      : markAskSettled(blocks, ask, "expired");
  await tx.message.update({
    where: { id: messageId },
    data: { blocks: updated },
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: run.botId,
    type: "thread.message.updated",
    runId: input.runId,
    payload: { messageId, role: "bot", blocks: updated },
  });
  await queueResumedRun(tx, input);
  await settle("cancelled");
  return { ok: true, threadId: event.threadId, seq: event.seq };
}

function markAskSettled(
  blocks: MessageBlock[],
  ask: Extract<MessageBlock, { kind: "ask" }>,
  status: "answered" | "expired",
  answer?: string,
): MessageBlock[] {
  return blocks.map((block) =>
    block === ask ? { ...block, status, ...(answer !== undefined ? { answer } : {}) } : block,
  );
}

async function queueResumedRun(
  tx: Prisma.TransactionClient,
  input: MembershipDecisionInput,
): Promise<void> {
  const queued = await tx.run.updateMany({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.executionThreadId,
      status: "waiting_input",
    },
    data: { status: "queued", waitKind: null },
  });
  if (queued.count !== 1) throw new Error("Membership Run was no longer waiting");
}

/**
 * X-GROUP-FAIL as a durable fact. The tool writes this card itself so the
 * no-permission branch never depends on model-authored copy, and it stays
 * distinct from both the approval card and generic failure rows. Deduped by
 * delivery key for tool retries.
 */
export async function recordGroupMembershipFailureInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    runId: string;
    groupId: string;
    groupName: string;
    deliveryKey: string;
  },
): Promise<{ messageId: string; seq: number } | null> {
  const nonce = `group-membership-failure:${input.deliveryKey}`;
  const existing = await tx.message.findUnique({
    where: { threadId_clientNonce: { threadId: input.threadId, clientNonce: nonce } },
    select: { id: true },
  });
  if (existing) return null;
  const block: MessageBlock = {
    kind: "group_membership_failure",
    groupId: input.groupId,
    groupName: input.groupName.slice(0, 200),
    botId: input.botId,
    reason: "member_permission",
  };
  const message = await createThreadMessageInTransaction(tx, {
    threadId: input.threadId,
    role: "bot",
    originKind: "system",
    blocks: [block],
    botId: input.botId,
    runId: input.runId,
    clientNonce: nonce,
    markUnread: false,
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    type: "thread.message.created",
    runId: input.runId,
    payload: { messageId: message.id, role: "bot", blocks: [block] },
  });
  return { messageId: message.id, seq: event.seq };
}

function receiptTopic(message: string): string {
  const first = message.split(/[。.!?！？\n]/)[0]?.trim() ?? "";
  return (first || "this work").slice(0, 80);
}
