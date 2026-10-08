import { runContinueJob } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import {
  botMessageHopExhausted,
  buildRunOrchestration,
  collaborationFromOrchestration,
  HANDOFF_BOUNCE_ERROR,
  HANDOFF_DEPTH_ERROR,
  handoffCollaboration,
  isHandoffBounceBack,
  MAX_HANDOFF_DEPTH,
  nextBotMessageHop,
  renderGroupMembersContext,
  turnExecutionForSource,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  type PrismaClient,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";

export async function handoffToGroupBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
  },
  groupId: string,
  input: { bot_id?: string; confirm_name?: string; message: string },
) {
  const deliveryKey = `group-handoff:${run.id}`;
  const committed = await deps.prisma.$transaction(async (tx) => {
    try {
      await lockOwnedGroup(tx, run, groupId);
    } catch (error) {
      if (error instanceof IsolationError)
        return { error: "group is no longer available" } as const;
      throw error;
    }
    const [group, activeSource] = await Promise.all([
      tx.chatGroup.findFirst({
        where: { id: groupId, archivedAt: null, thread: { id: run.threadId } },
        include: {
          members: {
            where: { bot: { archivedAt: null } },
            include: { bot: { select: { id: true, name: true } } },
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
          status: "running",
        },
        select: {
          id: true,
          orchestration: true,
          sourceMessage: { select: { blocks: true, seq: true } },
        },
      }),
    ]);
    if (!group || !activeSource) return { error: "source run is no longer active" } as const;
    if (!group.members.some((member) => member.bot.id === run.botId)) {
      return { error: "source bot is no longer a group member" } as const;
    }

    const existing = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId: run.threadId, clientNonce: deliveryKey } },
      select: {
        sourceRuns: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { id: true, botId: true },
        },
      },
    });
    if (existing) {
      const nextRun = existing.sourceRuns[0];
      const event = await tx.event.findFirst({
        where: { threadId: run.threadId, runId: run.id, type: "group.handoff" },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      if (!nextRun || !event) return { error: "recorded handoff is incomplete" } as const;
      return { ok: true, botId: nextRun.botId, runId: nextRun.id, eventSeq: event.seq } as const;
    }

    let targetId = input.bot_id?.trim();
    if (!targetId && input.confirm_name?.trim()) {
      const name = input.confirm_name.trim().toLowerCase();
      targetId = group.members.find((member) => member.bot.name.toLowerCase() === name)?.bot.id;
    }
    if (!targetId) return { error: "handoff target bot is required" } as const;
    if (targetId === run.botId) return { error: "cannot hand off to yourself" } as const;
    if (!group.members.some((member) => member.bot.id === targetId)) {
      return { error: "handoff target is not a group member" } as const;
    }

    let sourceBlocks: MessageBlock[] = [];
    if (activeSource.sourceMessage) {
      const parsedSource = MessageBlock.array().safeParse(activeSource.sourceMessage.blocks);
      if (!parsedSource.success) {
        return { error: "cannot verify the group handoff chain" } as const;
      }
      sourceBlocks = parsedSource.data;
    }
    const sourceHandoff = sourceBlocks.find(
      (block): block is Extract<MessageBlock, { kind: "handoff" }> => block.kind === "handoff",
    );
    // §14 bounce-back: the lineage snapshot is authoritative; the handoff
    // block is the pre-Phase-3 fallback. A genuine new user instruction after
    // the handoff releases the rule.
    const lineage = collaborationFromOrchestration(activeSource.orchestration);
    const bouncedFrom = lineage?.fromBotId ?? sourceHandoff?.fromBotId ?? null;
    let hasNewUserInstruction = false;
    if (bouncedFrom === targetId && activeSource.sourceMessage) {
      const newer = await tx.message.findFirst({
        where: {
          threadId: run.threadId,
          role: "user",
          seq: { gt: activeSource.sourceMessage.seq },
        },
        select: { id: true },
      });
      hasNewUserInstruction = Boolean(newer);
    }
    if (isHandoffBounceBack({ targetBotId: targetId, fromBotId: bouncedFrom, hasNewUserInstruction })) {
      return { error: HANDOFF_BOUNCE_ERROR } as const;
    }
    // §13 hard ownership-transfer budget per user turn: Alice→Bob is depth 1,
    // Bob→Charlie depth 2, a third transfer is a tool error, not a prompt hint.
    const currentDepth = lineage?.handoffDepth ?? sourceHandoff?.hop ?? 0;
    const handoffDepth = currentDepth + 1;
    if (handoffDepth > MAX_HANDOFF_DEPTH) {
      return { error: HANDOFF_DEPTH_ERROR } as const;
    }
    const hop = nextBotMessageHop(sourceHandoff?.hop);
    if (botMessageHopExhausted(hop)) {
      return {
        error:
          "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
      } as const;
    }

    const handoffBlock: MessageBlock = {
      kind: "handoff",
      fromBotId: run.botId,
      toBotId: targetId,
      text: input.message,
      hop,
    };
    const message = await createThreadMessageInTransaction(tx, {
      threadId: run.threadId,
      role: "bot",
      blocks: [handoffBlock],
      botId: run.botId,
      runId: run.id,
      clientNonce: deliveryKey,
    });
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: targetId,
        threadId: run.threadId,
        userId: run.userId,
        prompt: input.message,
        status: "queued",
      },
    });
    const nextRun = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: targetId,
        threadId: run.threadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: "follow_up",
        sourceMessageId: message.id,
        // §11: the target run is the NEW OWNER of this stage; the snapshot
        // carries the lineage and the owner-grade execution policy.
        orchestration: buildRunOrchestration({
          kind: "handoff",
          ownerBotId: targetId,
          responseMode: "single",
          execution: turnExecutionForSource("handoff"),
          collaboration: handoffCollaboration({
            fromBotId: run.botId,
            parentRunId: run.id,
            handoffDepth,
          }),
        }),
      },
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "group.handoff",
      runId: run.id,
      payload: {
        messageId: message.id,
        fromBotId: run.botId,
        toBotId: targetId,
        text: input.message,
      },
    });
    // §11/§25 structured ownership-transfer event (Phase 4 consumes this).
    await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: targetId,
      type: "thread.turn.handed_off",
      runId: nextRun.id,
      payload: {
        fromBotId: run.botId,
        toBotId: targetId,
        fromRunId: run.id,
        toRunId: nextRun.id,
        handoffDepth,
      },
    });
    await touchGroupUpdatedAt(tx, groupId);
    return { ok: true, botId: targetId, runId: nextRun.id, eventSeq: event.seq } as const;
  });
  if ("error" in committed) return committed;
  await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("group handoff realtime notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    // The queued run is durable and the job reconciler will repair a missed immediate wake.
    getLogger().error("group handoff enqueue", error);
  });
  return {
    ok: true,
    botId: committed.botId,
    runId: committed.runId,
    note: "Handoff recorded. End this turn without narrating it; the next bot owns the next stage.",
  };
}

export async function loadGroupContext(
  prisma: PrismaClient,
  groupId: string,
  self: { id: string; name: string },
): Promise<string | undefined> {
  const group = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: {
          bot: { select: { id: true, name: true, title: true, description: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!group) return undefined;
  return renderGroupMembersContext(
    group.name,
    group.members.map((member) => member.bot),
    self,
  );
}
