import { randomUUID } from "node:crypto";
import type { RealtimeFanout } from "@rakazo/adapter-kit";
import {
  assertProductEventPayload,
  type BotSecretDestination,
  encodeLoginSecret,
  LoginSecretValue,
  type MessageBlock,
  MessageBlock as MessageBlockSchema,
  type MessageOriginKind,
  type PlanReviewSource,
  type ProductEvent,
} from "@rakazo/contracts";
import {
  authorizeInterventionPresentation,
  BUDGET_ACTIONS,
  blocksToAgentHistoryText,
  budgetAskCheckpoint,
  callIdFromClientNonce,
  decideMessageRoute,
  increasedBudgetForViolation,
  isApprovalAskBlock,
  isConversationalRun,
  isSecretAskBlock,
  messagingChannelId,
  parseBudgetAskCheckpoint,
  RoundtableContractError,
  type RoundtableFeatureGates,
  resolveAskChoice,
  resolveInterventionThreads,
  resolveRoundtableFeatureGates,
  sanitizeJsonValue,
  turnPolicyFromRun,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { CHAT_GROUP_KIND_STANDARD } from "./agent-pairs.js";
import type { Prisma, PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { enqueueDeliveryInTransaction } from "./delivery-records.js";
import { assertActiveExecutionFence } from "./execution-fence.js";
import {
  assertSafeClientSubmissionId,
  emitInterventionCreated,
  findOrdinaryTextAsks,
  INTERVENTION_WAIT_MS,
  InterventionRejected,
  insertPausedIntervention,
  interventionStore,
  legacyMessageId,
  type ResolveInterventionOutcome,
  resolveInterventionInTransaction,
  settleAnsweredIntervention,
  settleMembershipIntervention,
} from "./interventions.js";
import { lockInterventionThreads } from "./locks.js";
import { invalidateThreadMemoryEvidence } from "./memory-facts.js";
import {
  assertRunCanWriteHistory,
  assertRunIsCancelled,
  createThreadMessageInTransaction,
  RunHistoryWriteError,
} from "./messages.js";
import { IsolationError } from "./scope.js";
import { appendTaskAmendmentInTransaction } from "./task-instructions.js";
import { withTransactionRetry } from "./transaction-retry.js";

const EVENT_BATCH_SIZE = 200;
const PUSH_CATCH_UP_MS = 30_000;
const POLL_ONLY_CATCH_UP_MS = 400;

export interface AppendEventInput {
  spaceId: string;
  threadId: string;
  botId: string;
  type: ProductEvent["type"];
  payload: Record<string, unknown>;
  runId?: string;
  /** Typed cancel outcome only. Lets the cancelled owner write its one outcome. */
  allowTypedCancel?: boolean;
  schemaVersion?: number;
  causationId?: string;
  parentRunId?: string;
  /**
   * Require this Run's current execution lease in the same transaction.
   * Execution facts (for example agent.tool.called) use it so a worker that
   * lost the Run cannot persist a start fact a retry policy might trust.
   */
  execution?: { leaseOwner: string; leaseFence: number };
}

export interface ThreadEvents {
  answerRunInput(input: AnswerRunInput): Promise<boolean>;
  resolveIntervention(input: ResolveInterventionInput): Promise<ResolveInterventionOutcome>;
  append(input: AppendEventInput): Promise<ProductEvent>;
  claimSteering(input: ClaimSteeringInput): Promise<ClaimedSteeringMessage[]>;
  clearThread(input: ClearThreadInput): Promise<ClearThreadResult>;
  finalizeComputerControlRelease(
    input: FinalizeComputerControlReleaseInput,
  ): Promise<FinalizeComputerControlReleaseResult | false>;
  finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult | false>;
  notify(threadId: string, seq: number): Promise<void>;
  pauseRunForInput(input: PauseRunForInput): Promise<boolean>;
  pauseRunForGroupMembership(
    input: PauseRunForGroupMembershipInput,
  ): Promise<PauseRunForGroupMembershipResult>;
  pauseRunForTakeover(input: PauseRunForTakeover): Promise<boolean>;
  sendUserMessage(input: SendUserMessageInput): Promise<SendUserMessageResult>;
  follow(threadId: string, cursor: number, signal?: AbortSignal): AsyncGenerator<ProductEvent>;
}

export interface ClearThreadInput {
  spaceId: string;
  threadId: string;
  /** Event author and the bot-scoped target for one-to-one chats. */
  botId: string;
  groupId?: string;
}

export interface ClearThreadResult {
  event: ProductEvent;
  cancelledRunIds: string[];
  historyCompactionGeneration: number;
}

export interface FinalizeComputerControlReleaseInput {
  spaceId: string;
  computerId: string;
  botId: string;
  runId: string | null;
  leaseId: string;
  holder: "bot" | "none";
  reason: "done" | "expired" | "released" | "skipped";
}

export interface FinalizeComputerControlReleaseResult {
  runId: string | null;
}

export interface ClaimSteeringInput {
  threadId: string;
  botId: string;
  runId: string;
  leaseOwner: string;
  leaseFence: number;
  seenIds: string[];
}

export interface ClaimedSteeringMessage {
  id: string;
  messageId: string;
  text: string;
  blocks: MessageBlock[];
}

export interface FinalizeRunResult {
  continuationRunId: string | null;
}

interface FinalizeRunBase {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  taskId: string;
  /** Null only for an expired lease that was lost before its Attempt row was inserted. */
  attemptId: string | null;
  leaseOwner: string;
  leaseFence: number;
  /** Recovery only: refuse to end a Run if its original worker renewed the lease. */
  requireLeaseExpiredAt?: Date;
}

export type FinalizeRunInput = FinalizeRunBase &
  (
    | {
        outcome: "completed";
        blocks: MessageBlock[];
        markUnread?: boolean;
      }
    | {
        outcome: "failed";
        error: string;
        budgetExceeded?: {
          reason: "tokens" | "cost_usd" | "duration_sec" | "tool_calls";
          limit: number;
        };
        /** User-visible explanation for a typed failure such as permission_revoked. */
        blocks?: MessageBlock[];
        markUnread?: boolean;
      }
  );

export interface PauseRunForInput {
  spaceId: string;
  /** Thread of the pausing Run. It holds the ask Message and is resumed. */
  threadId: string;
  /**
   * Thread the user answers from, when the Run executes somewhere the user must
   * not write to (a fixed Agent pair). Requires `origin` and the `private_pair`
   * capability; without both the pause fails instead of publishing the wait into
   * a Thread the collaboration was never anchored in. Defaults to `threadId`.
   */
  presentationThreadId?: string;
  /**
   * CollaborationOrigin anchoring a cross-Thread wait to its visible source.
   * Typed as `unknown` on purpose: it arrives from persisted Run lineage, so the
   * core resolver parses it rather than trusting a caller-shaped object.
   */
  origin?: unknown;
  /** Deployment gates; absent means every roundtable capability is off. */
  gates?: RoundtableFeatureGates;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  /**
   * RT-26: the chat admission fence and suspension key of the Attempt that
   * creates this pending request. A later checkpoint may only claim this card
   * when all three executions bindings match, so one Run cannot answer another.
   */
  executionFence?: number;
  suspensionKey?: string;
  blocks: MessageBlock[];
  /**
   * Unredacted choice actions for resume. Persisted only on the run checkpoint
   * (not in message blocks) so clients still see redacted labels.
   */
  offeredActions?: Array<{ id: string; label: string }>;
  /** Predecessor ExternalEffect id for a manual-retry uncertain-result choice. */
  manualRetryEffectId?: string;
  budgetExceeded?: {
    reason: "tokens" | "cost_usd" | "duration_sec" | "tool_calls";
    limit: number;
    observed: number;
  };
  /**
   * UX-02: pair the pending plan review round with the plan_review
   * Intervention created by this pause and emit plan.review_submitted. The
   * round row was created (pending) by the unified plan service before this
   * pause; a crash in between is repaired at the next attempt start.
   */
  planReviewRound?: {
    roundId: string;
    planId: string;
    contentVersion: number;
    revision: number;
    source: PlanReviewSource;
  };
}

/**
 * RT-12: pause the source Run on a scoped "join the group and continue"
 * request. The request row, the Intervention and the card Message commit
 * together; no target-group write happens before the decision.
 */
export interface PauseRunForGroupMembershipInput {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  executionFence?: number;
  suspensionKey?: string;
  gates?: RoundtableFeatureGates;
  groupId: string;
  botName: string;
  /** Original redacted message_group content; never regenerated after approval. */
  message: string;
  topic?: string | null;
  deliveryKey: string;
}

export type PauseRunForGroupMembershipResult =
  | {
      outcome: "paused";
      requestId: string;
      interventionId: string;
      messageId: string;
      expiresAt: string;
    }
  | { outcome: "already_member" }
  | { outcome: "not_manageable" }
  | { outcome: "unavailable" }
  | { outcome: "run_not_running" };

const CHOICE_ASK_CHECKPOINT_KIND = "choice_ask_v1";

function choiceAskCheckpoint(
  actions: Array<{ id: string; label: string }>,
  extra?: { manualRetryEffectId?: string },
): string {
  return JSON.stringify({
    kind: CHOICE_ASK_CHECKPOINT_KIND,
    actions,
    ...(extra?.manualRetryEffectId ? { manualRetryEffectId: extra.manualRetryEffectId } : {}),
  });
}

function manualRetryEffectIdFromCheckpoint(checkpoint: string | null | undefined): string | null {
  if (!checkpoint) return null;
  try {
    const parsed = JSON.parse(checkpoint) as { kind?: unknown; manualRetryEffectId?: unknown };
    if (parsed.kind !== CHOICE_ASK_CHECKPOINT_KIND) return null;
    return typeof parsed.manualRetryEffectId === "string" && parsed.manualRetryEffectId
      ? parsed.manualRetryEffectId
      : null;
  } catch {
    return null;
  }
}

export interface PauseRunForTakeover {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  reason: string;
  /** Computer that should expose the pending takeover to the UI via controlRunId. */
  computerId: string;
  /**
   * RT-05F: user-visible Thread a delegated run's takeover request must be
   * presented in. The run keeps waiting in its execution Thread; the waiting
   * event and realtime wake go where the user can see them.
   */
  presentationThreadId?: string;
}

export interface AnswerRunInput {
  spaceId: string;
  /** Thread of the Run being answered: it holds the ask Message and resumes. */
  threadId: string;
  /**
   * Thread the user answered from when it is not the Run's own — an origin-aware
   * Intervention whose card is projected into the Thread that started the work.
   * Defaults to `threadId`.
   */
  presentationThreadId?: string;
  runId: string;
  messageId: string;
  /**
   * User Message created by the send flow that carried this answer. When set,
   * the amendment reuses it; when absent, commitAnswerRunInput appends a user
   * Message in the same transaction. The mutable Bot ask card is never a source.
   */
  answerMessageId?: string;
  answeredByUserId: string;
  answer: string;
  /** Only for a login card; `answer` carries its password. */
  username?: string;
  /** Opaque retry key. Never the answer or a hash of the answer. */
  clientSubmissionId?: string;
  /**
   * Only for a plan_review card: required concrete feedback for
   * `request_changes`, optional rejection reason for `reject`.
   */
  feedback?: string;
}

export interface ResolveInterventionInput {
  spaceId: string;
  /** Thread the submission is addressed at: the card's presentation Thread. */
  threadId: string;
  interventionId: string;
  clientSubmissionId: string;
  answeredByUserId: string;
  answer: string;
  username?: string;
  feedback?: string;
  /** A10: the outbound draft revision and fingerprint the user confirmed. */
  outbound?: { revision: number; fingerprint: string };
  /** RT-12: the bound message_group request revision the card showed. */
  requestRevision?: number;
  /** Deployment gates; absent means every roundtable capability is off. */
  gates?: RoundtableFeatureGates;
}

const INTERVENTION_TRANSACTION = { timeout: 20_000, maxWait: 20_000 };

/** Fail closed: a caller that wires no gates gets no cross-Thread behaviour. */
const ROUNDTABLE_GATES_DISABLED = resolveRoundtableFeatureGates({});

export interface SendUserMessageInput {
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  /** Trusted entry point classification; the owning userId is not necessarily the author. */
  originKind?: MessageOriginKind;
  authorUserId?: string | null;
  blocks: MessageBlock[];
  prompt: string;
  trigger: "user" | "follow_up" | "webhook" | "messaging";
  clientNonce?: string;
  linkMessageToRun?: boolean;
  /** When false, persist the user message without starting a run (team-chat transcript). */
  createRun?: boolean;
  /** When true, start a new run even if the bot is already busy (team-chat delivery). */
  allowParallelRun?: boolean;
}

export interface SendUserMessageResult {
  messageId: string;
  seq: number;
  taskId: string | null;
  runId: string | null;
}

export interface RunSecretWriter {
  store(input: {
    botId: string;
    credential?: BotSecretDestination;
    runId: string;
    userId: string;
    spaceId: string;
    plaintext: string;
    tx: Prisma.TransactionClient;
  }): Promise<void>;
}

export function createThreadEvents(
  prisma: PrismaClient,
  realtime?: RealtimeFanout,
  options: {
    catchUpMs?: number;
    runSecretWriter?: RunSecretWriter;
    /** Process-wide roundtable gates; absent means every capability is off. */
    roundtableFeatures?: RoundtableFeatureGates;
    /** RT-12: the unified card surface must exist before membership waits are created. */
    cardsUnifiedV2?: boolean;
  } = {},
): ThreadEvents {
  const gates = options.roundtableFeatures ?? ROUNDTABLE_GATES_DISABLED;
  return {
    answerRunInput: (input) => answerRunInput(prisma, input, realtime, options.runSecretWriter),
    resolveIntervention: (input) =>
      resolveIntervention(
        prisma,
        { ...input, gates: input.gates ?? gates },
        realtime,
        options.runSecretWriter,
        { cardsUnifiedV2: options.cardsUnifiedV2 === true },
      ),
    append: (input) => appendEvent(prisma, input, realtime),
    claimSteering: (input) => claimSteering(prisma, input),
    clearThread: (input) => clearThread(prisma, input, realtime),
    finalizeComputerControlRelease: (input) =>
      finalizeComputerControlRelease(prisma, input, realtime),
    finalizeRun: (input) => finalizeRun(prisma, input, realtime),
    notify: (threadId, seq) => notifyRealtime(realtime, threadId, seq),
    pauseRunForInput: (input) =>
      pauseRunForInput(prisma, { ...input, gates: input.gates ?? gates }, realtime),
    pauseRunForGroupMembership: (input) =>
      pauseRunForGroupMembership(prisma, { ...input, gates: input.gates ?? gates }, realtime),
    pauseRunForTakeover: (input) => pauseRunForTakeover(prisma, input, realtime),
    sendUserMessage: (input) => sendUserMessage(prisma, input, realtime),
    follow: (threadId, cursor, signal) =>
      followThreadEvents(prisma, threadId, cursor, realtime, signal, options.catchUpMs),
  };
}

export async function clearThread(
  prisma: PrismaClient,
  input: ClearThreadInput,
  realtime?: RealtimeFanout,
): Promise<ClearThreadResult> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (input.groupId) {
      // Clear is a standard-group mutation even though it is addressed by thread:
      // the groupId path updates chat_groups and reaches every message/run below.
      const group = await tx.chatGroup.findFirst({
        where: {
          id: input.groupId,
          spaceId: input.spaceId,
          kind: CHAT_GROUP_KIND_STANDARD,
          thread: { id: input.threadId },
        },
        select: { id: true },
      });
      if (!group) throw new IsolationError();
    }
    const thread = await tx.thread.update({
      where: {
        id: input.threadId,
        spaceId: input.spaceId,
        ...(input.groupId ? { groupId: input.groupId } : { botId: input.botId }),
      },
      data: { unread: false },
      select: { nextMessageSeq: true, historyCompactionGeneration: true },
    });
    const activeRuns = await tx.run.findMany({
      where: {
        spaceId: input.spaceId,
        threadId: input.threadId,
        ...(input.groupId ? {} : { botId: input.botId }),
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      select: { id: true, taskId: true },
    });
    const now = new Date();
    const { applyCancelTerminalPolicy, cancelPolicyFor } = await import("./cancel-terminal.js");
    const cancelled = await applyCancelTerminalPolicy(tx, activeRuns, now, {
      policy: cancelPolicyFor("thread_cleared"),
      appendEvents: false,
    });
    const cancelledRuns = cancelled.rows;
    const runIds = cancelledRuns.map((run) => run.id);
    await tx.backgroundAgentTask?.updateMany({
      where: { threadId: input.threadId, status: "running" },
      data: { status: "cancelling" },
    });
    // Expire as tombstones so a still-open provider screen claim cannot reset fencing to 1.
    await expireComputerExecutionLeases(tx, { runId: { in: runIds } });
    await tx.computer.updateMany({
      where: { executionRunId: { in: runIds } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    // Clearing is destructive for Task instructions too: amendment Messages
    // and task.amended Events disappear while Task.revision stays. Such a Task
    // fails closed on envelope reads and is fenced from retry by
    // executionEventCeilings (`thread_cleared`); it is never resumed from a
    // silently truncated instruction.
    await tx.message.deleteMany({ where: { threadId: input.threadId } });
    await tx.event.deleteMany({ where: { threadId: input.threadId } });
    // ME-01 M5: clearing a thread does not delete confirmed memories, but it
    // must invalidate their source references explicitly (never rely on FK
    // SET NULL), drop unconfirmed candidates whose entire evidence base just
    // disappeared, and fence late extraction jobs by generation.
    await invalidateThreadMemoryEvidence(tx, {
      threadId: input.threadId,
      newGeneration: thread.historyCompactionGeneration + 1,
    });
    if (thread.nextMessageSeq > 0) {
      // nextMessageSeq is not reset, so mark every deleted message as already compacted.
      // Leaving the cursor behind would let compaction re-summarize deleted history (or, reset
      // to null, immediately re-fire on the fresh conversation).
      await tx.thread.update({
        where: { id: input.threadId },
        data: {
          historyCompactedUpToSeq: thread.nextMessageSeq - 1,
          historyCompactionSummary: null,
          historyCompactionGeneration: { increment: 1 },
        },
      });
    } else {
      await tx.thread.update({
        where: { id: input.threadId },
        data: {
          historyCompactionSummary: null,
          historyCompactionGeneration: { increment: 1 },
        },
      });
    }
    if (input.groupId) {
      await tx.chatGroup.update({ where: { id: input.groupId }, data: { updatedAt: now } });
    } else {
      await tx.bot.update({
        where: { id: input.botId, spaceId: input.spaceId },
        data: { updatedAt: now },
      });
    }
    const event = await appendEventInTransaction(tx, {
      ...input,
      type: "thread.cleared",
      payload: {},
    });
    return {
      event,
      cancelledRunIds: runIds,
      historyCompactionGeneration: thread.historyCompactionGeneration,
    };
  });
  await notifyRealtime(realtime, committed.event.threadId, committed.event.seq);
  return {
    event: mapProductEvent(committed.event),
    cancelledRunIds: committed.cancelledRunIds,
    historyCompactionGeneration: committed.historyCompactionGeneration,
  };
}

export async function sendUserMessage(
  prisma: PrismaClient,
  input: SendUserMessageInput,
  realtime?: RealtimeFanout,
): Promise<SendUserMessageResult> {
  const replay = async (): Promise<SendUserMessageResult | null> => {
    if (!input.clientNonce) return null;
    const message = await prisma.message.findUnique({
      where: {
        threadId_clientNonce: {
          threadId: input.threadId,
          clientNonce: input.clientNonce,
        },
      },
      include: { sourceRuns: { orderBy: { createdAt: "asc" }, take: 1 } },
    });
    if (!message) return null;
    const created = message.sourceRuns[0];
    const run =
      created ??
      (message.runId ? await prisma.run.findUnique({ where: { id: message.runId } }) : null);
    return {
      messageId: message.id,
      seq: message.seq,
      taskId: created?.taskId ?? null,
      runId: run?.id ?? null,
    };
  };
  const existing = await replay();
  if (existing) return existing;

  const commit = () =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Message first: its thread-row lock serializes the whole send against clearThread, so a
      // concurrent clear either sees the committed run and cancels it, or strictly precedes this
      // transaction. Created in separate transactions, the run could land inside the clear's
      // window and later repopulate the cleared conversation, and a clear could strand the
      // message without its event.
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "user",
        originKind: input.originKind ?? "unknown",
        authorUserId: input.authorUserId ?? null,
        blocks: input.blocks,
        clientNonce: input.clientNonce,
      });
      const createRun = input.createRun !== false;
      // RT-27: inbound messaging and webhook writes use the same decision as the
      // web composer. Exactly one eligible conversational Run takes steering; two
      // or more, or none, get their own Task instead of "whichever row came first".
      // A creation intro, routine, webhook, or delivery turn is never a candidate.
      const activeRuns =
        createRun && !input.allowParallelRun
          ? await tx.run.findMany({
              where: {
                threadId: input.threadId,
                botId: input.botId,
                status: {
                  in: ["running", "queued", "leased", "waiting_input", "waiting_takeover"],
                },
              },
              select: { id: true, taskId: true, botId: true, status: true, trigger: true },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            })
          : [];
      const decision =
        createRun && !input.allowParallelRun
          ? decideMessageRoute({
              botId: input.botId,
              candidates: activeRuns.map((run) => ({
                runId: run.id,
                taskId: run.taskId,
                botId: run.botId,
                status: run.status,
                trigger: run.trigger,
              })),
            })
          : null;
      const busy =
        decision?.kind === "steer_existing_run"
          ? (activeRuns.find((run) => run.id === decision.runId) ?? null)
          : null;
      let task = null;
      let run = null;
      if (createRun && !busy) {
        task = await tx.task.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            userId: input.userId,
            prompt: input.prompt,
            status: "queued",
          },
        });
        run = await tx.run.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            taskId: task.id,
            userId: input.userId,
            status: "queued",
            trigger: input.trigger,
            clientNonce: input.clientNonce ? `send:${message.id}` : undefined,
            sourceMessageId: message.id,
          },
        });
        if (input.linkMessageToRun) {
          await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
        }
      } else if (createRun && busy) {
        await tx.steeringMessage.create({
          data: {
            messageId: message.id,
            botId: input.botId,
            userId: input.userId,
            runId: busy.id,
          },
        });
        await tx.message.update({ where: { id: message.id }, data: { runId: busy.id } });
      }
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: run?.id ?? busy?.id,
        payload: {
          messageId: message.id,
          role: "user",
          blocks: input.blocks,
          // Carries the call id on the live event so a spoken turn groups into the
          // call card immediately, instead of after a refetch reads the nonce.
          callId: callIdFromClientNonce(message.clientNonce),
        },
      });
      return { message, task, run, busy, event };
    });
  const committed = await commit().catch(async (error) => {
    const winner = await replay();
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if ("replay" in committed) return committed.replay;
  await notifyRealtime(realtime, input.threadId, committed.event.seq).catch((error) => {
    // The event is durable; subscribers recover it from their persisted cursor.
    getLogger().error("user message realtime notification", error);
  });
  return {
    messageId: committed.message.id,
    seq: committed.message.seq,
    taskId: committed.task?.id ?? null,
    runId: committed.run?.id ?? committed.busy?.id ?? null,
  };
}

export async function claimSteering(
  prisma: PrismaClient,
  input: ClaimSteeringInput,
): Promise<ClaimedSteeringMessage[]> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      select: { id: true, trigger: true, sourceMessage: { select: { blocks: true } } },
    });
    if (!run || run.trigger === "created") return [];
    const channelId =
      run.trigger === "messaging"
        ? messagingChannelId(run.sourceMessage?.blocks as MessageBlock[] | undefined)
        : undefined;
    const directMessage = run.trigger === "messaging" && !channelId;
    // Pending rows from another chat stay for their own continuation.
    const pendingWhere = directMessage
      ? { runId: null, originTrigger: "messaging" }
      : channelId
        ? { runId: null }
        : { runId: null, originTrigger: null };
    const steering = await tx.steeringMessage.findMany({
      where: {
        botId: input.botId,
        id: input.seenIds.length ? { notIn: input.seenIds } : undefined,
        // A routine or webhook turn only takes steering addressed to it; pending user messages
        // wait for the conversational continuation that starts once it finishes.
        OR: isConversationalRun(run.trigger)
          ? [pendingWhere, { runId: input.runId }]
          : [{ runId: input.runId }],
        message: {
          threadId: input.threadId,
          // Private follow-ups remain unclaimed for the existing private continuation.
          ...(channelId
            ? { blocks: { array_contains: [{ kind: "channel_message", channelId }] } }
            : directMessage
              ? { NOT: { blocks: { array_contains: [{ kind: "channel_message" }] } } }
              : {}),
        },
      },
      include: { message: { select: { blocks: true, seq: true } } },
      orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
    });
    if (steering.length === 0) return [];
    await tx.steeringMessage.updateMany({
      where: { id: { in: steering.map((item) => item.id) }, claimedAt: null },
      data: { runId: input.runId, claimedAt: new Date() },
    });
    return steering.map((item) => ({
      id: item.id,
      messageId: item.messageId,
      text: blocksToAgentHistoryText(item.message.blocks as MessageBlock[]),
      blocks: item.message.blocks as MessageBlock[],
    }));
  });
}

export async function commitAnswerRunInput(
  tx: Prisma.TransactionClient,
  input: AnswerRunInput,
  runSecretWriter?: RunSecretWriter,
): Promise<{ threadId: string; seq: number; cancelledRunId?: string } | null> {
  // Thread rows first, then run rows — the same order as clearThread and
  // finalizeRun, so a concurrent clear cannot deadlock against this transaction.
  // An origin-aware answer also settles its Intervention in the presentation
  // Thread, so that Thread is locked here rather than after the Run.
  await lockInterventionThreads(tx, input.threadId, input.presentationThreadId);
  await tx.$queryRaw`SELECT id FROM runs WHERE id = ${input.runId} FOR UPDATE`;
  const run = await tx.run.findFirst({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    select: {
      botId: true,
      userId: true,
      taskId: true,
      checkpoint: true,
      budgetOverride: true,
      trigger: true,
      orchestration: true,
      waitStartedAt: true,
    },
  });
  if (!run) return null;
  const message = await tx.message.findFirst({
    where: {
      id: input.messageId,
      threadId: input.threadId,
      runId: input.runId,
      role: "bot",
    },
  });
  const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
  if (!message || !parsed.success) return null;
  const pendingAsk = parsed.data.find(
    (block) => block.kind === "ask" && block.status !== "answered" && block.status !== "expired",
  );
  if (pendingAsk?.kind !== "ask") return null;
  const approvalAsk = isApprovalAskBlock(pendingAsk);
  const secretAsk = isSecretAskBlock(pendingAsk);
  const choiceAsk = !approvalAsk && !secretAsk && Boolean(pendingAsk.actions?.length);
  const selectedChoice = choiceAsk ? resolveAskChoice(input.answer, pendingAsk.actions) : undefined;
  const budgetAsk = parseBudgetAskCheckpoint(run.checkpoint);
  if (budgetAsk && !BUDGET_ACTIONS.some((action) => action.id === selectedChoice?.id)) return null;
  if (budgetAsk && run.userId !== input.answeredByUserId) return null;
  if (secretAsk && !runSecretWriter) return null;
  if (secretAsk && pendingAsk.credential && run.userId !== input.answeredByUserId) return null;
  const loginAsk = secretAsk && pendingAsk.credential?.auth.type === "login";
  // A username belongs only to a login card, which cannot be saved without one.
  if (loginAsk !== Boolean(input.username?.trim())) return null;
  const login = loginAsk
    ? LoginSecretValue.safeParse({ username: input.username!.trim(), password: input.answer })
    : undefined;
  if (login && !login.success) return null;
  let approvalEffect: { id: string; kind: string } | null = null;
  let approvalUserId: string | null = null;

  if (approvalAsk) {
    // A workspace member may view the thread, but only the Run owner can
    // authorize or deny its external side effect.
    if (run.userId !== input.answeredByUserId) return null;
    if (!pendingAsk.actions?.some((action) => action.id === input.answer)) return null;
    approvalEffect = await tx.externalEffect.findFirst({
      where: {
        id: pendingAsk.approvalEffectId,
        spaceId: input.spaceId,
        runId: input.runId,
        status: "intended",
      },
    });
    if (!approvalEffect) return null;
    if (input.answer === "always") {
      if (run.userId !== input.answeredByUserId) return null;
      approvalUserId = input.answeredByUserId;
    }
  }

  if (budgetAsk && selectedChoice && selectedChoice.id !== "increase_budget") {
    const blocks = parsed.data.map((block) =>
      block === pendingAsk
        ? { ...block, status: "answered" as const, answer: selectedChoice.id }
        : block,
    );
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      type: "thread.message.updated",
      runId: input.runId,
      payload: { messageId: message.id, role: "bot", blocks },
    });
    await settleAnsweredIntervention(tx, {
      run: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: run.botId,
        waitStartedAt: run.waitStartedAt,
      },
      presentationThreadId: input.presentationThreadId,
      messageId: message.id,
      ask: pendingAsk,
      resolvedByUserId: input.answeredByUserId,
      clientSubmissionId: input.clientSubmissionId,
    });
    if (selectedChoice.id === "narrow_scope") {
      const guidance = [
        { kind: "text" as const, text: "Send a narrower request to start a new run." },
      ];
      const note = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "bot",
        originKind: "system",
        botId: run.botId,
        runId: input.runId,
        blocks: guidance,
      });
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: run.botId,
        type: "thread.message.created",
        runId: input.runId,
        payload: { messageId: note.id, role: "bot", blocks: guidance },
      });
    }
    const now = new Date();
    const reason = selectedChoice.id === "narrow_scope" ? "budget_narrowed" : "budget_cancelled";
    const { applyCancelTerminalPolicy, cancelPolicyFor } = await import("./cancel-terminal.js");
    const cancelledRows = await applyCancelTerminalPolicy(
      tx,
      [{ id: input.runId, taskId: run.taskId }],
      now,
      {
        policy: cancelPolicyFor(reason),
        cancelOptions: {
          error: reason,
          clearCheckpoint: true,
          match: { status: "waiting_input", waitKind: "input" },
        },
      },
    );
    if (cancelledRows.rows.length !== 1) throw new Error("Budget Run was no longer waiting");
    await expireComputerExecutionLeases(tx, { runId: input.runId });
    return {
      threadId: input.threadId,
      seq: cancelledRows.eventSeq ?? 0,
      cancelledRunId: input.runId,
    };
  }

  // UX-02 unified plan review: the decision binds to the exact plan version the
  // reviewer saw (planId + contentVersion CAS). A stale click never approves a
  // newer version; it fails as a conflict so the client refreshes and shows the
  // current review card. A plan decision is never a tool authorization: no
  // ExternalEffect and no approval.resolved ride along.
  if (pendingAsk.planReview) {
    const planBinding = pendingAsk.planReview;
    if (run.userId !== input.answeredByUserId) return null;
    const selectedChoice = resolveAskChoice(input.answer, pendingAsk.actions);
    const decision =
      selectedChoice?.id === "approve"
        ? ("approve" as const)
        : selectedChoice?.id === "request_changes"
          ? ("request_changes" as const)
          : selectedChoice?.id === "reject"
            ? ("reject" as const)
            : null;
    if (!decision) return null;
    const feedback = input.feedback?.trim() ?? "";
    if (decision === "request_changes" && feedback.length === 0) {
      throw new InterventionRejected("invalid_submission");
    }
    if (feedback.length > 2000) throw new InterventionRejected("invalid_submission");
    const round = await tx.runPlanReview.findFirst({
      where: { runId: input.runId, status: "pending" },
      orderBy: { submittedAt: "desc" },
    });
    if (
      !round ||
      round.planId !== planBinding.planId ||
      round.contentVersion !== planBinding.contentVersion
    ) {
      return null;
    }
    const { applyPlanReviewDecisionInTransaction } = await import("./run-plans.js");
    await applyPlanReviewDecisionInTransaction(tx, {
      runId: input.runId,
      roundId: round.id,
      decision,
      feedback: feedback.length > 0 ? feedback : null,
      decidedByUserId: input.answeredByUserId,
      ...(input.clientSubmissionId ? { clientSubmissionId: input.clientSubmissionId } : {}),
    });
    const interventionId = pendingAsk.interventionId;
    if (interventionId) {
      await tx.intervention.updateMany({
        where: { id: interventionId, status: "pending" },
        data: {
          planReview: {
            content: planBinding,
            decision,
            ...(feedback.length > 0 ? { feedback } : {}),
          } as Prisma.InputJsonValue,
        },
      });
    }
    const planBlocks = parsed.data.map((block) =>
      block === pendingAsk ? { ...block, status: "answered" as const, answer: decision } : block,
    );
    await tx.message.update({ where: { id: message.id }, data: { blocks: planBlocks } });
    const planUpdated = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      type: "thread.message.updated",
      runId: input.runId,
      payload: { messageId: message.id, role: "bot", blocks: planBlocks },
    });
    const reviewStatus =
      decision === "approve"
        ? "approved"
        : decision === "request_changes"
          ? "changes_requested"
          : "rejected";
    const decidedEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      type: "plan.review_decided",
      runId: input.runId,
      schemaVersion: 1,
      causationId: planUpdated.id,
      payload: {
        planId: planBinding.planId,
        runId: input.runId,
        contentVersion: planBinding.contentVersion,
        decision,
        reviewStatus,
        ...(interventionId ? { interventionId } : {}),
        decidedByUserId: input.answeredByUserId,
        ...(feedback.length > 0 ? { feedback } : {}),
      },
    });
    if (decision === "reject") {
      await settleAnsweredIntervention(tx, {
        run: {
          id: input.runId,
          spaceId: input.spaceId,
          threadId: input.threadId,
          botId: run.botId,
          waitStartedAt: run.waitStartedAt,
        },
        presentationThreadId: input.presentationThreadId,
        messageId: message.id,
        ask: pendingAsk,
        resolvedByUserId: input.answeredByUserId,
        clientSubmissionId: input.clientSubmissionId,
      });
      const { applyCancelTerminalPolicy, cancelPolicyFor } = await import("./cancel-terminal.js");
      const cancelledRows = await applyCancelTerminalPolicy(
        tx,
        [{ id: input.runId, taskId: run.taskId }],
        new Date(),
        {
          policy: cancelPolicyFor("plan_rejected"),
          cancelOptions: {
            error: "plan_rejected",
            clearCheckpoint: true,
            match: { status: "waiting_input", waitKind: "approval" },
          },
        },
      );
      if (cancelledRows.rows.length !== 1) throw new Error("Plan review Run was no longer waiting");
      await expireComputerExecutionLeases(tx, { runId: input.runId });
      return {
        threadId: input.threadId,
        seq: cancelledRows.eventSeq ?? 0,
        cancelledRunId: input.runId,
      };
    }
    // Approve or request changes: the same Task/Run resumes. Request-changes
    // resumes into the planning-only phase (the runtime re-enters PLAN mode
    // from the tool result); approve resumes execution on the approved version.
    const queued = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        status: "waiting_input",
      },
      data: { status: "queued", waitKind: null, checkpoint: null },
    });
    if (queued.count !== 1) return null;
    await settleAnsweredIntervention(tx, {
      run: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: run.botId,
        waitStartedAt: run.waitStartedAt,
      },
      presentationThreadId: input.presentationThreadId,
      messageId: message.id,
      ask: pendingAsk,
      resolvedByUserId: input.answeredByUserId,
      clientSubmissionId: input.clientSubmissionId,
    });
    if (interventionStore(tx)) {
      const remaining = await tx.intervention.count({
        where: { runId: input.runId, status: "pending" },
      });
      if (remaining > 0) throw new Error("Run still has a pending intervention");
    }
    return { threadId: decidedEvent.threadId, seq: decidedEvent.seq };
  }

  const increasedBudget = budgetAsk
    ? increasedBudgetForViolation(
        turnPolicyFromRun({
          trigger: run.trigger,
          ownerBotId: run.botId,
          orchestration: run.orchestration,
        }).budget,
        run.budgetOverride,
        budgetAsk,
      )
    : null;

  const queued = await tx.run.updateMany({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    data: {
      status: "queued",
      waitKind: null,
      ...(increasedBudget ? { budgetOverride: increasedBudget } : {}),
      ...(choiceAsk ? { checkpoint: null } : {}),
    },
  });
  if (queued.count !== 1) return null;

  const recordedAnswer = secretAsk ? "" : (selectedChoice?.id ?? input.answer);

  const retryEffectId = manualRetryEffectIdFromCheckpoint(run.checkpoint);
  if (choiceAsk && retryEffectId && selectedChoice) {
    const reviewDecision =
      selectedChoice.id === "authorize_retry"
        ? "manual_retry_authorized"
        : selectedChoice.id === "confirm_completed"
          ? "manual_retry_confirmed"
          : selectedChoice.id === "cancel"
            ? "manual_retry_cancelled"
            : null;
    if (reviewDecision) {
      await tx.externalEffect.updateMany({
        where: { id: retryEffectId, spaceId: input.spaceId },
        data: { reviewDecision },
      });
    }
  }

  if (approvalAsk) {
    const allowed = input.answer === "allow" || input.answer === "always";
    const effectWrite = await tx.externalEffect.updateMany({
      where: { id: approvalEffect!.id, status: "intended" },
      data: { status: allowed ? "approved" : "denied" },
    });
    if (effectWrite.count !== 1) throw new InterventionRejected("conflict");
    if (input.answer === "always") {
      await tx.actionApprovalRule.upsert({
        where: {
          spaceId_createdByUserId_effect_matchKind_matchValue: {
            spaceId: input.spaceId,
            createdByUserId: approvalUserId!,
            effect: "always_allow",
            matchKind: "tool",
            matchValue: approvalEffect!.kind,
          },
        },
        create: {
          spaceId: input.spaceId,
          createdByUserId: approvalUserId!,
          effect: "always_allow",
          matchKind: "tool",
          matchValue: approvalEffect!.kind,
        },
        update: {},
      });
    }
  } else if (secretAsk) {
    await runSecretWriter!.store({
      botId: run.botId,
      credential: pendingAsk.credential,
      runId: input.runId,
      userId: run.userId,
      spaceId: input.spaceId,
      plaintext: login?.success ? encodeLoginSecret(login.data) : input.answer,
      tx,
    });
    await tx.externalEffect.updateMany({
      where: {
        runId: input.runId,
        spaceId: input.spaceId,
        kind: "request_secret",
        status: "intended",
      },
      data: {
        status: "approved",
        ...(pendingAsk.credential ? { result: { credentialSaved: pendingAsk.credential } } : {}),
      },
    });
  }

  // Ordinary text and choice answers revise the Task instruction log. Approval,
  // secret, budget and manual-retry decisions stay control facts and never
  // become natural-language amendments. Only an append-only user Message is a
  // body source; Task.prompt is never rewritten.
  const amendmentSource =
    !approvalAsk && !secretAsk && !budgetAsk && !retryEffectId
      ? selectedChoice
        ? ("choice_answer" as const)
        : ("ask_answer" as const)
      : null;

  const blocks = parsed.data.map((block) =>
    block === pendingAsk
      ? {
          ...block,
          status: "answered" as const,
          answer: recordedAnswer,
        }
      : block,
  );
  await tx.message.update({ where: { id: message.id }, data: { blocks } });
  if (amendmentSource) {
    // The amendment body is always an append-only user Message. The send flow
    // already created one; the legacy answer entry did not, so append it here.
    // The Bot ask card is only a presentation surface and is never the source.
    const amendmentText =
      amendmentSource === "choice_answer" && selectedChoice
        ? `Selected choice ${selectedChoice.id}: ${selectedChoice.label}`
        : input.answer;
    const answerMessage = input.answerMessageId
      ? null
      : await createThreadMessageInTransaction(tx, {
          threadId: input.threadId,
          role: "user",
          originKind: "human_web",
          authorUserId: input.answeredByUserId,
          blocks: [{ kind: "text", text: amendmentText }],
          botId: run.botId,
          runId: input.runId,
          ...(input.clientSubmissionId ? { clientNonce: input.clientSubmissionId } : {}),
        });
    if (answerMessage) {
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: run.botId,
        type: "thread.message.created",
        runId: input.runId,
        payload: { messageId: answerMessage.id, role: "user", blocks: answerMessage.blocks },
      });
    }
    await appendTaskAmendmentInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      actorUserId: input.answeredByUserId,
      targetTaskId: run.taskId,
      messageId: answerMessage?.id ?? input.answerMessageId,
      source: amendmentSource,
      // The Run lock above already authorized this answer. Group members keep
      // the existing ability to answer a Bot's ask without owning the Task.
      requireTaskOwner: false,
    });
  }
  const updated = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: run.botId,
    type: "thread.message.updated",
    runId: input.runId,
    payload: { messageId: message.id, role: "bot", blocks },
  });
  let threadId = updated.threadId;
  let seq = updated.seq;
  if (approvalAsk) {
    // The effect can leave "intended" only once in this serialized transaction.
    // A repeated answer cannot emit another resolution event.
    const resolution = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      type: "approval.resolved",
      runId: input.runId,
      schemaVersion: 2,
      causationId: updated.id,
      payload: {
        approvalEffectId: approvalEffect!.id,
        decision: input.answer === "allow" || input.answer === "always" ? "approved" : "denied",
        decidedByUserId: input.answeredByUserId,
      },
    });
    threadId = resolution.threadId;
    seq = resolution.seq;
  }
  await settleAnsweredIntervention(tx, {
    run: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      waitStartedAt: run.waitStartedAt,
    },
    presentationThreadId: input.presentationThreadId,
    messageId: message.id,
    ask: pendingAsk,
    resolvedByUserId: input.answeredByUserId,
    ...(approvalAsk
      ? {
          decision:
            input.answer === "allow" || input.answer === "always"
              ? ("approved" as const)
              : ("denied" as const),
        }
      : {}),
    clientSubmissionId: input.clientSubmissionId,
  });
  if (interventionStore(tx)) {
    const remaining = await tx.intervention.count({
      where: { runId: input.runId, status: "pending" },
    });
    if (remaining > 0) throw new Error("Run still has a pending intervention");
  }
  return { threadId, seq };
}

export async function answerRunInput(
  prisma: PrismaClient,
  input: AnswerRunInput,
  realtime?: RealtimeFanout,
  runSecretWriter?: RunSecretWriter,
): Promise<boolean> {
  const committed = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => commitAnswerRunInput(tx, input, runSecretWriter),
    INTERVENTION_TRANSACTION,
  );

  if (!committed) return false;
  if (committed.cancelledRunId) {
    const { cancelChildrenOfCancelledRuns } = await import("./cancel-child-runs.js");
    await cancelChildrenOfCancelledRuns(prisma, [committed.cancelledRunId]);
  }
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

async function locateInterventionTarget(
  prisma: PrismaClient,
  input: { spaceId: string; threadId: string; interventionId: string },
): Promise<{ runId: string; messageId: string; executionThreadId: string } | null> {
  const store = interventionStore(prisma);
  if (store) {
    const row = await store.findUnique({ where: { id: input.interventionId } });
    if (row) {
      if (row.spaceId !== input.spaceId || row.threadId !== input.threadId) return null;
      // The executing Thread is derived from the bound Run and never taken from
      // the caller: the row's own threadId is only the presentation anchor, while
      // the Run is the sole authority for where the ask Message lives and which
      // execution a decision may resume. A Run that left the Space, or is gone,
      // leaves nothing that can be answered.
      const run = await prisma.run.findFirst({
        where: { id: row.runId, spaceId: input.spaceId },
        select: { threadId: true },
      });
      if (!run) return null;
      return {
        runId: row.runId,
        messageId: row.messageId,
        executionThreadId: run.threadId,
      };
    }
  }
  const messageId = legacyMessageId(input.interventionId);
  if (!messageId) return null;
  const message = await prisma.message.findFirst({
    where: { id: messageId, threadId: input.threadId, role: "bot" },
    select: { id: true, runId: true },
  });
  if (!message?.runId) return null;
  const run = await prisma.run.findFirst({
    where: { id: message.runId, threadId: input.threadId, spaceId: input.spaceId },
    select: { id: true, threadId: true },
  });
  if (!run) return null;
  return { runId: run.id, messageId: message.id, executionThreadId: run.threadId };
}

export async function resolveIntervention(
  prisma: PrismaClient,
  input: ResolveInterventionInput,
  realtime?: RealtimeFanout,
  runSecretWriter?: RunSecretWriter,
  options?: { cardsUnifiedV2?: boolean },
): Promise<ResolveInterventionOutcome> {
  try {
    assertSafeClientSubmissionId(input.clientSubmissionId, input.answer);
  } catch (error) {
    if (error instanceof InterventionRejected) return { outcome: "rejected", reason: error.reason };
    throw error;
  }
  const located = await locateInterventionTarget(prisma, input);
  if (!located) return { outcome: "rejected", reason: "not_found" };
  // Answering away from the executing Thread is a roundtable capability. The
  // refusal propagates as RoundtableFeatureDisabledError so the API can report
  // the disabled feature instead of dressing it up as a stale card.
  authorizeInterventionPresentation({
    gates: input.gates ?? ROUNDTABLE_GATES_DISABLED,
    executionThreadId: located.executionThreadId,
    presentationThreadId: input.threadId,
  });
  let outcome: ResolveInterventionOutcome;
  try {
    outcome = await prisma.$transaction(
      (tx: Prisma.TransactionClient) =>
        resolveInterventionInTransaction(
          tx,
          { ...input, runId: located.runId, executionThreadId: located.executionThreadId },
          (transaction) =>
            commitInterventionDecision(transaction, {
              spaceId: input.spaceId,
              threadId: located.executionThreadId,
              presentationThreadId: input.threadId,
              runId: located.runId,
              messageId: located.messageId,
              interventionId: input.interventionId,
              answeredByUserId: input.answeredByUserId,
              answer: input.answer,
              username: input.username,
              clientSubmissionId: input.clientSubmissionId,
              feedback: input.feedback,
              requestRevision: input.requestRevision,
              cardsUnifiedV2: options?.cardsUnifiedV2 === true,
              runSecretWriter,
            }),
        ),
      INTERVENTION_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof InterventionRejected) return { outcome: "rejected", reason: error.reason };
    throw error;
  }
  if (outcome.outcome === "rejected") return outcome;
  if (outcome.applied && outcome.cancelledRunId) {
    const { cancelChildrenOfCancelledRuns } = await import("./cancel-child-runs.js");
    await cancelChildrenOfCancelledRuns(prisma, [outcome.cancelledRunId]);
  }
  if (outcome.applied && outcome.seq > 0) {
    await notifyRealtime(realtime, outcome.threadId, outcome.seq);
  }
  // The settled projection is appended to the presentation Thread, so its own
  // followers need that position or the answering user watches a stale card.
  if (
    outcome.applied &&
    outcome.presentationThreadId !== undefined &&
    outcome.presentationSeq !== undefined &&
    outcome.presentationSeq > 0
  ) {
    await notifyRealtime(realtime, outcome.presentationThreadId, outcome.presentationSeq);
  }
  if (outcome.applied && outcome.membershipDelivery) {
    await notifyRealtime(
      realtime,
      outcome.membershipDelivery.targetThreadId,
      outcome.membershipDelivery.targetEventSeq,
    );
  }
  return outcome;
}

/**
 * One submission entry with two explicit business branches: a bound
 * group-membership request resolves through its own transaction, everything
 * else keeps the ordinary ask/tool-approval answer path.
 */
async function commitInterventionDecision(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    presentationThreadId: string;
    runId: string;
    messageId: string;
    interventionId: string;
    answeredByUserId: string;
    answer: string;
    username?: string;
    clientSubmissionId: string;
    feedback?: string;
    requestRevision?: number;
    cardsUnifiedV2: boolean;
    runSecretWriter?: RunSecretWriter;
  },
): Promise<{
  threadId: string;
  seq: number;
  cancelledRunId?: string;
  membershipDelivery?: {
    targetRunId: string;
    targetThreadId: string;
    targetEventSeq: number;
  };
} | null> {
  const { loadGroupMembershipRequestForIntervention, resolveGroupMembershipDecisionInTransaction } =
    await import("./group-membership.js");
  const membership = await loadGroupMembershipRequestForIntervention(tx, input.interventionId);
  if (membership) {
    // A deployment without the unified card surface must not settle a wait the
    // user could not see; refusing keeps the card and the decision atomic.
    if (!input.cardsUnifiedV2) return null;
    const resolved = await resolveGroupMembershipDecisionInTransaction(
      tx,
      {
        spaceId: input.spaceId,
        threadId: input.presentationThreadId,
        executionThreadId: input.threadId,
        runId: input.runId,
        interventionId: input.interventionId,
        answeredByUserId: input.answeredByUserId,
        answer: input.answer,
        clientSubmissionId: input.clientSubmissionId,
        expectedRevision: input.requestRevision,
      },
      async (status, decision) => {
        await settleMembershipIntervention(tx, {
          interventionId: input.interventionId,
          status,
          ...(decision ? { decision } : {}),
          ...(status === "answered" ? { resolvedByUserId: input.answeredByUserId } : {}),
          clientSubmissionId: input.clientSubmissionId,
        });
        const remaining = await tx.intervention.count({
          where: { runId: input.runId, status: "pending" },
        });
        if (remaining > 0) throw new Error("Run still has a pending intervention");
      },
    );
    if (!resolved.ok) return null;
    return {
      threadId: resolved.threadId,
      seq: resolved.seq,
      ...(resolved.delivery ? { membershipDelivery: resolved.delivery } : {}),
    };
  }
  return commitAnswerRunInput(
    tx,
    {
      spaceId: input.spaceId,
      threadId: input.threadId,
      presentationThreadId: input.presentationThreadId,
      runId: input.runId,
      messageId: input.messageId,
      answeredByUserId: input.answeredByUserId,
      answer: input.answer,
      username: input.username,
      clientSubmissionId: input.clientSubmissionId,
      feedback: input.feedback,
    },
    input.runSecretWriter,
  );
}

/**
 * Answer the only ordinary text input among the given runs.
 * Approval, secret, and choice never match. Zero or many text inputs do not guess.
 */
export async function answerSingleOrdinaryTextInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    answeredByUserId: string;
    answer: string;
    /** User Message already persisted by the send flow; reused as the amendment body. */
    answerMessageId?: string;
    runIds: readonly string[];
  },
): Promise<{ threadId: string; seq: number; runId: string } | null> {
  const answer = input.answer.trim();
  if (!answer) return null;
  const found = await findOrdinaryTextAsks(tx, { threadId: input.threadId, runIds: input.runIds });
  if (found.length !== 1) return null;
  const target = found[0]!;
  const committed = await commitAnswerRunInput(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    runId: target.runId,
    messageId: target.messageId,
    ...(input.answerMessageId ? { answerMessageId: input.answerMessageId } : {}),
    answeredByUserId: input.answeredByUserId,
    answer,
  });
  if (!committed) return null;
  return { threadId: committed.threadId, seq: committed.seq, runId: target.runId };
}

/** Answer one run's ordinary text ask. Approval, secret, and choice stay on the card path. */
export async function answerWaitingRunWithTextInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    runId: string;
    answeredByUserId: string;
    answer: string;
  },
): Promise<{ threadId: string; seq: number } | null> {
  const committed = await answerSingleOrdinaryTextInTransaction(tx, {
    ...input,
    runIds: [input.runId],
  });
  if (!committed) return null;
  return { threadId: committed.threadId, seq: committed.seq };
}

export async function pauseRunForInput(
  prisma: PrismaClient,
  input: PauseRunForInput,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  // Resolved before the transaction opens: a pause that is not allowed to leave
  // the executing Thread must fail without having written anything.
  const threads = resolveInterventionThreads({
    gates: input.gates ?? ROUNDTABLE_GATES_DISABLED,
    executionThreadId: input.threadId,
    presentationThreadId: input.presentationThreadId,
    origin: input.origin,
  });
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Thread rows first, then run rows — the same order as clearThread and
    // finalizeRun, so a concurrent clear cannot deadlock against this
    // transaction. Both Threads of an origin-aware pause are in the set: the
    // projection event writes the presentation Thread row.
    await lockInterventionThreads(tx, threads.executionThreadId, threads.presentationThreadId);
    if (threads.origin !== null) {
      // The origin is what makes this wait publishable away from the Run, so the
      // source Run has to be real: same Space and actually anchored in the
      // presentation Thread. A fabricated anchor would otherwise hand one Run's
      // approval to whoever can write in an unrelated Thread.
      const source = await tx.run.findFirst({
        where: {
          id: threads.origin.sourceRunId,
          spaceId: input.spaceId,
          threadId: threads.presentationThreadId,
        },
        select: { id: true },
      });
      if (!source) {
        throw new RoundtableContractError(
          "CollaborationOrigin",
          "sourceRunId",
          "must be a Run of the presentation Thread in this Space",
        );
      }
    }
    const approvalEffectId = input.blocks.find(
      (block) => block.kind === "ask" && Boolean(block.approvalEffectId),
    );
    // A plan review is a decision wait like a tool approval (24h window,
    // "needs approval" avatar, honest summary-only fallback), even though it
    // authorizes a plan version rather than an external effect.
    const planReviewWait = input.blocks.some(
      (block) => block.kind === "ask" && Boolean(block.planReview),
    );
    const waitKind = approvalEffectId?.kind === "ask" || planReviewWait ? "approval" : "input";
    const waitStartedAt = new Date();
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: "waiting_input",
        waitKind,
        waitStartedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(input.budgetExceeded
          ? { checkpoint: budgetAskCheckpoint(input.budgetExceeded) }
          : input.offeredActions?.length
            ? {
                checkpoint: choiceAskCheckpoint(input.offeredActions, {
                  manualRetryEffectId: input.manualRetryEffectId,
                }),
              }
            : {}),
      },
    });
    if (paused.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "waiting_input", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    const messageId = randomUUID();
    const pausedIntervention = await insertPausedIntervention(tx, {
      spaceId: input.spaceId,
      threads,
      botId: input.botId,
      runId: input.runId,
      attemptId: input.attemptId,
      executionFence: input.executionFence,
      suspensionKey: input.suspensionKey,
      messageId,
      blocks: input.blocks,
      waitStartedAt,
    });
    const message = await createThreadMessageInTransaction(tx, {
      id: messageId,
      threadId: input.threadId,
      role: "bot",
      originKind: "system",
      blocks: pausedIntervention.blocks,
      botId: input.botId,
      runId: input.runId,
    });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.created",
      runId: input.runId,
      payload: { messageId: message.id, role: "bot", blocks: pausedIntervention.blocks },
    });
    const waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "run.waiting_input",
      runId: input.runId,
      payload: { waitKind },
    });
    const interventionEvent = await emitInterventionCreated(tx, pausedIntervention.id);
    let planReviewEvent: { threadId: string; seq: number } | null = null;
    if (input.planReviewRound) {
      const paired = await tx.runPlanReview.updateMany({
        where: { id: input.planReviewRound.roundId, status: "pending", interventionId: null },
        data: { interventionId: pausedIntervention.id },
      });
      if (paired.count !== 1) throw new Error("Plan review round was not pending to pause on");
      planReviewEvent = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "plan.review_submitted",
        runId: input.runId,
        schemaVersion: 1,
        causationId: waitingEvent.id,
        payload: {
          planId: input.planReviewRound.planId,
          runId: input.runId,
          contentVersion: input.planReviewRound.contentVersion,
          revision: input.planReviewRound.revision,
          source: input.planReviewRound.source,
          interventionId: pausedIntervention.id,
        },
      });
    }
    const budgetEvent = input.budgetExceeded
      ? await appendEventInTransaction(tx, {
          spaceId: input.spaceId,
          threadId: input.threadId,
          botId: input.botId,
          type: "budget.exceeded",
          runId: input.runId,
          schemaVersion: 2,
          causationId: waitingEvent.id,
          payload: { reason: input.budgetExceeded.reason, limit: input.budgetExceeded.limit },
        })
      : null;
    const approvalEvent =
      approvalEffectId?.kind === "ask" && approvalEffectId.approvalEffectId
        ? await appendEventInTransaction(tx, {
            spaceId: input.spaceId,
            threadId: input.threadId,
            botId: input.botId,
            type: "approval.requested",
            runId: input.runId,
            schemaVersion: 2,
            causationId: waitingEvent.id,
            payload: { approvalEffectId: approvalEffectId.approvalEffectId },
          })
        : null;
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    return {
      threadId: waitingEvent.threadId,
      seq: approvalEvent?.seq ?? budgetEvent?.seq ?? planReviewEvent?.seq ?? interventionEvent.seq,
      // Only a cross-Thread pause has a second Thread to publish to; otherwise
      // this is the same position the line above already reports.
      presentation: threads.crossThread ? interventionEvent : null,
    };
  }, INTERVENTION_TRANSACTION);

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  if (committed.presentation) {
    await notifyRealtime(realtime, committed.presentation.threadId, committed.presentation.seq);
  }
  return true;
}

export async function pauseRunForGroupMembership(
  prisma: PrismaClient,
  input: PauseRunForGroupMembershipInput,
  realtime?: RealtimeFanout,
): Promise<PauseRunForGroupMembershipResult> {
  const threads = resolveInterventionThreads({
    gates: input.gates ?? ROUNDTABLE_GATES_DISABLED,
    executionThreadId: input.threadId,
  });
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockInterventionThreads(tx, threads.executionThreadId, threads.presentationThreadId);
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      select: { userId: true, taskId: true, sourceMessageId: true },
    });
    if (!run) return { outcome: "run_not_running" as const };
    // The source Run is a Bot's direct chat; a group Run never asks to join
    // another group on the user's behalf.
    const sourceThread = await tx.thread.findFirst({
      where: {
        id: input.threadId,
        spaceId: input.spaceId,
        userId: run.userId,
        botId: input.botId,
      },
      select: { id: true, groupId: true },
    });
    if (!sourceThread || sourceThread.groupId) {
      return { outcome: "not_manageable" as const };
    }
    const { inspectGroupMembershipTarget, buildGroupMembershipPresentation } = await import(
      "./group-membership.js"
    );
    const target = await inspectGroupMembershipTarget(tx, {
      spaceId: input.spaceId,
      userId: run.userId,
      botId: input.botId,
      groupId: input.groupId,
    });
    if (!target.ok) {
      return {
        outcome:
          target.reason === "not_manageable"
            ? ("not_manageable" as const)
            : ("unavailable" as const),
      };
    }
    if (target.isMember) return { outcome: "already_member" as const };

    const waitStartedAt = new Date();
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: "waiting_input",
        waitKind: "approval",
        waitStartedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (paused.count !== 1) return { outcome: "run_not_running" as const };
    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "waiting_input", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    const presentation = buildGroupMembershipPresentation({
      botName: input.botName,
      groupName: target.group.name,
    });
    const askBlock: MessageBlock = {
      kind: "ask",
      text: presentation.text,
      detail: presentation.detail,
      status: "pending",
      actions: [
        { id: "approve", label: "Join and continue" },
        { id: "deny", label: "Not now" },
      ],
    };
    const messageId = randomUUID();
    const requestId = randomUUID();
    const pausedIntervention = await insertPausedIntervention(tx, {
      spaceId: input.spaceId,
      threads,
      botId: input.botId,
      runId: input.runId,
      attemptId: input.attemptId,
      ...(input.executionFence !== undefined ? { executionFence: input.executionFence } : {}),
      ...(input.suspensionKey ? { suspensionKey: input.suspensionKey } : {}),
      messageId,
      blocks: [askBlock],
      waitStartedAt,
      groupMembership: {
        id: requestId,
        spaceId: input.spaceId,
        userId: run.userId,
        botId: input.botId,
        groupId: target.group.id,
        groupName: target.group.name,
        sourceThreadId: sourceThread.id,
        sourceRunId: input.runId,
        requestMessageId: run.sourceMessageId ?? null,
        deliveryKey: input.deliveryKey,
        requestRevision: 1,
        message: input.message,
        topic: input.topic ?? null,
      },
    });
    const message = await createThreadMessageInTransaction(tx, {
      id: messageId,
      threadId: input.threadId,
      role: "bot",
      originKind: "system",
      blocks: pausedIntervention.blocks,
      botId: input.botId,
      runId: input.runId,
    });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.created",
      runId: input.runId,
      payload: { messageId: message.id, role: "bot", blocks: pausedIntervention.blocks },
    });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "run.waiting_input",
      runId: input.runId,
      payload: { waitKind: "approval" },
    });
    const interventionEvent = await emitInterventionCreated(tx, pausedIntervention.id);
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    return {
      outcome: "paused" as const,
      requestId,
      interventionId: pausedIntervention.id,
      messageId: message.id,
      expiresAt: new Date(waitStartedAt.getTime() + INTERVENTION_WAIT_MS).toISOString(),
      seq: interventionEvent.seq,
    };
  }, INTERVENTION_TRANSACTION);

  if (committed.outcome !== "paused") return committed;
  await notifyRealtime(realtime, input.threadId, committed.seq);
  return {
    outcome: "paused",
    requestId: committed.requestId,
    interventionId: committed.interventionId,
    messageId: committed.messageId,
    expiresAt: committed.expiresAt,
  };
}

export async function pauseRunForTakeover(
  prisma: PrismaClient,
  input: PauseRunForTakeover,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: "waiting_takeover",
        waitKind: "takeover",
        waitStartedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        checkpoint: null,
      },
    });
    if (paused.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "waiting_takeover", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    const now = new Date();
    // Serialize with concurrent computer/takeover grants that mutate the same row.
    await tx.$queryRaw`
      SELECT id FROM computers WHERE id = ${input.computerId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    const computer = await tx.computer.findFirst({
      where: { id: input.computerId, spaceId: input.spaceId },
      select: {
        controlHolder: true,
        controlBotId: true,
        controlLeaseId: true,
        controlLeaseExpiresAt: true,
      },
    });
    const activeUserLease = Boolean(
      computer?.controlHolder === "user" &&
        computer.controlLeaseId &&
        computer.controlLeaseExpiresAt &&
        computer.controlLeaseExpiresAt.getTime() > now.getTime(),
    );
    // Keep an active same-bot user lease so Skip / I'm done appear immediately.
    // Preserve another bot's active lease — computer/takeover owns revocation. Do not attach
    // this run to that lease: release validates controlBotId and could clear the binding without
    // resuming the waiting run. The requesting bot's takeover flow binds it after revocation.
    // Otherwise clear stale control, but bind controlRunId so takeoverRequested is true.
    const retainControl = Boolean(activeUserLease && computer?.controlBotId === input.botId);
    const preserveForeignLease = Boolean(
      activeUserLease && computer?.controlBotId && computer.controlBotId !== input.botId,
    );
    const marked = await tx.computer.updateMany({
      where: { id: input.computerId, spaceId: input.spaceId },
      data: retainControl
        ? { state: "running", controlRunId: input.runId }
        : preserveForeignLease
          ? { state: "running" }
          : {
              state: "running",
              controlHolder: "none",
              controlLeaseId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: input.runId,
            },
    });
    if (marked.count !== 1) throw new Error("Computer was not available to mark for takeover");

    const waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.presentationThreadId ?? input.threadId,
      botId: input.botId,
      type: "computer.takeover.requested",
      runId: input.runId,
      payload: {
        reason: input.reason,
        takeoverRequested: true,
        retainedControl: retainControl,
      },
    });
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    return { threadId: waitingEvent.threadId, seq: waitingEvent.seq };
  });

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

export async function finalizeComputerControlRelease(
  prisma: PrismaClient,
  input: FinalizeComputerControlReleaseInput,
  realtime?: RealtimeFanout,
): Promise<FinalizeComputerControlReleaseResult | false> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const cleared = await tx.computer.updateMany({
      where: {
        id: input.computerId,
        spaceId: input.spaceId,
        controlBotId: input.botId,
        controlLeaseId: input.leaseId,
        controlRunId: input.runId,
      },
      data: {
        controlHolder: input.holder,
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    if (cleared.count !== 1) return null;

    const checkpoint =
      input.reason === "skipped" || input.reason === "expired" ? "takeover-skipped" : "takeover";
    const resumed = input.runId
      ? await tx.run.updateMany({
          where: {
            id: input.runId,
            spaceId: input.spaceId,
            botId: input.botId,
            status: "waiting_takeover",
          },
          data: {
            status: "queued",
            waitKind: null,
            checkpoint,
          },
        })
      : { count: 0 };
    // A steered continue may already hold the run as leased/running. Stamp the
    // checkpoint without stealing the lease so the worker can restore tools.
    const stamped =
      input.runId && resumed.count !== 1
        ? await tx.run.updateMany({
            where: {
              id: input.runId,
              spaceId: input.spaceId,
              botId: input.botId,
              status: { in: ["leased", "running"] },
            },
            data: { checkpoint },
          })
        : { count: 0 };
    const runId = resumed.count === 1 || stamped.count === 1 ? input.runId : null;

    const bot = await tx.bot.findFirst({
      where: { id: input.botId, spaceId: input.spaceId },
      select: { thread: { select: { id: true } } },
    });
    if (!bot?.thread) return { threadId: null, seq: null, runId };
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: bot.thread.id,
      botId: input.botId,
      runId: runId ?? undefined,
      type: "computer.takeover.released",
      payload: {
        holder: input.holder,
        leaseId: input.leaseId,
        reason: input.reason,
      },
    });
    // RT-05F: a delegated run's takeover was PROJECTED into its visible
    // origin; the release must reach that Thread too or the user's chat keeps
    // showing the wait after acting. Walk the persisted origin chain to the
    // first visible Thread (same rule as the projection).
    let projected: { threadId: string; seq: number } | null = null;
    if (input.runId) {
      let hop = await tx.run.findUnique({
        where: { id: input.runId },
        select: { originThreadId: true, originRunId: true },
      });
      for (let depth = 0; hop?.originThreadId && hop.originRunId && depth < 8; depth += 1) {
        const originThread = await tx.thread.findUnique({
          where: { id: hop.originThreadId },
          select: { id: true, group: { select: { kind: true } } },
        });
        if (!originThread) break;
        if (originThread.group?.kind !== "agent_pair") {
          if (originThread.id !== bot.thread.id) {
            const projectedEvent = await appendEventInTransaction(tx, {
              spaceId: input.spaceId,
              threadId: originThread.id,
              botId: input.botId,
              runId: runId ?? undefined,
              type: "computer.takeover.released",
              payload: {
                holder: input.holder,
                leaseId: input.leaseId,
                reason: input.reason,
                projected: true,
              },
            });
            projected = { threadId: projectedEvent.threadId, seq: projectedEvent.seq };
          }
          break;
        }
        hop = await tx.run.findUnique({
          where: { id: hop.originRunId },
          select: { originThreadId: true, originRunId: true },
        });
      }
    }
    return { threadId: event.threadId, seq: event.seq, runId, projected };
  });

  if (!committed) return false;
  if (committed.threadId && committed.seq !== null) {
    await notifyRealtime(realtime, committed.threadId, committed.seq);
  }
  if (committed.projected) {
    await notifyRealtime(realtime, committed.projected.threadId, committed.projected.seq);
  }
  return { runId: committed.runId };
}

export async function appendEvent(
  prisma: PrismaClient,
  input: AppendEventInput,
  realtime?: RealtimeFanout,
): Promise<ProductEvent> {
  // Concurrent writers in one thread (group members, bot messages) can deadlock on the thread row.
  const event = await withTransactionRetry(() =>
    prisma.$transaction((tx: Prisma.TransactionClient) => appendEventInTransaction(tx, input)),
  );
  const productEvent = mapProductEvent(event);
  await notifyRealtime(realtime, event.threadId, event.seq);
  return productEvent;
}

export async function finalizeRun(
  prisma: PrismaClient,
  input: FinalizeRunInput,
  realtime?: RealtimeFanout,
): Promise<FinalizeRunResult | false> {
  const committed = await withTransactionRetry(() => finalizeRunOnce(prisma, input));
  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return { continuationRunId: committed.continuationRunId };
}

/** Stamps one turn-level wall-clock duration on the final tool block. */
export function completedRunBlocks(
  blocks: MessageBlock[],
  startedAt: Date | null,
  completedAt: Date,
): MessageBlock[] {
  if (!startedAt) return blocks;
  const durationMs = completedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) return blocks;
  const index = blocks.findLastIndex((block) => block.kind === "steps");
  if (index < 0) return blocks;
  return blocks.map((block, blockIndex) =>
    blockIndex === index && block.kind === "steps"
      ? { ...block, durationMs: Math.round(durationMs) }
      : block,
  );
}

async function finalizeRunOnce(
  prisma: PrismaClient,
  input: FinalizeRunInput,
): Promise<{ threadId: string; seq: number; continuationRunId: string | null } | null> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    if (input.attemptId === null) {
      if (input.outcome !== "failed" || !input.requireLeaseExpiredAt) {
        throw new Error("Missing Attempt requires an expired lease failure guard");
      }
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${input.runId} FOR UPDATE`;
      const attempt = await tx.attempt.findFirst({
        where: { runId: input.runId, fence: input.leaseFence },
        select: { id: true },
      });
      if (attempt) return null;
    }
    let writableRun: { startedAt: Date | null } | undefined;
    try {
      writableRun = await assertRunCanWriteHistory(tx, input.runId);
    } catch (error) {
      if (error instanceof RunHistoryWriteError) return null;
      throw error;
    }
    const now = new Date();
    const terminal = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        taskId: input.taskId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
        ...(input.requireLeaseExpiredAt
          ? { leaseExpiresAt: { lte: input.requireLeaseExpiredAt } }
          : {}),
      },
      data: {
        status: input.outcome,
        waitKind: null,
        error: input.outcome === "failed" ? input.error : null,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (terminal.count !== 1) return null;

    if (input.attemptId !== null) {
      const attempt = await tx.attempt.updateMany({
        where: {
          id: input.attemptId,
          runId: input.runId,
          fence: input.leaseFence,
          status: "running",
        },
        data: {
          status: input.outcome,
          error: input.outcome === "failed" ? input.error : null,
          finishedAt: now,
        },
      });
      if (attempt.count !== 1) throw new Error("Active run attempt was not available to finalize");
    }

    const task = await tx.task.updateMany({
      where: {
        id: input.taskId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
      },
      data: { status: input.outcome },
    });
    if (task.count !== 1) throw new Error("Run task was not available to finalize");

    const persistBlocks =
      input.outcome === "completed"
        ? input.blocks
        : input.outcome === "failed"
          ? input.blocks
          : undefined;
    if (persistBlocks && persistBlocks.length > 0) {
      const completedBlocks = completedRunBlocks(
        persistBlocks,
        writableRun?.startedAt ?? null,
        now,
      );
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "bot",
        originKind: "bot",
        blocks: completedBlocks,
        botId: input.botId,
        runId: input.runId,
        markUnread: input.markUnread,
      });
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: input.runId,
        payload: { messageId: message.id, role: "bot", blocks: completedBlocks },
      });
    }
    if (input.outcome === "failed" && input.budgetExceeded) {
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "budget.exceeded",
        runId: input.runId,
        schemaVersion: 2,
        payload: input.budgetExceeded,
      });
    }
    const lastEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: input.outcome === "completed" ? "run.completed" : "run.failed",
      runId: input.runId,
      payload:
        input.outcome === "completed"
          ? {}
          : {
              error: input.error,
              ...(input.budgetExceeded ? { reason: "budget_exceeded" } : {}),
            },
    });
    let lastSeq = lastEvent.seq;
    if (input.outcome === "failed" && input.budgetExceeded) {
      const source = await tx.run.findUniqueOrThrow({
        where: { id: input.runId },
        select: { trigger: true },
      });
      if (source.trigger === "routine") {
        const delivery = await enqueueDeliveryInTransaction(tx, {
          runId: input.runId,
          threadId: input.threadId,
          threadGeneration: await currentThreadGeneration(tx, input.threadId),
          kind: "run_result",
          idempotencyKey: `${input.runId}:budget_failure`,
          createdAt: now,
        });
        if (delivery) {
          const created = await appendEventInTransaction(tx, {
            spaceId: input.spaceId,
            threadId: input.threadId,
            botId: input.botId,
            runId: input.runId,
            type: "delivery.created",
            payload: { deliveryId: delivery.id, sourceRunId: input.runId },
          });
          lastSeq = created.seq;
        }
      }
    }
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    if (input.outcome === "completed") {
      await tx.steeringMessage.deleteMany({
        where: { runId: input.runId, claimedAt: { not: null } },
      });
      await tx.steeringMessage.updateMany({
        where: { runId: input.runId },
        data: { runId: null },
      });
    } else {
      const { sourceMessage } = await tx.run.findUniqueOrThrow({
        where: { id: input.runId },
        select: { sourceMessage: { select: { seq: true } } },
      });
      // A continuation's source is the newest steering it was created for. Only newer
      // messages justify another run after failure, even if setup failed before claiming.
      await tx.steeringMessage.updateMany({
        where: {
          runId: input.runId,
          message: sourceMessage ? { seq: { gt: sourceMessage.seq } } : undefined,
        },
        data: { runId: null },
      });
    }
    const continuationRunId = await continueReleasedSteeringInTransaction(tx, input);
    await tx.bot.update({ where: { id: input.botId }, data: { updatedAt: now } });
    return { threadId: lastEvent.threadId, seq: lastSeq, continuationRunId };
  });
}

/** One queued continuation for released steering. Does not acquire session admission. */
export async function continueReleasedSteeringInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string },
): Promise<string | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.botId}), hashtext(${input.threadId}))`;
  const { botMayContinueConversation } = await import("./cancel-terminal.js");
  if (!(await botMayContinueConversation(tx, input.botId, input.threadId))) return null;
  const active = await tx.run.findFirst({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
    },
    select: { id: true },
  });
  if (active) return null;
  const pending = await tx.steeringMessage.findMany({
    where: {
      botId: input.botId,
      runId: null,
      message: { threadId: input.threadId },
    },
    include: { message: { select: { id: true, blocks: true, seq: true } } },
    orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
  });
  if (pending.length === 0) return null;
  // One origin per continuation so a group channel and a direct chat are not answered together.
  const origin = steeringOrigin(pending[0]!);
  const batch = pending.filter((item) => steeringOrigin(item) === origin);
  const source = batch.at(-1)!;
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId: batch[0]!.userId,
      prompt: "Respond to the user's steering context.",
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      userId: batch[0]!.userId,
      status: "queued",
      trigger: origin === "app" ? "follow_up" : "messaging",
      sourceMessageId: source.message.id,
    },
  });
  await tx.steeringMessage.updateMany({
    where: { id: { in: batch.map((item) => item.id) }, runId: null },
    data: { runId: run.id, claimedAt: null },
  });
  return run.id;
}

function steeringOrigin(item: {
  originTrigger: string | null;
  message: { blocks: unknown };
}): string {
  if (item.originTrigger !== "messaging") return "app";
  const channelId = messagingChannelId(item.message.blocks as MessageBlock[] | undefined);
  return channelId ? `channel:${channelId}` : "dm";
}

export async function appendEventInTransaction(
  tx: Prisma.TransactionClient,
  input: AppendEventInput,
) {
  assertProductEventPayload(input.type, input.payload);
  if (
    input.schemaVersion !== undefined &&
    (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1)
  ) {
    throw new Error("Event schemaVersion must be a positive integer");
  }
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: { nextEventSeq: { increment: 1 } },
    select: { nextEventSeq: true },
  });
  if (input.execution) {
    if (!input.runId) throw new Error("An execution fence requires a runId");
    await assertActiveExecutionFence(tx, { runId: input.runId, ...input.execution });
  }
  // run.cancelled is appended after the run row already reads cancelled, so it
  // asserts the terminal status where every other event needs a writable run.
  // thread.artifact is a Thread-maintenance membership fact (user-initiated
  // Artifact delete, or an attach inside a live Run): the linked Run may
  // already be terminal, and the event exists precisely so that change moves
  // the Run's snapshot rev. Other events can reach completed/failed Runs
  // (for example background-task and delivery events), but their writers
  // must prevent an old-generation Run from receiving lifecycle events after
  // Thread Clear. The execution-history generation fence depends on that
  // write-path invariant; check it for every new terminal-Run event path.
  if (input.type === "run.cancelled") {
    await assertRunIsCancelled(tx, input.runId);
  } else if (input.type !== "thread.artifact") {
    await assertRunCanWriteHistory(tx, input.runId, {
      allowTypedCancel: input.allowTypedCancel,
    });
  }
  // Unpaired UTF-16 surrogates (e.g. a split emoji high half) are invalid JSON for Postgres.
  const payload = sanitizeJsonValue(input.payload);
  return tx.event.create({
    data: {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      seq: thread.nextEventSeq - 1,
      type: input.type,
      payload: payload as Prisma.InputJsonValue,
      runId: input.runId,
      schemaVersion: input.schemaVersion ?? 1,
      causationId: input.causationId,
      parentRunId: input.parentRunId,
    },
  });
}

async function notifyRealtime(
  realtime: RealtimeFanout | undefined,
  threadId: string,
  cursor: number,
): Promise<void> {
  await realtime?.publish(threadTopic(threadId), JSON.stringify({ cursor })).catch(() => undefined);
}

export async function eventsAfter(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  limit?: number,
) {
  return prisma.event.findMany({
    where: { threadId, seq: { gt: cursor } },
    orderBy: { seq: "asc" },
    ...(limit ? { take: limit } : {}),
  });
}

/** The most recent clear event is the only durable generation boundary. */
export async function currentThreadGeneration(
  prisma: PrismaClient | Prisma.TransactionClient,
  threadId: string,
): Promise<number> {
  const clear = await prisma.event.findFirst({
    where: { threadId, type: "thread.cleared" },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return clear?.seq ?? 0;
}

export async function* followThreadEvents(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  realtime?: RealtimeFanout,
  signal?: AbortSignal,
  catchUpMs = realtime ? PUSH_CATCH_UP_MS : POLL_ONLY_CATCH_UP_MS,
): AsyncGenerator<ProductEvent> {
  let seq = cursor;
  const latch = new ChangeLatch();
  const unsubscribe = realtime
    ? await realtime
        .subscribe(threadTopic(threadId), () => latch.notify())
        .catch(() => async () => {})
    : async () => {};
  try {
    while (!signal?.aborted) {
      const observedGeneration = latch.generation;
      let batchSize = 0;
      do {
        const events = await eventsAfter(prisma, threadId, seq, EVENT_BATCH_SIZE);
        batchSize = events.length;
        for (const event of events) {
          seq = event.seq;
          yield mapProductEvent(event);
        }
      } while (batchSize === EVENT_BATCH_SIZE && !signal?.aborted);
      if (signal?.aborted) break;
      await latch.waitForChange(observedGeneration, catchUpMs, signal);
    }
  } finally {
    await unsubscribe();
  }
}

function threadTopic(threadId: string): string {
  return `thread:${threadId}`;
}

function mapProductEvent(event: {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  seq: number;
  type: string;
  payload: unknown;
  runId: string | null;
  schemaVersion?: number | null;
  causationId?: string | null;
  parentRunId?: string | null;
  createdAt: Date;
}): ProductEvent {
  return {
    id: event.id,
    eventId: event.id,
    schemaVersion: event.schemaVersion ?? 1,
    causationId: event.causationId ?? undefined,
    parentRunId: event.parentRunId ?? undefined,
    spaceId: event.spaceId,
    threadId: event.threadId,
    botId: event.botId,
    seq: event.seq,
    type: event.type as ProductEvent["type"],
    runId: event.runId ?? undefined,
    createdAt: event.createdAt.toISOString(),
    payload: event.payload as Record<string, unknown>,
  };
}

class ChangeLatch {
  generation = 0;
  private wake: (() => void) | undefined;

  notify(): void {
    this.generation += 1;
    this.wake?.();
  }

  async waitForChange(expected: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.generation !== expected || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        if (this.wake === finish) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.wake = finish;
      signal?.addEventListener("abort", finish, { once: true });
      if (this.generation !== expected || signal?.aborted) finish();
    });
  }
}
