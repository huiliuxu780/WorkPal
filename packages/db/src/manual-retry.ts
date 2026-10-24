import type { ManualRetryDenyReason, ManualRetryOutput } from "@rakazo/contracts";
import {
  buildRunOrchestration,
  isManualRetryActiveStatus,
  isManualRetryEligibleTrigger,
  isRootRunOrchestration,
  MANUAL_RETRY_ACTIVE_STATUSES,
  parseRunOrchestration,
  projectManualRetryEligibility,
  turnExecutionForSource,
  turnPolicySourceForTrigger,
  userTurnCollaboration,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { executionEventCeilings } from "./execution-history.js";
import { IsolationError } from "./scope.js";
import {
  readTaskInstructionEnvelopeInTransaction,
  TaskInstructionIntegrityError,
} from "./task-instructions.js";

const GROUP_MEMBER_MIN = 2;

export class ManualRetryDenied extends Error {
  readonly reason: ManualRetryDenyReason;

  constructor(reason: ManualRetryDenyReason, message = reason) {
    super(message);
    this.name = "ManualRetryDenied";
    this.reason = reason;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function uniqueTarget(error: unknown): string[] {
  const target = (error as { meta?: { target?: string[] | string } }).meta?.target;
  if (target == null) return [];
  return Array.isArray(target) ? target : [target];
}

function hitsRetryOfRunId(error: unknown): boolean {
  return uniqueTarget(error).some(
    (field) => field === "retryOfRunId" || field.includes("retryOfRunId"),
  );
}

function hitsClientNonce(error: unknown): boolean {
  return uniqueTarget(error).some(
    (field) =>
      field === "clientNonce" ||
      field.includes("clientNonce") ||
      field.includes("spaceId_clientNonce"),
  );
}

type RunRow = {
  id: string;
  spaceId: string;
  botId: string;
  threadId: string;
  taskId: string;
  userId: string;
  status: string;
  trigger: string;
  orchestration: unknown;
  sourceMessageId: string | null;
  routineId: string | null;
  retryOfRunId: string | null;
};

type DbLike = PrismaClient | Prisma.TransactionClient;

async function loadRun(tx: DbLike, runId: string): Promise<RunRow | null> {
  return tx.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      spaceId: true,
      botId: true,
      threadId: true,
      taskId: true,
      userId: true,
      status: true,
      trigger: true,
      orchestration: true,
      sourceMessageId: true,
      routineId: true,
      retryOfRunId: true,
    },
  });
}

async function latestHop(tx: DbLike, start: RunRow): Promise<RunRow> {
  let current = start;
  const seen = new Set([start.id]);
  for (;;) {
    const next = await tx.run.findUnique({
      where: { retryOfRunId: current.id },
      select: {
        id: true,
        spaceId: true,
        botId: true,
        threadId: true,
        taskId: true,
        userId: true,
        status: true,
        trigger: true,
        orchestration: true,
        sourceMessageId: true,
        routineId: true,
        retryOfRunId: true,
      },
    });
    if (!next || seen.has(next.id)) return current;
    seen.add(next.id);
    current = next;
  }
}

export async function loadManualRetryPredecessorIds(
  db: PrismaClient | Prisma.TransactionClient,
  runId: string,
): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let current = runId;
  for (;;) {
    const row = await db.run.findUnique({
      where: { id: current },
      select: { retryOfRunId: true },
    });
    if (!row?.retryOfRunId || seen.has(row.retryOfRunId)) return ids;
    seen.add(row.retryOfRunId);
    ids.push(row.retryOfRunId);
    current = row.retryOfRunId;
  }
}

function retryOrchestration(run: RunRow) {
  const parsed = parseRunOrchestration(run.orchestration);
  const source = turnPolicySourceForTrigger(run.trigger);
  const kind =
    parsed?.routing.kind ??
    (source === "bot_message"
      ? "bot_message"
      : source === "handoff"
        ? "handoff"
        : source === "automation"
          ? "automation"
          : "direct");
  return buildRunOrchestration({
    kind,
    ownerBotId: parsed?.ownership.ownerBotId ?? run.botId,
    responseMode: parsed?.responseMode ?? "single",
    reasonCode: parsed?.routing.reasonCode,
    ownershipMode: parsed?.ownership.mode,
    execution: turnExecutionForSource(source),
    collaboration: parsed?.collaboration ?? userTurnCollaboration(),
  });
}

async function chainIds(tx: DbLike, start: RunRow): Promise<Set<string>> {
  const latest = await latestHop(tx, start);
  const ancestors = await loadManualRetryPredecessorIds(tx, latest.id);
  return new Set([latest.id, ...ancestors]);
}

async function assertNonceBelongsToSource(
  tx: DbLike,
  source: RunRow,
  hit: { id: string; taskId: string },
): Promise<void> {
  if (hit.taskId !== source.taskId) {
    throw new ManualRetryDenied("nonce_conflict");
  }
  const ids = await chainIds(tx, source);
  if (!ids.has(hit.id)) {
    throw new ManualRetryDenied("nonce_conflict");
  }
}

async function replayNonceHit(
  tx: DbLike,
  input: { spaceId: string; userId: string; runId: string },
  source: RunRow,
  hit: Pick<RunRow, "id" | "taskId" | "threadId" | "botId">,
): Promise<ManualRetryOutput> {
  await assertNonceBelongsToSource(tx, source, hit);
  const target = await authorizeThread(tx, {
    spaceId: input.spaceId,
    userId: input.userId,
    threadId: hit.threadId,
    botId: hit.botId,
  });
  return outputFor(input.runId, hit, target, true);
}

async function authorizeThread(
  tx: DbLike,
  input: { spaceId: string; userId: string; threadId: string; botId: string },
): Promise<ManualRetryOutput["target"]> {
  const thread = await tx.thread.findUnique({
    where: { id: input.threadId },
    select: { id: true, spaceId: true, botId: true, groupId: true },
  });
  if (!thread || thread.spaceId !== input.spaceId) {
    throw new ManualRetryDenied("not_found");
  }
  const bot = await tx.bot.findUnique({
    where: { id: input.botId },
    select: { id: true, spaceId: true, userId: true, archivedAt: true },
  });
  if (!bot || bot.spaceId !== input.spaceId || bot.archivedAt) {
    throw new ManualRetryDenied("bot_unavailable");
  }
  if (thread.botId) {
    if (thread.botId !== input.botId) throw new ManualRetryDenied("forbidden");
    if (bot.userId !== input.userId) throw new ManualRetryDenied("forbidden");
    return { kind: "bot", botId: thread.botId };
  }
  if (thread.groupId) {
    const group = await tx.chatGroup.findFirst({
      where: {
        id: thread.groupId,
        spaceId: input.spaceId,
        userId: input.userId,
        archivedAt: null,
      },
      select: { id: true },
    });
    if (!group) throw new ManualRetryDenied("forbidden");
    const members = await tx.chatGroupMember.count({
      where: { groupId: group.id, bot: { archivedAt: null } },
    });
    if (members < GROUP_MEMBER_MIN) throw new ManualRetryDenied("forbidden");
    return { kind: "group", groupId: group.id };
  }
  throw new ManualRetryDenied("forbidden");
}

async function assertGenerationAlive(tx: Prisma.TransactionClient, runId: string): Promise<void> {
  const ceilings = await executionEventCeilings(tx, [runId]);
  const lifecycleSeq = ceilings.get(runId)?.lifecycleSeq;
  if (lifecycleSeq === undefined || lifecycleSeq === null) {
    throw new ManualRetryDenied("thread_cleared");
  }
}

function outputFor(
  sourceRunId: string,
  run: Pick<RunRow, "id" | "taskId" | "threadId" | "botId">,
  target: ManualRetryOutput["target"],
  replayed: boolean,
): ManualRetryOutput {
  return {
    sourceRunId,
    runId: run.id,
    taskId: run.taskId,
    threadId: run.threadId,
    botId: run.botId,
    replayed,
    target,
  };
}

export async function createManualRetryRun(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; runId: string; clientNonce: string },
): Promise<ManualRetryOutput> {
  try {
    return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const source = await loadRun(tx, input.runId);
      if (!source || source.spaceId !== input.spaceId) {
        throw new ManualRetryDenied("not_found");
      }
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${source.threadId} FOR UPDATE`;
      const locked = await loadRun(tx, source.id);
      if (!locked) throw new ManualRetryDenied("not_found");

      if (!isRootRunOrchestration(locked.orchestration)) {
        throw new ManualRetryDenied("not_root");
      }
      if (!isManualRetryEligibleTrigger(locked.trigger)) {
        throw new ManualRetryDenied("ineligible_trigger");
      }

      const target = await authorizeThread(tx, {
        spaceId: input.spaceId,
        userId: input.userId,
        threadId: locked.threadId,
        botId: locked.botId,
      });
      await assertGenerationAlive(tx, locked.id);

      const nonceHit = await tx.run.findUnique({
        where: { spaceId_clientNonce: { spaceId: input.spaceId, clientNonce: input.clientNonce } },
        select: {
          id: true,
          taskId: true,
          threadId: true,
          botId: true,
          retryOfRunId: true,
        },
      });
      if (nonceHit) {
        return replayNonceHit(tx, input, locked, nonceHit);
      }

      const latest = await latestHop(tx, locked);
      if (isManualRetryActiveStatus(latest.status)) {
        return outputFor(input.runId, latest, target, true);
      }
      if (latest.status === "completed") {
        throw new ManualRetryDenied("completed");
      }
      if (latest.status !== "failed" && latest.status !== "cancelled") {
        throw new ManualRetryDenied("not_terminal");
      }

      const busy = await tx.run.findFirst({
        where: {
          threadId: latest.threadId,
          botId: latest.botId,
          status: { in: [...MANUAL_RETRY_ACTIVE_STATUSES] },
        },
        select: { id: true },
      });
      if (busy) throw new ManualRetryDenied("thread_busy");

      const existingSuccessor = await tx.run.findUnique({
        where: { retryOfRunId: latest.id },
        select: { id: true, taskId: true, threadId: true, botId: true },
      });
      if (existingSuccessor) {
        return outputFor(input.runId, existingSuccessor, target, true);
      }

      let instructions: Awaited<ReturnType<typeof readTaskInstructionEnvelopeInTransaction>>;
      try {
        instructions = await readTaskInstructionEnvelopeInTransaction(tx, {
          taskId: latest.taskId,
          spaceId: latest.spaceId,
          threadId: latest.threadId,
        });
      } catch (error) {
        if (error instanceof TaskInstructionIntegrityError) {
          throw new ManualRetryDenied("thread_cleared");
        }
        throw error;
      }
      if (!instructions) throw new ManualRetryDenied("not_found");

      const created = await tx.run.create({
        data: {
          spaceId: latest.spaceId,
          botId: latest.botId,
          threadId: latest.threadId,
          taskId: latest.taskId,
          userId: latest.userId,
          status: "queued",
          // A manual retry executes the instruction revision the user chose to
          // retry. Later amendments are steering, not silent input drift.
          consumedRevision: instructions.revision,
          trigger: latest.trigger,
          sourceMessageId: latest.sourceMessageId,
          routineId: latest.routineId,
          clientNonce: input.clientNonce,
          retryOfRunId: latest.id,
          orchestration: retryOrchestration(latest) as Prisma.InputJsonValue,
        },
        select: { id: true, taskId: true, threadId: true, botId: true },
      });
      await tx.task.updateMany({
        where: { id: latest.taskId },
        data: { status: "queued" },
      });
      await appendEventInTransaction(tx, {
        spaceId: latest.spaceId,
        threadId: latest.threadId,
        botId: latest.botId,
        runId: created.id,
        type: "run.manual_retry_requested",
        payload: {
          sourceRunId: latest.id,
          taskId: latest.taskId,
          actorUserId: input.userId,
        },
      });
      return outputFor(input.runId, created, target, false);
    });
  } catch (error) {
    if (error instanceof ManualRetryDenied) throw error;
    if (error instanceof IsolationError) throw new ManualRetryDenied("not_found");
    if (isUniqueViolation(error)) {
      const replayed = await recoverUniqueCollision(prisma, input, error);
      if (replayed) return replayed;
    }
    throw error;
  }
}

async function recoverUniqueCollision(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; runId: string; clientNonce: string },
  error: unknown,
): Promise<ManualRetryOutput | null> {
  const source = await loadRun(prisma, input.runId);
  if (!source || source.spaceId !== input.spaceId) return null;

  if (hitsClientNonce(error) || uniqueTarget(error).length === 0) {
    const byNonce = await prisma.run.findUnique({
      where: { spaceId_clientNonce: { spaceId: input.spaceId, clientNonce: input.clientNonce } },
      select: {
        id: true,
        taskId: true,
        threadId: true,
        botId: true,
        spaceId: true,
        retryOfRunId: true,
      },
    });
    if (byNonce && byNonce.spaceId === input.spaceId) {
      return replayNonceHit(prisma, input, source, byNonce);
    }
  }
  if (hitsRetryOfRunId(error) || uniqueTarget(error).length === 0) {
    const latest = await latestHop(prisma, source);
    const successor = await prisma.run.findUnique({
      where: { retryOfRunId: latest.id },
      select: { id: true, taskId: true, threadId: true, botId: true },
    });
    if (!successor || successor.taskId !== source.taskId) return null;
    const target = await authorizeThread(prisma, {
      spaceId: input.spaceId,
      userId: input.userId,
      threadId: successor.threadId,
      botId: successor.botId,
    });
    return outputFor(input.runId, successor, target, true);
  }
  return null;
}

export { projectManualRetryEligibility };
