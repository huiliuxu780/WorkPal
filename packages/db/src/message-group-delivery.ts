import type { MessageBlock } from "@rakazo/contracts";
import {
  buildRunOrchestration,
  collaborationFromOrchestration,
  type DestinationLocator,
  parseCollaborationReceipt,
  parseDestinationLocator,
  turnExecutionForSource,
} from "@rakazo/core";
import type { Prisma } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { touchGroupUpdatedAt } from "./group-thread-locks.js";
import { createThreadMessageInTransaction } from "./messages.js";

const RECEIPT_PREFIX = "group-message:";

export type GroupDeliverySourceRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  orchestration?: unknown;
};

export type DeliverGroupMessageInput = {
  sourceRun: GroupDeliverySourceRun;
  sourceThreadId: string;
  sender: { id: string; name: string };
  group: { id: string; name: string; threadId: string };
  /** Already redacted at the tool boundary. */
  message: string;
  topic: string;
  deliveryKey: string;
};

export type GroupDeliveryResult = Readonly<{
  groupId: string;
  groupName: string;
  targetRunId: string;
  receiptMessageId: string;
  targetMessageId: string;
  locator: DestinationLocator;
  targetEventSeq: number;
  receiptEventSeq: number;
}>;

/**
 * The single transaction-internal `message_group` delivery: source receipt,
 * target message, independent Task and owner Run. RT-11's tool path and RT-12's
 * membership approval both call this after their own authorization; neither
 * keeps a second copy of the delivery rules.
 *
 * Callers must hold the source and target Thread locks plus the group lock,
 * and must have revalidated the source Run, membership and group state.
 */
export async function deliverGroupMessageInTransaction(
  tx: Prisma.TransactionClient,
  input: DeliverGroupMessageInput,
): Promise<GroupDeliveryResult> {
  const { sourceRun, group } = input;
  const targetMessage = await createThreadMessageInTransaction(tx, {
    threadId: group.threadId,
    role: "bot",
    originKind: "bot",
    blocks: [{ kind: "text", text: input.message }],
    botId: sourceRun.botId,
    markUnread: true,
  });

  const locator = parseDestinationLocator({
    kind: "group_message",
    groupId: group.id,
    threadId: group.threadId,
    messageId: targetMessage.id,
  });
  const receipt = parseCollaborationReceipt({
    kind: "collaboration_receipt",
    target: { kind: "group", groupId: group.id, threadId: group.threadId },
    state: "sent",
    destination: locator,
    display: { groupName: group.name, topic: input.topic },
  });
  const receiptBlock = receipt as MessageBlock;
  const receiptMessage = await createThreadMessageInTransaction(tx, {
    threadId: input.sourceThreadId,
    role: "bot",
    originKind: "bot",
    blocks: [receiptBlock],
    botId: sourceRun.botId,
    runId: sourceRun.id,
    clientNonce: `${RECEIPT_PREFIX}${input.deliveryKey}`,
    markUnread: false,
  });

  const task = await tx.task.create({
    data: {
      spaceId: sourceRun.spaceId,
      botId: sourceRun.botId,
      threadId: group.threadId,
      userId: sourceRun.userId,
      prompt: input.message,
      status: "queued",
    },
    select: { id: true },
  });
  const lineage = collaborationFromOrchestration(sourceRun.orchestration);
  const nextRun = await tx.run.create({
    data: {
      spaceId: sourceRun.spaceId,
      botId: sourceRun.botId,
      threadId: group.threadId,
      taskId: task.id,
      userId: sourceRun.userId,
      status: "queued",
      trigger: "message_group",
      sourceMessageId: targetMessage.id,
      originThreadId: input.sourceThreadId,
      originRunId: sourceRun.id,
      originMessageId: receiptMessage.id,
      orchestration: buildRunOrchestration({
        kind: "bot_message",
        ownerBotId: input.sender.id,
        responseMode: "single",
        ownershipMode: "owner",
        execution: turnExecutionForSource("chat"),
        collaboration: {
          role: "owner",
          source: "bot_message",
          fromBotId: input.sender.id,
          parentRunId: sourceRun.id,
          handoffDepth: lineage?.handoffDepth ?? 0,
          messageHop: 0,
        },
      }),
    },
    select: { id: true },
  });
  await tx.message.update({
    where: { id: targetMessage.id },
    data: { runId: nextRun.id },
  });

  const targetEvent = await appendEventInTransaction(tx, {
    spaceId: sourceRun.spaceId,
    threadId: group.threadId,
    botId: sourceRun.botId,
    type: "thread.message.created",
    runId: nextRun.id,
    payload: {
      messageId: targetMessage.id,
      role: "bot",
      blocks: [{ kind: "text", text: input.message }],
    },
  });
  const receiptEvent = await appendEventInTransaction(tx, {
    spaceId: sourceRun.spaceId,
    threadId: input.sourceThreadId,
    botId: sourceRun.botId,
    type: "thread.message.created",
    runId: sourceRun.id,
    payload: { messageId: receiptMessage.id, role: "bot", blocks: [receiptBlock] },
  });
  await touchGroupUpdatedAt(tx, group.id);

  return {
    groupId: group.id,
    groupName: group.name,
    targetRunId: nextRun.id,
    receiptMessageId: receiptMessage.id,
    targetMessageId: targetMessage.id,
    locator,
    targetEventSeq: targetEvent.seq,
    receiptEventSeq: receiptEvent.seq,
  };
}

export function groupReceiptNonce(deliveryKey: string): string {
  return `${RECEIPT_PREFIX}${deliveryKey}`;
}
