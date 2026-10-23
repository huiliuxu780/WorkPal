import { runContinueJob } from "@rakazo/adapter-kit";
import type { BotMessageIntent, MessageBlock } from "@rakazo/contracts";
import {
  ACK_LOOP_ERROR,
  BOT_MESSAGE_MAX_LENGTH,
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
  supportCollaboration,
  turnExecutionForSource,
  turnPolicySourceForTrigger,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedStandardGroupThread,
  type PrismaClient,
  touchGroupUpdatedAt,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";

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
    select: { groupId: true },
  });
  if (sourceThread?.groupId) {
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
            status: options?.allowTerminalSource ? { in: ["completed", "failed"] } : "running",
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
            status: options?.allowTerminalSource ? { in: ["completed", "failed"] } : "running",
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
  if (sourceIntent !== "request" && sourceIntent !== "question") {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
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
        block.toBotId === source.fromBotId &&
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
      bot_id: source.fromBotId,
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
