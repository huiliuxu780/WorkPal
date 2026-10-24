import { runContinueJob } from "@rakazo/adapter-kit";
import type { BotMessageIntent, MessageBlock } from "@rakazo/contracts";
import {
  ACK_LOOP_ERROR,
  BOT_MESSAGE_MAX_LENGTH,
  type BotId,
  botMessageContext,
  botMessageHopExhausted,
  buildBotMessageWakePrompt,
  buildRunOrchestration,
  type CollaborationDestination,
  type CollaborationRole,
  clampBotMessage,
  collaborationFromOrchestration,
  type DestinationLocator,
  DUPLICATE_MESSAGE_ERROR,
  isAcknowledgementLoop,
  nextBotMessageHop,
  type OrchestrationExecutionV1,
  outcomeResumptionCollaboration,
  parseCollaborationDestination,
  parseDestinationLocator,
  parseRunOrchestration,
  RoundtableFeatureDisabledError,
  resolveBotAddress,
  resolveRoundtableFeatureGates,
  type SpaceId,
  supportCollaboration,
  turnExecutionForSource,
  turnPolicySourceForTrigger,
  type UserId,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  CHAT_GROUP_KIND_AGENT_PAIR,
  createAgentPairRepository,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedStandardGroupThread,
  type Prisma,
  type PrismaClient,
  recordAgentPairMessageOrigin,
  touchGroupUpdatedAt,
  withTransactionRetry,
} from "@rakazo/db";

import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";
import { resolveVisibleOrigin } from "./run-origin.js";

/**
 * The hop the current run sits at, read back from the message that woke this
 * bot. A run a person started carries no bot message, so it starts at 0.
 */
export async function currentBotMessageHop(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
): Promise<number> {
  if (!sourceMessageId) return 0;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true },
  });
  const blocks = Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [];
  return botMessageContext(blocks)?.hop ?? 0;
}

export async function loadBotMessageContext(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
) {
  if (!sourceMessageId) return undefined;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true, replyTo: { select: { blocks: true } } },
  });
  const context = botMessageContext(
    Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [],
  );
  if (!context) return undefined;
  const replyBlocks = Array.isArray(source?.replyTo?.blocks)
    ? (source.replyTo.blocks as MessageBlock[])
    : [];
  const repliesToRequest = replyBlocks.some(
    (block) =>
      block.kind === "bot_message_sent" &&
      (block.intent === undefined || block.intent === "request" || block.intent === "question"),
  );
  return { ...context, repliesToRequest };
}

type PrivateSourceKind = "bot" | "agent_pair";

type PrivateMessageContext = {
  hop: number;
  sourceContext: Awaited<ReturnType<typeof loadBotMessageContext>>;
  sourceKind: PrivateSourceKind;
};

type PrivateTarget = {
  id: string;
  name: string;
  archivedAt: Date | null;
};

type PrivateRunOrigin = {
  threadId: string;
  runId: string;
  messageId: string;
};

type PrivateRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  sourceMessageId?: string | null;
  orchestration?: unknown;
  originThreadId?: string | null;
  originRunId?: string | null;
  originMessageId?: string | null;
};

type AgentPairRef = { groupId: string; threadId: string };

type PairDeliveryMode =
  | { kind: "request"; target: PrivateTarget; pair: AgentPairRef }
  | { kind: "origin_outcome"; target: PrivateTarget; origin: PrivateRunOrigin };

type PairDeliveryCommit =
  | {
      ok: true;
      replayed?: false;
      botId: string;
      name: string;
      targetRunId: string;
      receiptMessageId: string;
      pairThreadId: string;
      pairMessageId: string;
      /** Per-Thread cursors: events are only ordered inside their own Thread. */
      sourceEventSeq: number;
      pairEventSeq: number;
    }
  | { ok: true; replayed: true; botId: string; name: string; targetRunId: string }
  | { ok: false; error: string };

/** Persisted origin of a delegated Run; absent on user-started and legacy rows. */
function readRunOrigin(run: PrivateRun): PrivateRunOrigin | null {
  const threadId = run.originThreadId?.trim();
  const runId = run.originRunId?.trim();
  const messageId = run.originMessageId?.trim();
  if (!threadId || !runId || !messageId) return null;
  return { threadId, runId, messageId };
}

/** A terminal result/status addressed at the bot that woke this run. */
function isOutcomeReturn(input: {
  options?: { allowTerminalSource?: boolean };
  intent: BotMessageIntent;
  sourceContext: Awaited<ReturnType<typeof loadBotMessageContext>>;
  target: PrivateTarget;
}): boolean {
  return (
    input.options?.allowTerminalSource === true &&
    (input.intent === "result" || input.intent === "status") &&
    (input.sourceContext?.intent === undefined ||
      input.sourceContext.intent === "request" ||
      input.sourceContext.intent === "question") &&
    input.sourceContext?.fromBotId === input.target.id
  );
}

/**
 * Resolve a private target inside the current Space and user only. Archived
 * Bots stay distinguishable from a guessed or cross-workspace id: the latter
 * keeps the same opaque "no bot found" answer.
 */
async function resolvePrivateTarget(
  prisma: PrismaClient,
  run: PrivateRun,
  input: { bot_id?: string; confirm_name?: string },
): Promise<{ ok: true; target: PrivateTarget } | { ok: false; error: string }> {
  const select = { id: true, name: true, archivedAt: true } as const;
  const requestedId = input.bot_id?.trim();
  if (requestedId) {
    const found = await prisma.bot.findFirst({
      where: { id: requestedId, spaceId: run.spaceId, userId: run.userId },
      select,
    });
    if (!found) return { ok: false, error: "no bot found with that id or name" };
    if (found.archivedAt) return { ok: false, error: `${found.name} is no longer available` };
    return { ok: true, target: found };
  }
  const requestedName = input.confirm_name?.trim();
  if (!requestedName) return { ok: false, error: "target bot is required" };
  const bots = await prisma.bot.findMany({
    where: { spaceId: run.spaceId, userId: run.userId },
    select,
  });
  const exact = bots.filter((bot) => bot.name === requestedName);
  const matches =
    exact.length > 0
      ? exact
      : bots.filter((bot) => bot.name.toLowerCase() === requestedName.toLowerCase());
  if (matches.length > 1) {
    return { ok: false, error: `more than one bot is named ${requestedName}; use bot_id` };
  }
  const target = matches[0];
  if (!target) return { ok: false, error: "no bot found with that id or name" };
  if (target.archivedAt) return { ok: false, error: `${target.name} is no longer available` };
  return { ok: true, target };
}

async function lockThreadRows(tx: Prisma.TransactionClient, threadIds: readonly string[]) {
  for (const threadId of [...new Set(threadIds)].sort()) {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
  }
}

/**
 * Private `message_bot` delivery.
 *
 * A request writes a lightweight receipt into the source Thread and the full
 * collaboration (outbound request, inbound wake, Task, support Run) into the
 * fixed A ↔ B pair Thread. A delegated outcome returns through the origin the
 * requester persisted: the result is recorded in the pair Thread, the requester
 * is woken in its own visible Thread, and no second pair identity is invented.
 */
async function messageBotInAgentPair(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: PrivateRun,
  sender: { id: string; name: string },
  input: { message: string; intent: BotMessageIntent; deliveryKey?: string },
  context: PrivateMessageContext,
  mode: PairDeliveryMode,
): Promise<
  | {
      ok: true;
      botId: string;
      name: string;
      targetRunId: string;
      delivered: string;
      replayed?: true;
      note: string;
    }
  | { ok: false; error: string }
> {
  const deliveryKey = input.deliveryKey ? `bot-message:${input.deliveryKey}` : undefined;
  const receiptNonce = deliveryKey ? `receipt:${deliveryKey}` : undefined;
  const originMode = mode.kind === "origin_outcome" ? mode : null;
  const origin = originMode?.origin ?? null;
  const writesToOrigin = originMode !== null;
  const pairThreadId = mode.kind === "request" ? mode.pair.threadId : run.threadId;
  // Where the requester is woken: the pair for a request, the origin Thread for
  // a returned outcome. The receipt (when there is one) lives in run.threadId.
  const inboundThreadId = origin ? origin.threadId : pairThreadId;
  const sourceThreadId = origin ? origin.threadId : run.threadId;

  const replayFrom = (recorded: {
    id: string;
    sourceRuns: Array<{ id: string; botId: string; bot: { name: string } }>;
  }): PairDeliveryCommit => {
    const targetRun = recorded.sourceRuns[0];
    if (!targetRun) return { ok: false, error: "recorded private delivery is incomplete" };
    return {
      ok: true,
      replayed: true,
      botId: targetRun.botId,
      name: targetRun.bot.name,
      targetRunId: targetRun.id,
    };
  };

  let committed: PairDeliveryCommit;
  const deliver = () =>
    deps.prisma.$transaction(async (tx) => {
      await lockThreadRows(tx, [run.threadId, pairThreadId, inboundThreadId]);

      if (deliveryKey) {
        const recorded = await tx.message.findUnique({
          where: {
            threadId_clientNonce: { threadId: inboundThreadId, clientNonce: deliveryKey },
          },
          select: {
            id: true,
            sourceRuns: {
              orderBy: { createdAt: "asc" },
              take: 1,
              select: { id: true, botId: true, bot: { select: { name: true } } },
            },
          },
        });
        if (recorded) return replayFrom(recorded);
      }

      const activeSource = await tx.run.findFirst({
        where: {
          id: run.id,
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          userId: run.userId,
          // An origin return is the sanctioned reply path for BOTH the terminal
          // automatic outcome and a live explicit result/status, so the source
          // may still be running when it answers through the origin.
          status: writesToOrigin
            ? { in: ["completed", "failed", "running"] }
            : "running",
        },
        select: { id: true, orchestration: true },
      });
      if (!activeSource) return { ok: false as const, error: "source run is no longer active" };

      const sourceThread = await tx.thread.findFirst({
        where: writesToOrigin
          ? {
              id: run.threadId,
              spaceId: run.spaceId,
              userId: run.userId,
              group: {
                is: {
                  kind: CHAT_GROUP_KIND_AGENT_PAIR,
                  spaceId: run.spaceId,
                  userId: run.userId,
                },
              },
            }
          : context.sourceKind === "bot"
            ? { id: run.threadId, spaceId: run.spaceId, userId: run.userId, botId: run.botId }
            : {
                id: run.threadId,
                spaceId: run.spaceId,
                userId: run.userId,
                group: {
                  is: {
                    kind: CHAT_GROUP_KIND_AGENT_PAIR,
                    spaceId: run.spaceId,
                    userId: run.userId,
                  },
                },
              },
        select: { id: true },
      });
      if (!sourceThread) {
        return { ok: false as const, error: "source thread is no longer available" };
      }

      const pairGroup = await tx.chatGroup.findFirst({
        where: {
          spaceId: run.spaceId,
          userId: run.userId,
          kind: CHAT_GROUP_KIND_AGENT_PAIR,
          archivedAt: null,
          thread: { id: pairThreadId },
        },
        select: {
          id: true,
          members: {
            where: { botId: { in: [sender.id, mode.target.id] } },
            select: { botId: true },
          },
        },
      });
      if (pairGroup?.members.length !== 2) {
        return { ok: false as const, error: "pair thread is no longer available" };
      }

      let originVisible = false;
      if (origin) {
        const originThread = await tx.thread.findFirst({
          where: {
            id: origin.threadId,
            spaceId: run.spaceId,
            userId: run.userId,
            OR: [
              { botId: { not: null } },
              {
                group: {
                  is: {
                    kind: { in: ["standard", CHAT_GROUP_KIND_AGENT_PAIR] },
                    spaceId: run.spaceId,
                    userId: run.userId,
                  },
                },
              },
            ],
          },
          select: { id: true, group: { select: { kind: true } } },
        });
        const originRun = await tx.run.findFirst({
          where: {
            id: origin.runId,
            threadId: origin.threadId,
            spaceId: run.spaceId,
            userId: run.userId,
          },
          select: { id: true, sourceMessageId: true },
        });
        const originReceipt = await tx.message.findFirst({
          where: { id: origin.messageId, threadId: origin.threadId },
          select: { id: true, runId: true },
        });
        if (!originThread || !originRun || !originReceipt) {
          return { ok: false as const, error: "origin thread is no longer available" };
        }
        if (
          originRun.sourceMessageId !== originReceipt.id &&
          originRun.id !== originReceipt.runId
        ) {
          return {
            ok: false as const,
            error: "origin receipt does not belong to the requesting run",
          };
        }
        // Only a user-visible origin can authorize a human projection of the
        // pair Thread. A nested pair origin stays Agent-only.
        originVisible = originThread.group?.kind !== CHAT_GROUP_KIND_AGENT_PAIR;
      }

      const stillAddressable = await tx.bot.findFirst({
        where: {
          id: mode.target.id,
          spaceId: run.spaceId,
          userId: run.userId,
          archivedAt: null,
        },
        select: { id: true },
      });
      if (!stillAddressable) {
        return { ok: false as const, error: `${mode.target.name} is no longer available` };
      }

      if (!writesToOrigin) {
        if (botMessageHopExhausted(context.hop)) {
          return {
            ok: false as const,
            error:
              "bot-to-bot message limit reached for this chain; report back to the user instead of messaging another bot",
          };
        }
        if (
          isAcknowledgementLoop({
            wokeIntent: context.sourceContext?.intent,
            targetsWaker: context.sourceContext?.fromBotId === mode.target.id,
            intent: input.intent,
          })
        ) {
          return { ok: false as const, error: ACK_LOOP_ERROR };
        }
        const sentByThisRun = await tx.message.findMany({
          where: { runId: run.id },
          select: { blocks: true },
        });
        const duplicated = sentByThisRun.some((sent) =>
          (Array.isArray(sent.blocks) ? (sent.blocks as MessageBlock[]) : []).some(
            (block) =>
              block.kind === "bot_message_sent" &&
              block.toBotId === mode.target.id &&
              block.text.trim() === input.message,
          ),
        );
        if (duplicated) return { ok: false as const, error: DUPLICATE_MESSAGE_ERROR };
      }

      let resumptionRole: CollaborationRole = "support";
      let resumptionExecution: OrchestrationExecutionV1 = turnExecutionForSource("bot_message");
      let resumptionDepth: number | null = null;
      if (writesToOrigin && context.sourceContext?.returnToMessageId) {
        const outbound = await tx.message.findUnique({
          where: { id: context.sourceContext.returnToMessageId },
          select: { runId: true },
        });
        const requesterRun = outbound?.runId
          ? await tx.run.findUnique({
              where: { id: outbound.runId },
              select: { orchestration: true, trigger: true },
            })
          : null;
        if (requesterRun) {
          const snapshot = parseRunOrchestration(requesterRun.orchestration);
          resumptionRole =
            snapshot?.collaboration?.role ??
            snapshot?.ownership.mode ??
            (turnPolicySourceForTrigger(requesterRun.trigger) === "bot_message"
              ? "support"
              : "owner");
          resumptionExecution =
            snapshot?.execution ??
            turnExecutionForSource(resumptionRole === "support" ? "bot_message" : "chat");
          resumptionDepth = snapshot?.collaboration?.handoffDepth ?? null;
        }
      } else if (writesToOrigin && origin) {
        // A nested upstream return carries no request receipt in its immediate
        // source (the wake was a child's result): the requester's role lives on
        // the walked origin's source Run.
        const requesterRun = await tx.run.findUnique({
          where: { id: origin.runId },
          select: { orchestration: true, trigger: true },
        });
        if (requesterRun) {
          const snapshot = parseRunOrchestration(requesterRun.orchestration);
          resumptionRole =
            snapshot?.collaboration?.role ??
            snapshot?.ownership.mode ??
            (turnPolicySourceForTrigger(requesterRun.trigger) === "bot_message"
              ? "support"
              : "owner");
          resumptionExecution =
            snapshot?.execution ??
            turnExecutionForSource(resumptionRole === "support" ? "bot_message" : "chat");
          resumptionDepth = snapshot?.collaboration?.handoffDepth ?? null;
        }
      }

      const wakePrompt = buildBotMessageWakePrompt({
        from: sender,
        text: input.message,
        intent: input.intent,
      });
      const outboundBlock: MessageBlock = {
        kind: "bot_message_sent",
        toBotId: mode.target.id,
        toBotName: mode.target.name,
        text: input.message,
        intent: input.intent,
      };

      const outbound = await createThreadMessageInTransaction(tx, {
        threadId: pairThreadId,
        role: "bot",
        originKind: "bot",
        blocks: [outboundBlock],
        botId: sender.id,
        runId: run.id,
        // A returned outcome answers the request in the same pair Thread.
        replyToMessageId:
          origin && context.sourceContext?.returnToMessageId
            ? context.sourceContext.returnToMessageId
            : undefined,
        markUnread: false,
      });
      let receiptMessageId = origin?.messageId;
      const receiptBlock: MessageBlock = {
        kind: "bot_message_sent",
        toBotId: mode.target.id,
        toBotName: mode.target.name,
        text: "",
        intent: input.intent,
      };
      if (!writesToOrigin) {
        // The source Thread keeps only the fact that a private message was sent:
        // target identity and intent, never the collaboration body.
        const receipt = await createThreadMessageInTransaction(tx, {
          threadId: sourceThreadId,
          role: "bot",
          originKind: "bot",
          blocks: [receiptBlock],
          botId: sender.id,
          runId: run.id,
          clientNonce: receiptNonce,
          markUnread: false,
        });
        receiptMessageId = receipt.id;
      }
      if (!receiptMessageId) {
        return { ok: false as const, error: "private delivery receipt is missing" };
      }

      const inboundBlock: MessageBlock = {
        kind: "bot_message_received",
        fromBotId: sender.id,
        fromBotName: sender.name,
        text: input.message,
        hop: context.hop,
        intent: input.intent,
        returnToMessageId: outbound.id,
      };
      const inbound = await createThreadMessageInTransaction(tx, {
        threadId: inboundThreadId,
        role: "user",
        originKind: "bot",
        blocks: [inboundBlock],
        replyToMessageId:
          context.sourceContext?.fromBotId === mode.target.id &&
          input.intent !== "fyi" &&
          run.threadId === inboundThreadId
            ? context.sourceContext.returnToMessageId
            : undefined,
        clientNonce: deliveryKey,
        markUnread: true,
      });

      const task = await tx.task.create({
        data: {
          spaceId: run.spaceId,
          botId: mode.target.id,
          threadId: inboundThreadId,
          userId: run.userId,
          prompt: wakePrompt,
          status: "queued",
        },
      });
      const lineage = collaborationFromOrchestration(activeSource.orchestration);
      const lineageInput = {
        fromBotId: sender.id,
        parentRunId: run.id,
        handoffDepth: lineage?.handoffDepth ?? 0,
        messageHop: context.hop,
      };
      const collaboration = writesToOrigin
        ? outcomeResumptionCollaboration({
            role: resumptionRole,
            fromBotId: sender.id,
            parentRunId: run.id,
            handoffDepth: resumptionDepth ?? lineageInput.handoffDepth,
            messageHop: context.hop,
          })
        : supportCollaboration(lineageInput);
      const nextRun = await tx.run.create({
        data: {
          spaceId: run.spaceId,
          botId: mode.target.id,
          threadId: inboundThreadId,
          taskId: task.id,
          userId: run.userId,
          status: "queued",
          trigger: "bot_message",
          sourceMessageId: inbound.id,
          // The origin is durable routing data, never inferred from the latest
          // Thread. A result, cancel or approval can only return here.
          originThreadId: origin ? origin.threadId : run.threadId,
          originRunId: origin ? origin.runId : run.id,
          originMessageId: receiptMessageId,
          orchestration: buildRunOrchestration({
            kind: "bot_message",
            ownerBotId: mode.target.id,
            responseMode: "single",
            ownershipMode: writesToOrigin ? resumptionRole : "support",
            execution: writesToOrigin ? resumptionExecution : turnExecutionForSource("bot_message"),
            collaboration,
          }),
        },
        select: { id: true },
      });
      await tx.message.update({ where: { id: inbound.id }, data: { runId: nextRun.id } });

      const sourceOriginVisible =
        mode.kind === "request" ? context.sourceKind === "bot" : originVisible;
      if (sourceOriginVisible) {
        const originSourceThreadId = origin ? origin.threadId : run.threadId;
        const originSourceRunId = origin ? origin.runId : run.id;
        // Only the pair-side outbound is a pair message; a returned outcome's
        // inbound wake lives in the origin Thread.
        await recordAgentPairMessageOrigin(tx, {
          messageId: outbound.id,
          pairThreadId,
          sourceThreadId: originSourceThreadId,
          sourceRunId: originSourceRunId,
          sourceReceiptMessageId: receiptMessageId,
        });
        if (mode.kind === "request") {
          await recordAgentPairMessageOrigin(tx, {
            messageId: inbound.id,
            pairThreadId,
            sourceThreadId: originSourceThreadId,
            sourceRunId: originSourceRunId,
            sourceReceiptMessageId: receiptMessageId,
          });
        }
      }

      const inboundEvent = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: inboundThreadId,
        botId: mode.target.id,
        type: "thread.message.created",
        runId: nextRun.id,
        payload: { messageId: inbound.id, role: "user", blocks: [inboundBlock] },
      });
      const outboundEvent = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: pairThreadId,
        botId: sender.id,
        type: "thread.message.created",
        runId: run.id,
        payload: { messageId: outbound.id, role: "bot", blocks: [outboundBlock] },
      });
      let receiptEventSeq = 0;
      if (!writesToOrigin && receiptMessageId) {
        receiptEventSeq = (
          await appendEventInTransaction(tx, {
            spaceId: run.spaceId,
            threadId: sourceThreadId,
            botId: sender.id,
            type: "thread.message.created",
            runId: run.id,
            payload: {
              messageId: receiptMessageId,
              role: "bot",
              blocks: [receiptBlock],
            },
          })
        ).seq;
      }
      const collaborationEvent = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: inboundThreadId,
        botId: writesToOrigin ? mode.target.id : sender.id,
        type:
          input.intent === "result"
            ? "thread.collaboration.result"
            : "thread.collaboration.requested",
        runId: writesToOrigin ? nextRun.id : run.id,
        payload: {
          fromBotId: sender.id,
          toBotId: mode.target.id,
          fromRunId: run.id,
          toRunId: nextRun.id,
          intent: input.intent,
          handoffDepth: collaboration.handoffDepth,
        },
      });
      return {
        ok: true as const,
        botId: mode.target.id,
        name: mode.target.name,
        targetRunId: nextRun.id,
        receiptMessageId,
        pairThreadId,
        pairMessageId: outbound.id,
        // Cursors are per Thread: the receipt and the returned wake live in the
        // visible Thread, while the pair copy keeps its own independent cursor.
        sourceEventSeq: writesToOrigin
          ? Math.max(inboundEvent.seq, collaborationEvent.seq)
          : receiptEventSeq,
        pairEventSeq:
          mode.kind === "request"
            ? Math.max(inboundEvent.seq, outboundEvent.seq, collaborationEvent.seq)
            : outboundEvent.seq,
      };
    });

  try {
    committed = await withTransactionRetry(deliver);
  } catch (error) {
    if (deliveryKey && isUniqueConstraintError(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: inboundThreadId, clientNonce: deliveryKey } },
        select: {
          id: true,
          sourceRuns: {
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { id: true, botId: true, bot: { select: { name: true } } },
          },
        },
      });
      if (winner) committed = replayFrom(winner);
      else throw error;
    } else {
      throw error;
    }
  }
  if (!committed.ok) return committed;
  if (committed.replayed) {
    return {
      ok: true,
      replayed: true,
      botId: committed.botId,
      name: committed.name,
      targetRunId: committed.targetRunId,
      delivered: input.message,
      note: `Already sent privately to ${committed.name} in this turn; it was not sent again.`,
    };
  }

  await deps.events.notify(sourceThreadId, committed.sourceEventSeq).catch((error) => {
    getLogger().error("private pair realtime notification", error);
  });
  if (pairThreadId !== sourceThreadId) {
    await deps.events.notify(pairThreadId, committed.pairEventSeq).catch((error) => {
      getLogger().error("private pair thread notification", error);
    });
  }
  await deps.jobs.enqueue(runContinueJob(committed.targetRunId)).catch((error) => {
    // The queued run is durable; the job reconciler repairs a missed wake.
    getLogger().error("private pair enqueue", error);
  });
  return {
    ok: true,
    botId: committed.botId,
    name: committed.name,
    targetRunId: committed.targetRunId,
    delivered: input.message,
    note: `Sent privately to ${committed.name}. Delivery is async; a reply wakes you later as a new message. Continue independent work; send another update later only if it adds something new.`,
  };
}

export async function messageBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "roundtableFeatures">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
    /** Immutable Product Harness snapshot of the sending run (lineage source). */
    orchestration?: unknown;
    /** Persisted private-pair origin (null on user-started and legacy runs). */
    originThreadId?: string | null;
    originRunId?: string | null;
    originMessageId?: string | null;
  },
  sender: { id: string; name: string },
  input: {
    bot_id?: string;
    confirm_name?: string;
    message: string;
    intent?: BotMessageIntent;
    deliveryKey?: string;
  },
  options?: { allowTerminalSource?: boolean },
) {
  const message = String(input.message ?? "").trim();
  if (!message) return { ok: false as const, error: "message is required" };
  if (message.length > BOT_MESSAGE_MAX_LENGTH) {
    return {
      ok: false as const,
      error: `message exceeds the ${BOT_MESSAGE_MAX_LENGTH} character limit`,
    };
  }

  const sourceContext = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  const intent = input.intent ?? "request";
  const hop = nextBotMessageHop(sourceContext?.hop);

  const sourceThread = await deps.prisma.thread.findUnique({
    where: { id: run.threadId },
    select: { groupId: true, group: { select: { kind: true } } },
  });
  if (!sourceThread) {
    return { ok: false as const, error: "source thread is no longer available" };
  }
  const sourceKind: PrivateSourceKind | "group" = !sourceThread.groupId
    ? "bot"
    : sourceThread.group?.kind === CHAT_GROUP_KIND_AGENT_PAIR
      ? "agent_pair"
      : "group";
  if (sourceKind === "group") {
    if (!sourceThread.groupId) {
      return { ok: false as const, error: "source thread is no longer available" };
    }
    return messageBotInCurrentGroup(
      deps,
      run,
      sender,
      {
        bot_id: input.bot_id,
        confirm_name: input.confirm_name,
        message,
        intent,
        deliveryKey: input.deliveryKey,
      },
      { groupId: sourceThread.groupId, hop, sourceContext },
      options,
    );
  }

  const gates = deps.roundtableFeatures ?? resolveRoundtableFeatureGates({});
  const origin = readRunOrigin(run);
  const pairContext: PrivateMessageContext = { hop, sourceContext, sourceKind };
  if (options?.allowTerminalSource === true && origin) {
    // A verified origin reply is the only terminal-source exception: the run
    // answers the requester through the origin the requester persisted, never
    // through "the target's chat". Every other result/status — a proactive
    // send or a reply to a different bot — keeps the ordinary routing below,
    // so an enabled pair path never leaks into legacy DM delivery.
    const resolved = await resolvePrivateTarget(deps.prisma, run, input);
    if (!resolved.ok) return resolved;
    if (isOutcomeReturn({ options, intent, sourceContext, target: resolved.target })) {
      return messageBotInAgentPair(
        deps,
        run,
        sender,
        { message, intent, deliveryKey: input.deliveryKey },
        pairContext,
        { kind: "origin_outcome", origin, target: resolved.target },
      );
    }
    // Nested delegation: this run was resumed by a child's outcome, so its own
    // source wake carries intent result and the immediate check cannot see the
    // upstream requester. Walk the origin chain to the first visible Thread;
    // when the target is that chat's owner bot, return upstream through the
    // walked origin instead of opening another pair.
    if (intent === "result" || intent === "status") {
      const upstream = await resolveVisibleOrigin(deps.prisma, origin);
      if (upstream?.ownerBotId && upstream.ownerBotId === resolved.target.id) {
        return messageBotInAgentPair(
          deps,
          run,
          sender,
          { message, intent, deliveryKey: input.deliveryKey },
          pairContext,
          {
            kind: "origin_outcome",
            origin: {
              threadId: upstream.sourceThreadId,
              runId: upstream.sourceRunId,
              messageId: upstream.sourceMessageId,
            },
            target: resolved.target,
          },
        );
      }
    }
  }
  if (gates.private_pair === true) {
    const resolved = await resolvePrivateTarget(deps.prisma, run, input);
    if (!resolved.ok) return resolved;
    if (resolved.target.id === sender.id) {
      return { ok: false as const, error: "a bot cannot message itself" };
    }
    const pair = await createAgentPairRepository(deps.prisma, gates).getOrCreate({
      spaceId: run.spaceId as SpaceId,
      userId: run.userId as UserId,
      botAId: sender.id as BotId,
      botBId: resolved.target.id as BotId,
    });
    return messageBotInAgentPair(
      deps,
      run,
      sender,
      { message, intent, deliveryKey: input.deliveryKey },
      pairContext,
      { kind: "request", target: resolved.target, pair },
    );
  }
  // private_pair off: bot-level messaging keeps its pre-roundtable contract —
  // roster resolution with explicit refusals, delivered into the target's own
  // chat below. The gate only switches the pair-Thread delivery in; legacy
  // chains (no origin) and sanctioned replies keep finishing in the chat.

  const candidates = await deps.prisma.bot.findMany({
    where: { spaceId: run.spaceId, userId: run.userId, archivedAt: null },
    select: { id: true, name: true, title: true, thread: { select: { id: true } } },
  });
  const target = resolveBotAddress(candidates, {
    botId: input.bot_id,
    name: input.confirm_name,
  });
  if (!target) return { ok: false as const, error: "no bot found with that id or name" };
  if (target.id === sender.id) return { ok: false as const, error: "a bot cannot message itself" };
  if (!target.thread)
    return { ok: false as const, error: `${target.name} has no chat to deliver to` };
  const returnsToSender =
    options?.allowTerminalSource === true &&
    (intent === "result" || intent === "status") &&
    (sourceContext?.intent === undefined ||
      sourceContext.intent === "request" ||
      sourceContext.intent === "question") &&
    sourceContext?.fromBotId === target.id;
  if (botMessageHopExhausted(hop) && !returnsToSender) {
    return {
      ok: false as const,
      error:
        "bot-to-bot message limit reached for this chain; report back to the user instead of messaging another bot",
    };
  }
  // §15 anti-loop rules. The automatic outcome return is exempt: it is the
  // sanctioned path back to the requester, guarded by returnsToSender and its
  // per-run delivery key.
  if (!options?.allowTerminalSource) {
    if (
      isAcknowledgementLoop({
        wokeIntent: sourceContext?.intent,
        targetsWaker: sourceContext?.fromBotId === target.id,
        intent,
      })
    ) {
      return { ok: false as const, error: ACK_LOOP_ERROR };
    }
    const sentByThisRun = await deps.prisma.message.findMany({
      where: { threadId: run.threadId, runId: run.id },
      select: { blocks: true },
    });
    const duplicated = sentByThisRun.some((sent) =>
      (Array.isArray(sent.blocks) ? (sent.blocks as MessageBlock[]) : []).some(
        (block) =>
          block.kind === "bot_message_sent" &&
          block.toBotId === target.id &&
          block.text.trim() === message,
      ),
    );
    if (duplicated) return { ok: false as const, error: DUPLICATE_MESSAGE_ERROR };
  }

  const targetThreadId = target.thread.id;

  // A returned delegated outcome restores the requester's previous role and
  // execution policy — resolved from persisted Product Harness lineage, never
  // from prompt text or intent strings. Nested support requesters stay
  // support; only owners resume as owners. An unresolvable requester keeps
  // the safe support default (never a silent promotion).
  let resumptionRole: CollaborationRole = "support";
  let resumptionExecution: OrchestrationExecutionV1 = turnExecutionForSource("bot_message");
  let resumptionDepth: number | null = null;
  if (returnsToSender && sourceContext?.returnToMessageId) {
    const outbound = await deps.prisma.message.findUnique({
      where: { id: sourceContext.returnToMessageId },
      select: { runId: true },
    });
    const requesterRun = outbound?.runId
      ? await deps.prisma.run.findUnique({
          where: { id: outbound.runId },
          select: { orchestration: true, trigger: true },
        })
      : null;
    if (requesterRun) {
      const snapshot = parseRunOrchestration(requesterRun.orchestration);
      resumptionRole =
        snapshot?.collaboration?.role ??
        snapshot?.ownership.mode ??
        (turnPolicySourceForTrigger(requesterRun.trigger) === "bot_message" ? "support" : "owner");
      resumptionExecution =
        snapshot?.execution ??
        turnExecutionForSource(resumptionRole === "support" ? "bot_message" : "chat");
      resumptionDepth = snapshot?.collaboration?.handoffDepth ?? null;
    }
  }

  // A tool call can be re-executed after a lease expiry, so a delivery has to be
  // replayable: without this the recipient is messaged twice and woken twice.
  const deliveryKey = input.deliveryKey ? `bot-message:${input.deliveryKey}` : undefined;
  const replayed = () =>
    ({
      ok: true as const,
      botId: target.id,
      name: target.name,
      delivered: message,
      replayed: true as const,
      note: `Already sent to ${target.name} in this turn; it was not sent again.`,
    }) as const;

  const wakePrompt = buildBotMessageWakePrompt({ from: sender, text: message, intent });
  const outboundBlock: MessageBlock = {
    kind: "bot_message_sent",
    toBotId: target.id,
    toBotName: target.name,
    text: message,
    intent,
  };

  let committed:
    | {
        ok: true;
        runId: string;
        targetEventSeq: number;
        senderEventSeq: number;
      }
    | {
        ok: false;
        error: string;
      }
    | {
        ok: true;
        replayed: true;
      };
  try {
    committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        for (const threadId of [run.threadId, targetThreadId].sort()) {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        }
        // Claim the delivery key inside the transaction so a concurrent retry
        // either sees the winner or loses on the unique (threadId, clientNonce).
        if (deliveryKey) {
          const already = await tx.message.findUnique({
            where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
            select: { id: true },
          });
          if (already) return { ok: true as const, replayed: true as const };
        }

        const senderStillRunning = await tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            userId: run.userId,
            // allowTerminalSource covers the sanctioned reply paths: the
            // terminal automatic outcome and a live explicit result/status,
            // so a still-running source may answer its requester.
            status: options?.allowTerminalSource
              ? { in: ["completed", "failed", "running"] }
              : "running",
          },
          select: { id: true },
        });
        if (!senderStillRunning)
          return { ok: false as const, error: "source run is no longer active" };

        // Re-read the target inside the transaction: it can be archived between
        // resolving it above and committing here.
        const stillAddressable = await tx.bot.findFirst({
          where: {
            id: target.id,
            spaceId: run.spaceId,
            userId: run.userId,
            archivedAt: null,
          },
          select: { id: true },
        });
        if (!stillAddressable)
          return { ok: false as const, error: `${target.name} is no longer available` };

        // Echo into the sender's chat in the same transaction so a failed notify
        // cannot leave one side delivered and the other blank.
        const outbound = await createThreadMessageInTransaction(tx, {
          threadId: run.threadId,
          role: "bot",
          originKind: "bot",
          blocks: [outboundBlock],
          botId: run.botId,
          runId: run.id,
        });
        const inboundBlock: MessageBlock = {
          kind: "bot_message_received",
          fromBotId: sender.id,
          fromBotName: sender.name,
          text: message,
          hop,
          intent,
          returnToMessageId: outbound.id,
        };
        // This is the recipient's prompt, but it is still unread peer activity.
        const inbound = await createThreadMessageInTransaction(tx, {
          threadId: targetThreadId,
          role: "user",
          originKind: "bot",
          blocks: [inboundBlock],
          replyToMessageId:
            sourceContext?.fromBotId === target.id && intent !== "fyi"
              ? sourceContext.returnToMessageId
              : undefined,
          clientNonce: deliveryKey,
          markUnread: true,
        });
        const task = await tx.task.create({
          data: {
            spaceId: run.spaceId,
            botId: target.id,
            threadId: targetThreadId,
            userId: run.userId,
            prompt: wakePrompt,
            status: "queued",
          },
        });
        const lineage = collaborationFromOrchestration(run.orchestration);
        const lineageInput = {
          fromBotId: sender.id,
          parentRunId: run.id,
          handoffDepth: lineage?.handoffDepth ?? 0,
          messageHop: hop,
        };
        const collaboration = returnsToSender
          ? outcomeResumptionCollaboration({
              role: resumptionRole,
              fromBotId: sender.id,
              parentRunId: run.id,
              handoffDepth: resumptionDepth ?? lineageInput.handoffDepth,
              messageHop: hop,
            })
          : supportCollaboration(lineageInput);
        const nextRun = await tx.run.create({
          data: {
            spaceId: run.spaceId,
            botId: target.id,
            threadId: targetThreadId,
            taskId: task.id,
            userId: run.userId,
            status: "queued",
            trigger: "bot_message",
            sourceMessageId: inbound.id,
            // Support identity is Product Harness data, never prompt guesswork:
            // the snapshot pins role/source/lineage and the Phase 2 execution
            // policy for this delegated run.
            orchestration: buildRunOrchestration({
              kind: "bot_message",
              ownerBotId: target.id,
              responseMode: "single",
              ownershipMode: returnsToSender ? resumptionRole : "support",
              execution: returnsToSender
                ? resumptionExecution
                : turnExecutionForSource("bot_message"),
              collaboration,
            }),
          },
          select: { id: true },
        });
        await tx.message.update({ where: { id: inbound.id }, data: { runId: nextRun.id } });
        const inboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: targetThreadId,
          botId: target.id,
          type: "thread.message.created",
          runId: nextRun.id,
          payload: { messageId: inbound.id, role: "user", blocks: [inboundBlock] },
        });
        const outboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          type: "thread.message.created",
          runId: run.id,
          payload: { messageId: outbound.id, role: "bot", blocks: [outboundBlock] },
        });
        // Structured collaboration events for observability and the Phase 4
        // Activity UI (no chain-of-thought, routing metadata only). A request
        // is the SENDER's activity: it lives in the sender's thread on the
        // sender's run, so the delegating owner's live view shows "Asked X
        // for help". A result belongs to the thread it returns to.
        await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: returnsToSender ? targetThreadId : run.threadId,
          botId: returnsToSender ? target.id : run.botId,
          type:
            intent === "result" ? "thread.collaboration.result" : "thread.collaboration.requested",
          runId: returnsToSender ? nextRun.id : run.id,
          payload: {
            fromBotId: sender.id,
            toBotId: target.id,
            fromRunId: run.id,
            toRunId: nextRun.id,
            intent,
            handoffDepth: collaboration.handoffDepth,
          },
        });
        return {
          ok: true as const,
          runId: nextRun.id,
          targetEventSeq: inboundEvent.seq,
          senderEventSeq: outboundEvent.seq,
        };
      }),
    );
  } catch (error) {
    // Two concurrent retries can both miss the in-transaction lookup; the
    // loser hits the unique key. Treat that as a successful replay.
    if (deliveryKey && isUniqueConstraintError(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
        select: { id: true },
      });
      if (winner) return replayed();
    }
    throw error;
  }
  if ("replayed" in committed) return replayed();
  if (!committed.ok) return committed;

  await deps.events.notify(targetThreadId, committed.targetEventSeq).catch((error) => {
    getLogger().error("bot message realtime notification", error);
  });
  await deps.events.notify(run.threadId, committed.senderEventSeq).catch((error) => {
    getLogger().error("bot message sender echo notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    // The queued run is durable; the job reconciler repairs a missed wake.
    getLogger().error("bot message enqueue", error);
  });
  return {
    ok: true as const,
    botId: target.id,
    name: target.name,
    delivered: message,
    note: `Sent to ${target.name}. Delivery is async; a reply wakes you later as a new message. Continue independent work; send another update later only if it adds something new.`,
  };
}

type CurrentGroupMessageContext = {
  groupId: string;
  hop: number;
  sourceContext: Awaited<ReturnType<typeof loadBotMessageContext>>;
};

type PublicGroupDelivery = {
  botId: string;
  name: string;
  targetRunId: string;
  destination: CollaborationDestination;
  locator: DestinationLocator;
};

type PublicGroupCommit =
  | (PublicGroupDelivery & { ok: true; replayed?: false; eventSeq: number })
  | (PublicGroupDelivery & { ok: true; replayed: true })
  | { ok: false; error: string };

type RecordedPublicDelivery = {
  id: string;
  blocks: unknown;
  sourceRuns: Array<{ id: string; botId: string; bot: { name: string } }>;
};

/**
 * Public delegation stays in the source group Thread: the sender's message and
 * the target's inbound prompt are both facts of that Thread, and the support
 * Run executes there. Nothing is written into the target bot's DM.
 */
async function messageBotInCurrentGroup(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "roundtableFeatures">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
    orchestration?: unknown;
  },
  sender: { id: string; name: string },
  input: {
    bot_id?: string;
    confirm_name?: string;
    message: string;
    intent: BotMessageIntent;
    deliveryKey?: string;
  },
  context: CurrentGroupMessageContext,
  options?: { allowTerminalSource?: boolean },
): Promise<
  | (PublicGroupDelivery & {
      ok: true;
      replayed?: true;
      delivered: string;
      note: string;
    })
  | { ok: false; error: string }
> {
  // Existing delegated chains finish even after a rollout is closed; only a
  // new public delegation requires the gate.
  if (
    options?.allowTerminalSource !== true &&
    deps.roundtableFeatures?.public_collaboration !== true
  ) {
    throw new RoundtableFeatureDisabledError("public_collaboration");
  }

  const { groupId, hop, sourceContext } = context;
  const deliveryKey = input.deliveryKey ? `bot-message:${input.deliveryKey}` : undefined;
  const destination = parseCollaborationDestination({
    kind: "current_group",
    groupId,
    threadId: run.threadId,
  });
  const replayFromRecorded = (recorded: RecordedPublicDelivery): PublicGroupCommit => {
    const targetRun = recorded.sourceRuns[0];
    if (!targetRun) return { ok: false, error: "recorded public delivery is incomplete" };
    const recordedContext = botMessageContext(
      Array.isArray(recorded.blocks) ? (recorded.blocks as MessageBlock[]) : [],
    );
    return {
      ok: true,
      replayed: true,
      botId: targetRun.botId,
      name: targetRun.bot.name,
      targetRunId: targetRun.id,
      destination,
      locator: parseDestinationLocator({
        kind: "group_message",
        groupId,
        threadId: run.threadId,
        messageId:
          recordedContext?.returnToMessageId && recordedContext.returnToMessageId.length > 0
            ? recordedContext.returnToMessageId
            : recorded.id,
      }),
    };
  };

  let committed: PublicGroupCommit;
  const deliverPublicGroup = () =>
    deps.prisma.$transaction(async (tx) => {
      try {
        await lockOwnedStandardGroupThread(tx, run, {
          groupId,
          threadId: run.threadId,
        });
      } catch (error) {
        if (error instanceof IsolationError) {
          return { ok: false as const, error: "group is no longer available" };
        }
        throw error;
      }
      const [group, activeSource] = await Promise.all([
        tx.chatGroup.findFirst({
          where: {
            id: groupId,
            spaceId: run.spaceId,
            userId: run.userId,
            archivedAt: null,
            thread: { id: run.threadId },
          },
          include: {
            members: {
              include: {
                bot: {
                  select: {
                    id: true,
                    name: true,
                    archivedAt: true,
                    spaceId: true,
                    userId: true,
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        }),
        tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            userId: run.userId,
            // Same sanctioned-reply relaxation as the private paths: a live
            // explicit result/status answers its requester from a running run.
            status: options?.allowTerminalSource
              ? { in: ["completed", "failed", "running"] }
              : "running",
          },
          select: { id: true, orchestration: true },
        }),
      ]);
      if (!group || !activeSource) {
        return { ok: false as const, error: "source run is no longer active" };
      }

      const eligibleMember = (member: (typeof group.members)[number]) =>
        !member.bot.archivedAt &&
        member.bot.spaceId === run.spaceId &&
        member.bot.userId === run.userId;
      const sourceMember = group.members.find((member) => member.botId === run.botId);
      if (!sourceMember || !eligibleMember(sourceMember)) {
        return { ok: false as const, error: "source bot is no longer a group member" };
      }

      // Replays are resolved before membership revalidation: the delivery
      // already happened, so a later rename/removal must not duplicate it.
      if (deliveryKey) {
        const recorded = await tx.message.findUnique({
          where: { threadId_clientNonce: { threadId: run.threadId, clientNonce: deliveryKey } },
          select: {
            id: true,
            blocks: true,
            sourceRuns: {
              orderBy: { createdAt: "asc" },
              take: 1,
              select: { id: true, botId: true, bot: { select: { name: true } } },
            },
          },
        });
        if (recorded) return replayFromRecorded(recorded);
      }

      const eligibleMembers = group.members.filter(eligibleMember);
      const requestedId = input.bot_id?.trim();
      const requestedName = input.confirm_name?.trim();
      let targetMember: (typeof group.members)[number] | undefined;
      if (requestedId) {
        targetMember = eligibleMembers.find((member) => member.bot.id === requestedId);
        if (!targetMember) {
          const known = group.members.find((member) => member.bot.id === requestedId);
          return {
            ok: false as const,
            error: known
              ? `${known.bot.name} is not available in this group`
              : "target is not a current group member",
          };
        }
      } else if (requestedName) {
        const exact = eligibleMembers.filter((member) => member.bot.name === requestedName);
        const matches =
          exact.length > 0
            ? exact
            : eligibleMembers.filter(
                (member) => member.bot.name.toLowerCase() === requestedName.toLowerCase(),
              );
        if (matches.length > 1) {
          return {
            ok: false as const,
            error: `more than one group member is named ${requestedName}; use bot_id`,
          };
        }
        targetMember = matches[0];
        if (!targetMember) {
          const known = group.members.find(
            (member) => member.bot.name.toLowerCase() === requestedName.toLowerCase(),
          );
          return {
            ok: false as const,
            error: known
              ? `${known.bot.name} is not available in this group`
              : "target is not a current group member",
          };
        }
      } else {
        return { ok: false as const, error: "target bot is required" };
      }
      const target = targetMember.bot;
      if (target.id === run.botId) {
        return { ok: false as const, error: "a bot cannot message itself" };
      }

      const returnsToSender =
        options?.allowTerminalSource === true &&
        (input.intent === "result" || input.intent === "status") &&
        (sourceContext?.intent === undefined ||
          sourceContext.intent === "request" ||
          sourceContext.intent === "question") &&
        sourceContext?.fromBotId === target.id;
      if (botMessageHopExhausted(hop) && !returnsToSender) {
        return {
          ok: false as const,
          error:
            "bot-to-bot message limit reached for this chain; report back to the user instead of messaging another bot",
        };
      }
      if (!options?.allowTerminalSource) {
        if (
          isAcknowledgementLoop({
            wokeIntent: sourceContext?.intent,
            targetsWaker: sourceContext?.fromBotId === target.id,
            intent: input.intent,
          })
        ) {
          return { ok: false as const, error: ACK_LOOP_ERROR };
        }
        const sentByThisRun = await tx.message.findMany({
          where: { threadId: run.threadId, runId: run.id },
          select: { blocks: true },
        });
        const duplicated = sentByThisRun.some((sent) =>
          (Array.isArray(sent.blocks) ? (sent.blocks as MessageBlock[]) : []).some(
            (block) =>
              block.kind === "bot_message_sent" &&
              block.toBotId === target.id &&
              block.text.trim() === input.message,
          ),
        );
        if (duplicated) return { ok: false as const, error: DUPLICATE_MESSAGE_ERROR };
      }

      let resumptionRole: CollaborationRole = "support";
      let resumptionExecution: OrchestrationExecutionV1 = turnExecutionForSource("bot_message");
      let resumptionDepth: number | null = null;
      if (returnsToSender && sourceContext?.returnToMessageId) {
        const outbound = await tx.message.findUnique({
          where: { id: sourceContext.returnToMessageId },
          select: { runId: true },
        });
        const requesterRun = outbound?.runId
          ? await tx.run.findUnique({
              where: { id: outbound.runId },
              select: { orchestration: true, trigger: true },
            })
          : null;
        if (requesterRun) {
          const snapshot = parseRunOrchestration(requesterRun.orchestration);
          resumptionRole =
            snapshot?.collaboration?.role ??
            snapshot?.ownership.mode ??
            (turnPolicySourceForTrigger(requesterRun.trigger) === "bot_message"
              ? "support"
              : "owner");
          resumptionExecution =
            snapshot?.execution ??
            turnExecutionForSource(resumptionRole === "support" ? "bot_message" : "chat");
          resumptionDepth = snapshot?.collaboration?.handoffDepth ?? null;
        }
      }

      const wakePrompt = buildBotMessageWakePrompt({
        from: sender,
        text: input.message,
        intent: input.intent,
      });
      const outboundBlock: MessageBlock = {
        kind: "bot_message_sent",
        toBotId: target.id,
        toBotName: target.name,
        text: input.message,
        intent: input.intent,
      };
      const outbound = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        role: "bot",
        originKind: "bot",
        blocks: [outboundBlock],
        botId: run.botId,
        runId: run.id,
      });
      const inboundBlock: MessageBlock = {
        kind: "bot_message_received",
        fromBotId: sender.id,
        fromBotName: sender.name,
        text: input.message,
        hop,
        intent: input.intent,
        returnToMessageId: outbound.id,
      };
      const inbound = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        role: "user",
        originKind: "bot",
        blocks: [inboundBlock],
        replyToMessageId:
          sourceContext?.fromBotId === target.id && input.intent !== "fyi"
            ? sourceContext.returnToMessageId
            : undefined,
        clientNonce: deliveryKey,
      });
      const task = await tx.task.create({
        data: {
          spaceId: run.spaceId,
          botId: target.id,
          threadId: run.threadId,
          userId: run.userId,
          prompt: wakePrompt,
          status: "queued",
        },
      });
      const lineage = collaborationFromOrchestration(activeSource.orchestration);
      const lineageInput = {
        fromBotId: sender.id,
        parentRunId: run.id,
        handoffDepth: lineage?.handoffDepth ?? 0,
        messageHop: hop,
      };
      const collaboration = returnsToSender
        ? outcomeResumptionCollaboration({
            role: resumptionRole,
            fromBotId: sender.id,
            parentRunId: run.id,
            handoffDepth: resumptionDepth ?? lineageInput.handoffDepth,
            messageHop: hop,
          })
        : supportCollaboration(lineageInput);
      const nextRun = await tx.run.create({
        data: {
          spaceId: run.spaceId,
          botId: target.id,
          threadId: run.threadId,
          taskId: task.id,
          userId: run.userId,
          status: "queued",
          trigger: "bot_message",
          sourceMessageId: inbound.id,
          orchestration: buildRunOrchestration({
            kind: "bot_message",
            ownerBotId: target.id,
            responseMode: "single",
            ownershipMode: returnsToSender ? resumptionRole : "support",
            execution: returnsToSender
              ? resumptionExecution
              : turnExecutionForSource("bot_message"),
            collaboration,
          }),
        },
        select: { id: true },
      });
      await tx.message.update({ where: { id: inbound.id }, data: { runId: nextRun.id } });
      const inboundEvent = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: target.id,
        type: "thread.message.created",
        runId: nextRun.id,
        payload: { messageId: inbound.id, role: "user", blocks: [inboundBlock] },
      });
      const outboundEvent = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        type: "thread.message.created",
        runId: run.id,
        payload: { messageId: outbound.id, role: "bot", blocks: [outboundBlock] },
      });
      const collaborationEvent = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: returnsToSender ? target.id : run.botId,
        type:
          input.intent === "result"
            ? "thread.collaboration.result"
            : "thread.collaboration.requested",
        runId: returnsToSender ? nextRun.id : run.id,
        payload: {
          fromBotId: sender.id,
          toBotId: target.id,
          fromRunId: run.id,
          toRunId: nextRun.id,
          intent: input.intent,
          handoffDepth: collaboration.handoffDepth,
          destination: { kind: "current_group", groupId, threadId: run.threadId },
        },
      });
      await touchGroupUpdatedAt(tx, groupId);
      return {
        ok: true as const,
        botId: target.id,
        name: target.name,
        targetRunId: nextRun.id,
        destination,
        locator: parseDestinationLocator({
          kind: "group_message",
          groupId,
          threadId: run.threadId,
          messageId: outbound.id,
        }),
        eventSeq: Math.max(inboundEvent.seq, outboundEvent.seq, collaborationEvent.seq),
      };
    });
  try {
    committed = await withTransactionRetry(deliverPublicGroup);
  } catch (error) {
    if (deliveryKey && isUniqueConstraintError(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: run.threadId, clientNonce: deliveryKey } },
        select: {
          id: true,
          blocks: true,
          sourceRuns: {
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { id: true, botId: true, bot: { select: { name: true } } },
          },
        },
      });
      if (winner) committed = replayFromRecorded(winner);
      else throw error;
    } else {
      throw error;
    }
  }
  if (!committed.ok) return committed;
  if (committed.replayed) {
    return {
      ok: true,
      replayed: true,
      botId: committed.botId,
      name: committed.name,
      targetRunId: committed.targetRunId,
      destination: committed.destination,
      locator: committed.locator,
      delivered: input.message,
      note: `Already posted to ${committed.name} in this group; it was not sent again.`,
    };
  }

  await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("public collaboration realtime notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.targetRunId)).catch((error) => {
    getLogger().error("public collaboration enqueue", error);
  });
  return {
    ok: true,
    botId: committed.botId,
    name: committed.name,
    targetRunId: committed.targetRunId,
    destination: committed.destination,
    locator: committed.locator,
    delivered: input.message,
    note: `Posted publicly to ${committed.name} in this group. Delivery is async; the target replies from its own Run. Continue independent work; send another update later only if it adds something new.`,
  };
}

/** Return a delegated run's terminal outcome unless it already sent one explicitly. */
export async function returnBotMessageOutcome(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
    orchestration?: unknown;
    originThreadId?: string | null;
    originRunId?: string | null;
    originMessageId?: string | null;
  },
  sender: { id: string; name: string },
  text: string,
  intent: "result" | "status" = "result",
) {
  const source = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  if (!source) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    // Handled: nothing to deliver. Return true so callers do not release a reservation.
    return true;
  }
  const sourceIntent = source.intent ?? "request";
  // The reply target: the immediate waker for request/question sources. A run
  // resumed by a child's outcome has a result wake as its source — its own
  // requester lives upstream, found by walking the persisted origin chain to
  // the first visible Thread. No origin (legacy chain) stays handled silently.
  let replyTargetId = source.fromBotId;
  if (sourceIntent === "result" || sourceIntent === "status") {
    const origin = readRunOrigin(run);
    const upstream = origin ? await resolveVisibleOrigin(deps.prisma, origin) : null;
    if (!upstream?.ownerBotId) {
      await markBotOutcomeReturned(deps.prisma, run.id);
      return true;
    }
    replyTargetId = upstream.ownerBotId;
  }
  const sent = await deps.prisma.message.findMany({
    where: { threadId: run.threadId, runId: run.id },
    select: { blocks: true },
  });
  // Only an explicit result counts as a terminal outcome. Interim message_bot
  // status updates must not suppress the automatic final return.
  const alreadyReturned = sent.some((message) =>
    (Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : []).some(
      (block) =>
        block.kind === "bot_message_sent" &&
        block.toBotId === replyTargetId &&
        block.intent === "result",
    ),
  );
  if (alreadyReturned) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const outcome = await messageBot(
    deps,
    run,
    sender,
    {
      bot_id: replyTargetId,
      message: clampBotMessage(text),
      intent,
      // One key per run so status vs result (executor vs reconciler) cannot double-deliver.
      deliveryKey: `auto-outcome:${run.id}`,
    },
    { allowTerminalSource: true },
  );
  if (outcome.ok) await markBotOutcomeReturned(deps.prisma, run.id);
  return outcome.ok;
}

async function markBotOutcomeReturned(prisma: PrismaClient, runId: string) {
  await prisma.run.updateMany({
    where: {
      id: runId,
      status: { in: ["completed", "failed"] },
      botOutcomeReturnedAt: null,
    },
    data: { botOutcomeReturnedAt: new Date() },
  });
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
