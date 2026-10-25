import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  buildRunOrchestration,
  collaborationFromOrchestration,
  outcomeResumptionCollaboration,
  parseCollaborationReceipt,
  parseDestinationLocator,
  RoundtableFeatureDisabledError,
  turnExecutionForSource,
  type CollaborationReceipt,
  type DestinationLocator,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  CHAT_GROUP_KIND_STANDARD,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  lockThreadsForBackgroundTasks,
  type Prisma,
  type PrismaClient,
  touchGroupUpdatedAt,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

import type { ExecutorDeps } from "./executor.js";

const ERROR_NO_GROUP = "no group found with that id or name";
const ERROR_AMBIGUOUS_GROUP = "more than one group has that name; use group_id";
const ERROR_ARCHIVED_GROUP = "this group is archived";
const ERROR_NOT_MEMBER = "you are not a member of this group";
const ERROR_NOT_DIRECT_CHAT = "message_group is only available in your direct chat";
const ERROR_TARGET_TASK = "message_group cannot target an existing task";
const ERROR_INTENT = "message_group only supports intent=request";
const ERROR_MESSAGE = "message is required";
const ERROR_SOURCE_INACTIVE = "source run is no longer active";
const ERROR_GROUP_UNAVAILABLE = "this group is no longer available";
const ERROR_INCOMPLETE = "recorded message_group delivery is incomplete";

const RECEIPT_PREFIX = "group-message:";
const MAX_TOPIC_LENGTH = 80;

type MessageGroupDeps = Pick<
  ExecutorDeps,
  "prisma" | "events" | "jobs" | "roundtableFeatures"
>;

type MessageGroupRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  sourceMessageId?: string | null;
  orchestration?: unknown;
};

type MessageGroupInput = {
  group_id?: string;
  confirm_name?: string;
  message: string;
  intent?: string;
  topic?: string;
  deliveryKey?: string;
};

type GroupPreview = {
  id: string;
  name: string;
  threadId: string;
};

export type MessageGroupDelivery = Readonly<{
  ok: true;
  groupId: string;
  groupName: string;
  targetRunId: string;
  receiptMessageId: string;
  locator: DestinationLocator;
  replayed?: true;
  note: string;
}>;

type MessageGroupFailure = Readonly<{ ok: false; error: string }>;

type TerminalStatus = "completed" | "failed" | "cancelled";

/**
 * `message_group` delivery from a Bot's direct chat into one of the user's
 * standard groups. Source receipt, target message, Task and owner Run are one
 * transaction; the target Run only becomes runnable after the commit.
 */
export async function messageGroup(
  deps: MessageGroupDeps,
  run: MessageGroupRun,
  sender: { id: string; name: string },
  input: MessageGroupInput,
  options?: { deliveryKey?: string },
): Promise<MessageGroupDelivery | MessageGroupFailure> {
  if (deps.roundtableFeatures?.message_group !== true) {
    throw new RoundtableFeatureDisabledError("message_group");
  }
  if (input.intent !== undefined && input.intent !== "request") {
    return { ok: false, error: ERROR_INTENT };
  }
  const message = input.message.trim();
  if (!message) return { ok: false, error: ERROR_MESSAGE };
  const groupId = input.group_id?.trim();
  const confirmName = input.confirm_name?.trim();
  if (!groupId && !confirmName) return { ok: false, error: ERROR_NO_GROUP };

  const preview = await resolveGroupPreview(deps.prisma, {
    spaceId: run.spaceId,
    userId: run.userId,
    groupId,
    confirmName,
  });
  if (!preview.ok) return preview;

  const deliveryKey = options?.deliveryKey?.trim() || input.deliveryKey?.trim();
  const receiptNonce = deliveryKey ? `${RECEIPT_PREFIX}${deliveryKey}` : undefined;

  try {
    const committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        await lockThreadsForBackgroundTasks(tx, [run.threadId, preview.group.threadId]);
        await lockOwnedGroup(tx, { spaceId: run.spaceId, userId: run.userId }, preview.group.id);

        const sourceThread = await tx.thread.findFirst({
          where: {
            id: run.threadId,
            spaceId: run.spaceId,
            userId: run.userId,
            botId: run.botId,
          },
          select: { id: true, groupId: true },
        });
        if (!sourceThread || sourceThread.groupId) {
          return { ok: false as const, error: ERROR_NOT_DIRECT_CHAT };
        }
        const sourceRun = await tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            userId: run.userId,
            status: "running",
          },
          select: { id: true, orchestration: true },
        });
        if (!sourceRun) return { ok: false as const, error: ERROR_SOURCE_INACTIVE };

        if (receiptNonce) {
          const existing = await tx.message.findUnique({
            where: {
              threadId_clientNonce: {
                threadId: sourceThread.id,
                clientNonce: receiptNonce,
              },
            },
            select: { id: true, blocks: true },
          });
          const replay = existing
            ? await replayFromReceipt(deps.prisma, existing, sourceRun.id, run.botId)
            : null;
          if (replay) return replay;
          if (existing) return { ok: false as const, error: ERROR_INCOMPLETE };
        }

        const group = await tx.chatGroup.findFirst({
          where: {
            id: preview.group.id,
            spaceId: run.spaceId,
            userId: run.userId,
            kind: CHAT_GROUP_KIND_STANDARD,
            archivedAt: null,
            thread: { id: preview.group.threadId, spaceId: run.spaceId },
          },
          select: {
            id: true,
            name: true,
            thread: { select: { id: true } },
            members: {
              where: { botId: run.botId },
              select: {
                bot: {
                  select: { id: true, name: true, archivedAt: true, spaceId: true, userId: true },
                },
              },
            },
          },
        });
        if (!group?.thread) return { ok: false as const, error: ERROR_ARCHIVED_GROUP };
        const targetThreadId = group.thread.id;
        const member = group.members[0]?.bot;
        if (
          !member ||
          member.id !== sender.id ||
          member.archivedAt ||
          member.spaceId !== run.spaceId ||
          member.userId !== run.userId
        ) {
          return { ok: false as const, error: ERROR_NOT_MEMBER };
        }

        const topic = receiptTopic(input.topic, message);
        const targetBlock: MessageBlock = { kind: "text", text: message };
        const targetMessage = await createThreadMessageInTransaction(tx, {
          threadId: targetThreadId,
          role: "bot",
          originKind: "bot",
          blocks: [targetBlock],
          botId: run.botId,
          markUnread: true,
        });

        const locator = parseDestinationLocator({
          kind: "group_message",
          groupId: group.id,
          threadId: targetThreadId,
          messageId: targetMessage.id,
        });
        const receipt = parseCollaborationReceipt({
          kind: "collaboration_receipt",
          target: { kind: "group", groupId: group.id, threadId: targetThreadId },
          state: "sent",
          destination: locator,
          display: { groupName: group.name, topic },
        });
        const receiptBlock = receipt as MessageBlock;
        const receiptMessage = await createThreadMessageInTransaction(tx, {
          threadId: sourceThread.id,
          role: "bot",
          originKind: "bot",
          blocks: [receiptBlock],
          botId: run.botId,
          runId: sourceRun.id,
          clientNonce: receiptNonce,
          markUnread: false,
        });

        const task = await tx.task.create({
          data: {
            spaceId: run.spaceId,
            botId: run.botId,
            threadId: targetThreadId,
            userId: run.userId,
            prompt: message,
            status: "queued",
          },
          select: { id: true },
        });
        const lineage = collaborationFromOrchestration(sourceRun.orchestration);
        const nextRun = await tx.run.create({
          data: {
            spaceId: run.spaceId,
            botId: run.botId,
            threadId: targetThreadId,
            taskId: task.id,
            userId: run.userId,
            status: "queued",
            trigger: "message_group",
            sourceMessageId: targetMessage.id,
            originThreadId: sourceThread.id,
            originRunId: sourceRun.id,
            originMessageId: receiptMessage.id,
            orchestration: buildRunOrchestration({
              kind: "bot_message",
              ownerBotId: sender.id,
              responseMode: "single",
              ownershipMode: "owner",
              execution: turnExecutionForSource("chat"),
              collaboration: {
                role: "owner",
                source: "bot_message",
                fromBotId: sender.id,
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
          spaceId: run.spaceId,
          threadId: targetThreadId,
          botId: run.botId,
          type: "thread.message.created",
          runId: nextRun.id,
          payload: { messageId: targetMessage.id, role: "bot", blocks: [targetBlock] },
        });
        const receiptEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: sourceThread.id,
          botId: run.botId,
          type: "thread.message.created",
          runId: sourceRun.id,
          payload: { messageId: receiptMessage.id, role: "bot", blocks: [receiptBlock] },
        });
        await touchGroupUpdatedAt(tx, group.id);

        return {
          ok: true as const,
          groupId: group.id,
          groupName: group.name,
          targetRunId: nextRun.id,
          receiptMessageId: receiptMessage.id,
          locator,
          targetEventSeq: targetEvent.seq,
          receiptEventSeq: receiptEvent.seq,
        };
      }),
    );

    if (!committed.ok) return committed;
    if ("replayed" in committed && committed.replayed) return committed;

    await deps.events
      .notify(
        preview.group.threadId,
        "targetEventSeq" in committed ? committed.targetEventSeq : 0,
      )
      .catch((error) => getLogger().error("message group target notification", error));
    await deps.events
      .notify(run.threadId, "receiptEventSeq" in committed ? committed.receiptEventSeq : 0)
      .catch((error) => getLogger().error("message group receipt notification", error));
    await deps.jobs.enqueue(runContinueJob(committed.targetRunId)).catch((error) => {
      // The queued Run is durable; reconciliation repairs a missed wake.
      getLogger().error("message group enqueue", error);
    });

    return {
      ok: true,
      groupId: committed.groupId,
      groupName: committed.groupName,
      targetRunId: committed.targetRunId,
      receiptMessageId: committed.receiptMessageId,
      locator: committed.locator,
      note: `Posted this work in ${committed.groupName}. It runs there as a separate task; the result will come back to this chat when it finishes. Continue independent work and do not poll.`,
    };
  } catch (error) {
    if (receiptNonce && isUniqueConstraintError(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: {
          threadId_clientNonce: { threadId: run.threadId, clientNonce: receiptNonce },
        },
        select: { id: true, blocks: true },
      });
      const replay = winner
        ? await replayFromReceipt(deps.prisma, winner, run.id, run.botId)
        : null;
      if (replay) return replay;
    }
    if (error instanceof IsolationError) {
      return { ok: false, error: ERROR_GROUP_UNAVAILABLE };
    }
    throw error;
  }
}

async function resolveGroupPreview(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    groupId?: string;
    confirmName?: string;
  },
): Promise<{ ok: true; group: GroupPreview } | MessageGroupFailure> {
  if (input.groupId) {
    const group = await prisma.chatGroup.findFirst({
      where: {
        id: input.groupId,
        spaceId: input.spaceId,
        userId: input.userId,
        kind: CHAT_GROUP_KIND_STANDARD,
      },
      select: {
        id: true,
        name: true,
        archivedAt: true,
        thread: { select: { id: true } },
      },
    });
    if (!group) return { ok: false, error: ERROR_NO_GROUP };
    if (group.archivedAt) return { ok: false, error: ERROR_ARCHIVED_GROUP };
    if (!group.thread) return { ok: false, error: ERROR_GROUP_UNAVAILABLE };
    return { ok: true, group: { id: group.id, name: group.name, threadId: group.thread.id } };
  }

  const name = input.confirmName?.trim();
  if (!name) return { ok: false, error: ERROR_NO_GROUP };
  const groups = await prisma.chatGroup.findMany({
    where: {
      spaceId: input.spaceId,
      userId: input.userId,
      kind: CHAT_GROUP_KIND_STANDARD,
      archivedAt: null,
    },
    select: { id: true, name: true, thread: { select: { id: true } } },
  });
  const exact = groups.filter((group) => group.name === name);
  const matches =
    exact.length > 0
      ? exact
      : groups.filter((group) => group.name.toLowerCase() === name.toLowerCase());
  if (matches.length > 1) return { ok: false, error: ERROR_AMBIGUOUS_GROUP };
  const group = matches[0];
  if (!group?.thread) return { ok: false, error: ERROR_NO_GROUP };
  return { ok: true, group: { id: group.id, name: group.name, threadId: group.thread.id } };
}

function receiptTopic(raw: string | undefined, message: string): string {
  const explicit = raw?.trim();
  if (explicit) return explicit.slice(0, MAX_TOPIC_LENGTH);
  const first = message.split(/[。.!?！？\n]/)[0]?.trim() ?? "";
  return (first || "这项工作").slice(0, MAX_TOPIC_LENGTH);
}

function receiptFromBlocks(blocks: unknown): CollaborationReceipt | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (!block || typeof block !== "object" || (block as { kind?: unknown }).kind !== "collaboration_receipt") {
      continue;
    }
    try {
      return parseCollaborationReceipt(block);
    } catch {
      return null;
    }
  }
  return null;
}

async function replayFromReceipt(
  prisma: PrismaClient,
  message: { id: string; blocks: unknown },
  sourceRunId: string,
  botId: string,
): Promise<MessageGroupDelivery | null> {
  const receipt = receiptFromBlocks(message.blocks);
  if (!receipt || receipt.target.kind !== "group") return null;
  if (!receipt.destination) return null;
  const targetRun = await prisma.run.findFirst({
    where: {
      originMessageId: message.id,
      originRunId: sourceRunId,
      botId,
      trigger: "message_group",
    },
    select: { id: true },
  });
  if (!targetRun) return null;
  return {
    ok: true,
    replayed: true,
    groupId: receipt.target.groupId,
    groupName: receipt.display?.groupName ?? "this group",
    targetRunId: targetRun.id,
    receiptMessageId: message.id,
    locator: receipt.destination,
    note: "This delivery already happened; the same target task is still the one that owns the work.",
  };
}

/**
 * Return a `message_group` target Run's terminal state to its source chat.
 * Completed work also wakes the source Bot with a fresh owner Run that writes
 * the user-facing summary. Failed/cancelled work updates the same receipt and
 * keeps the target locator; it never fabricates a completion.
 */
export async function returnMessageGroupOutcome(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    status: string;
    error?: string | null;
    originThreadId?: string | null;
    originRunId?: string | null;
    originMessageId?: string | null;
    bot?: { name: string };
  },
  result: { text?: string } = {},
): Promise<boolean> {
  const originThreadId = run.originThreadId?.trim();
  const originRunId = run.originRunId?.trim();
  const originMessageId = run.originMessageId?.trim();
  if (!originThreadId || !originRunId || !originMessageId) return false;
  const status = normalizeTerminalStatus(run.status);
  if (!status) return false;

  let enqueuedRunId: string | null = null;
  try {
    const committed = await deps.prisma.$transaction(async (tx) => {
      const receiptMessage = await tx.message.findFirst({
        where: { id: originMessageId, threadId: originThreadId },
        select: { id: true, blocks: true, runId: true, threadId: true },
      });
      if (!receiptMessage) return { kind: "invalid" as const, error: "receipt missing" };
      const receipt = receiptFromBlocks(receiptMessage.blocks);
      if (!receipt || receipt.target.kind !== "group" || !receipt.destination) {
        return { kind: "invalid" as const, error: "receipt invalid" };
      }
      if (receipt.target.threadId !== run.threadId) {
        return { kind: "invalid" as const, error: "receipt target mismatch" };
      }
      const originSource = await tx.run.findFirst({
        where: {
          id: originRunId,
          threadId: originThreadId,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: run.botId,
        },
        select: { id: true, status: true, orchestration: true },
      });
      if (
        !originSource ||
        (receiptMessage.runId !== null && receiptMessage.runId !== originRunId)
      ) {
        return { kind: "invalid" as const, error: "origin mismatch" };
      }

      const claimed = await tx.run.updateMany({
        where: {
          id: run.id,
          botOutcomeReturnedAt: null,
          status: { in: ["completed", "failed", "cancelled"] },
        },
        data: { botOutcomeReturnedAt: new Date() },
      });
      if (claimed.count === 0) return { kind: "skipped" as const };

      const updatedBlocks = replaceReceiptState(receiptMessage.blocks, receipt, status);
      await tx.message.update({
        where: { id: receiptMessage.id },
        data: { blocks: updatedBlocks as Prisma.InputJsonValue },
      });
      const receiptEvent = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: originThreadId,
        botId: run.botId,
        type: "thread.message.updated",
        // The receipt stays attached to the Run that wrote it even if that Run
        // was cancelled while the target work was still in flight.
        runId: originSource.id,
        payload: { messageId: receiptMessage.id, role: "bot", blocks: updatedBlocks },
      });

      let summaryRunId: string | null = null;
      if (status === "completed" && originSource.status !== "cancelled" && result.text?.trim()) {
        await lockThreadsForBackgroundTasks(tx, [originThreadId]);
        const originTask = await tx.run.findUnique({
          where: { id: originRunId },
          select: { task: { select: { prompt: true } } },
        });
        const prompt = buildReturnPrompt({
          groupName: receipt.display?.groupName ?? "the target group",
          originalGoal: originTask?.task.prompt ?? "",
          resultText: result.text.trim(),
        });
        const task = await tx.task.create({
          data: {
            spaceId: run.spaceId,
            botId: run.botId,
            threadId: originThreadId,
            userId: run.userId,
            prompt,
            status: "queued",
          },
          select: { id: true },
        });
        const lineage = collaborationFromOrchestration(originSource.orchestration);
        const summaryRun = await tx.run.create({
          data: {
            spaceId: run.spaceId,
            botId: run.botId,
            threadId: originThreadId,
            taskId: task.id,
            userId: run.userId,
            status: "queued",
            trigger: "bot_message",
            clientNonce: `group-outcome:${run.id}`,
            originThreadId,
            originRunId: run.id,
            originMessageId: receiptMessage.id,
            orchestration: buildRunOrchestration({
              kind: "bot_message",
              ownerBotId: run.botId,
              responseMode: "single",
              ownershipMode: "owner",
              execution: turnExecutionForSource("chat"),
              collaboration: outcomeResumptionCollaboration({
                role: "owner",
                fromBotId: run.botId,
                parentRunId: run.id,
                handoffDepth: lineage?.handoffDepth ?? 0,
                messageHop: 0,
              }),
            }),
          },
          select: { id: true },
        });
        summaryRunId = summaryRun.id;
      }

      return {
        kind: "committed" as const,
        summaryRunId,
        receiptEventSeq: receiptEvent.seq,
      };
    });

    if (committed.kind !== "committed") {
      if (committed.kind === "invalid") {
        getLogger().error("message group outcome invalid", committed.error);
      }
      return false;
    }
    enqueuedRunId = committed.summaryRunId;
    await deps.events.notify(originThreadId, committed.receiptEventSeq).catch((error) => {
      getLogger().error("message group outcome notification", error);
    });
    if (enqueuedRunId) {
      await deps.jobs.enqueue(runContinueJob(enqueuedRunId)).catch((error) => {
        getLogger().error("message group summary enqueue", error);
      });
    }
    return true;
  } catch (error) {
    getLogger().error("message group outcome return", error);
    return false;
  }
}

function normalizeTerminalStatus(status: string): TerminalStatus | null {
  if (status === "completed" || status === "failed" || status === "cancelled") return status;
  return null;
}

function replaceReceiptState(
  blocks: unknown,
  receipt: CollaborationReceipt,
  status: TerminalStatus,
): MessageBlock[] {
  const before = Array.isArray(blocks) ? (blocks as MessageBlock[]) : [];
  return before.map((block) =>
    block.kind === "collaboration_receipt"
      ? ({ ...block, state: status === "failed" ? "failed" : status } as MessageBlock)
      : block,
  );
}

function buildReturnPrompt(input: {
  groupName: string;
  originalGoal: string;
  resultText: string;
}): string {
  return [
    `你刚在「${input.groupName}」里完成了用户在单聊里交办的工作。`,
    input.originalGoal ? `用户最初的目标：${input.originalGoal}` : "",
    "下面是从目标群带回来的结果：",
    `<group_result>${input.resultText}</group_result>`,
    "请在当前单聊里给用户一条面向原始目标的简短汇报：先给结论，再给必要的依据和下一步建议。使用用户最初目标所用的语言。不要逐条复制群里的过程消息，也不要提系统内部的处理细节。",
  ]
    .filter(Boolean)
    .join("\n");
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
