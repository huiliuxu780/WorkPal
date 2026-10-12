import { runJobKey } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

export type BackgroundCancelIdentity = {
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  runId: string;
};

/**
 * Finish durable background-task cancellation outside any database transaction.
 * A thrown transport error leaves status `cancelling` so the Worker retries.
 * `false` is the AgentScope 404: the native task is already gone.
 */
export async function revokeCancellingBackgroundTasks(
  prisma: PrismaClient,
  cancelBackgroundTask: (taskId: string, identity: BackgroundCancelIdentity) => Promise<boolean>,
  options?: { parentRunIds?: readonly string[]; limit?: number },
): Promise<{ revoked: string[]; pending: string[] }> {
  const tasks = await prisma.backgroundAgentTask.findMany({
    where: {
      status: "cancelling",
      ...(options?.parentRunIds ? { parentRunId: { in: [...options.parentRunIds] } } : {}),
    },
    orderBy: { startedAt: "asc" },
    take: options?.limit ?? 100,
  });
  const revoked: string[] = [];
  const pending: string[] = [];
  for (const task of tasks) {
    try {
      await cancelBackgroundTask(task.taskId, {
        userId: task.userId,
        spaceId: task.spaceId,
        botId: task.botId,
        threadId: task.threadId,
        runId: task.parentRunId,
      });
      const updated = await prisma.backgroundAgentTask.updateMany({
        where: { taskId: task.taskId, status: "cancelling" },
        data: { status: "cancelled", finishedAt: new Date() },
      });
      if (updated.count === 1) revoked.push(task.taskId);
    } catch {
      pending.push(task.taskId);
    }
  }
  return { revoked, pending };
}

const RUN_ABORT_KIND = "run_abort";
const BACKGROUND_TASK_KIND = "background_task";

function revocationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

/**
 * Abort each run now. A persisted run_abort row is deleted on success, including
 * a remote 404 that resolves without throwing. A thrown DELETE keeps the row and
 * records the error for the worker sweep.
 */
export async function deliverRunAborts(
  prisma: PrismaClient,
  abort: (runId: string) => Promise<void>,
  runIds: readonly string[],
): Promise<{ revoked: string[]; pending: string[] }> {
  const revoked: string[] = [];
  const pending: string[] = [];
  await Promise.all(
    runIds.map(async (runId) => {
      try {
        await abort(runId);
        await prisma.executionRevocation.deleteMany({
          where: { kind: RUN_ABORT_KIND, subjectId: runId },
        });
        revoked.push(runId);
      } catch (error) {
        await prisma.executionRevocation.updateMany({
          where: { kind: RUN_ABORT_KIND, subjectId: runId },
          data: { attempts: { increment: 1 }, lastError: revocationError(error) },
        });
        pending.push(runId);
      }
    }),
  );
  return { revoked, pending };
}

/** Worker sweep: retry run aborts whose remote DELETE has not succeeded yet. */
export async function retryPendingRunAborts(
  prisma: PrismaClient,
  abort: (runId: string) => Promise<void>,
  options?: { runIds?: readonly string[]; limit?: number },
): Promise<{ revoked: string[]; pending: string[] }> {
  const rows = await prisma.executionRevocation.findMany({
    where: {
      kind: RUN_ABORT_KIND,
      ...(options?.runIds ? { subjectId: { in: [...options.runIds] } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: options?.limit ?? 100,
    select: { subjectId: true },
  });
  return deliverRunAborts(
    prisma,
    abort,
    rows.map((row) => row.subjectId),
  );
}

/**
 * Retry background-task tombstones. `false` is the AgentScope 404 and still
 * deletes the tombstone. A throw keeps it for the next worker pass.
 */
export async function retryPendingBackgroundRevocations(
  prisma: PrismaClient,
  cancelBackgroundTask: (taskId: string, identity: BackgroundCancelIdentity) => Promise<boolean>,
  options?: { taskIds?: readonly string[]; limit?: number },
): Promise<{ revoked: string[]; pending: string[] }> {
  const rows = await prisma.executionRevocation.findMany({
    where: {
      kind: BACKGROUND_TASK_KIND,
      ...(options?.taskIds ? { subjectId: { in: [...options.taskIds] } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: options?.limit ?? 100,
  });
  const revoked: string[] = [];
  const pending: string[] = [];
  await Promise.all(
    rows.map(async (row) => {
      const taskId = row.taskId || row.subjectId;
      try {
        await cancelBackgroundTask(taskId, {
          userId: row.userId,
          spaceId: row.spaceId,
          botId: row.botId,
          threadId: row.threadId,
          runId: row.runId,
        });
        await prisma.executionRevocation.deleteMany({ where: { id: row.id } });
        revoked.push(taskId);
      } catch (error) {
        await prisma.executionRevocation.updateMany({
          where: { id: row.id },
          data: { attempts: { increment: 1 }, lastError: revocationError(error) },
        });
        pending.push(taskId);
      }
    }),
  );
  return { revoked, pending };
}

/** Job cancel plus immediate runtime abort. Remote abort failure stays in the outbox. */
export async function revokeCancelledRunHandles(
  runIds: readonly string[],
  deps: {
    jobs: { cancel: (key: string) => Promise<unknown> };
    abort?: (runId: string) => Promise<void>;
    prisma?: PrismaClient;
  },
): Promise<void> {
  await Promise.all(runIds.map((runId) => deps.jobs.cancel(runJobKey(runId)).catch(() => undefined)));
  if (!deps.abort || runIds.length === 0) return;
  if (deps.prisma) {
    await deliverRunAborts(deps.prisma, deps.abort, runIds);
    return;
  }
  await Promise.all(runIds.map((runId) => deps.abort!(runId).catch(() => undefined)));
}
