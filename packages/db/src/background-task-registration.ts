import type { Prisma } from "./client.js";
import { currentThreadGeneration } from "./events.js";

/**
 * Registration and cancellation share one order:
 * bot advisory lock, then thread rows sorted by id, then the parent run.
 * Group row locks come after the thread row, the same order as Clear and Send.
 * A cascade delete locks the thread before it collects tasks or deletes rows.
 * Namespace 814230711 is distinct from the template-clone lock 814230701.
 */
export const BACKGROUND_TASK_BOT_LOCK_NAMESPACE = 814230711;

const LOCK_WAIT_MS = 20_000;

export const backgroundTaskLockTransactionOptions = {
  timeout: LOCK_WAIT_MS,
  maxWait: LOCK_WAIT_MS,
} as const;

export class BackgroundRegistrationRejected extends Error {
  constructor(message = "Parent run is no longer authorized") {
    super(message);
    this.name = "BackgroundRegistrationRejected";
  }
}

type LockClient = Pick<Prisma.TransactionClient, "$queryRaw">;

export async function lockBotBackgroundRegistration(tx: LockClient, botId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(${BACKGROUND_TASK_BOT_LOCK_NAMESPACE}::int, hashtext(${botId}))::text AS "lock"
  `;
}

/** @returns false when the thread row is already gone. */
export async function lockThreadForBackgroundTask(
  tx: LockClient,
  threadId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE
  `;
  return rows.length > 0;
}

/** Lock each distinct thread in id order so two multi-thread transactions cannot deadlock. */
export async function lockThreadsForBackgroundTasks(
  tx: LockClient,
  threadIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(threadIds.filter((threadId) => threadId.length > 0))].sort();
  for (const threadId of ids) {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
  }
}

export async function lockRunForBackgroundTask(tx: LockClient, runId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`;
}

export type RegisterBackgroundTaskInput = {
  taskId: string;
  runId: string;
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  agentId: string;
  sessionId: string;
  toolNames: readonly string[];
  expiresAt: Date;
};

/**
 * Create the projection only after the bot, thread, run, group, and membership
 * checks have passed under the locks above. A throw leaves no row.
 */
export async function registerBackgroundTaskProjection(
  tx: Prisma.TransactionClient,
  input: RegisterBackgroundTaskInput,
): Promise<{ threadGeneration: number }> {
  await lockBotBackgroundRegistration(tx, input.botId);
  const threadLocked = await lockThreadForBackgroundTask(tx, input.threadId);
  await lockRunForBackgroundTask(tx, input.runId);

  const run = await tx.run.findFirst({
    where: {
      id: input.runId,
      userId: input.userId,
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      status: "running",
    },
    select: { id: true },
  });
  const member = await tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
    select: { id: true },
  });
  const bot = await tx.bot.findFirst({
    where: { id: input.botId, spaceId: input.spaceId },
    select: { archivedAt: true },
  });
  const thread = threadLocked
    ? await tx.thread.findFirst({
        where: { id: input.threadId, spaceId: input.spaceId },
        select: { id: true, groupId: true },
      })
    : null;
  let groupOpen = true;
  if (thread?.groupId) {
    const group = await tx.chatGroup.findFirst({
      where: { id: thread.groupId, spaceId: input.spaceId },
      select: { archivedAt: true },
    });
    const membership = await tx.chatGroupMember.findUnique({
      where: { groupId_botId: { groupId: thread.groupId, botId: input.botId } },
      select: { botId: true },
    });
    groupOpen = Boolean(group && group.archivedAt === null && membership);
  }
  if (!run || !member || !bot || bot.archivedAt !== null || !thread || !groupOpen) {
    throw new BackgroundRegistrationRejected();
  }

  const threadGeneration = await currentThreadGeneration(tx, input.threadId);
  await tx.backgroundAgentTask.create({
    data: {
      taskId: input.taskId,
      parentRunId: input.runId,
      userId: input.userId,
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      threadGeneration,
      agentId: input.agentId,
      sessionId: input.sessionId,
      toolNames: [...input.toolNames],
      status: "running",
      expiresAt: input.expiresAt,
    },
  });
  return { threadGeneration };
}
