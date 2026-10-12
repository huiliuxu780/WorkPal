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

/**
 * Ask AgentScope to drop tasks whose projection rows are about to disappear.
 * A transport failure cannot be retried once the cascade deletes those rows.
 */
export async function revokeBackgroundSnapshots(
  cancelBackgroundTask: (taskId: string, identity: BackgroundCancelIdentity) => Promise<boolean>,
  tasks: ReadonlyArray<BackgroundCancelIdentity & { taskId: string }>,
): Promise<void> {
  await Promise.all(
    tasks.map((task) =>
      cancelBackgroundTask(task.taskId, {
        userId: task.userId,
        spaceId: task.spaceId,
        botId: task.botId,
        threadId: task.threadId,
        runId: task.runId,
      }).catch(() => undefined),
    ),
  );
}

/** Best-effort job cancel and runtime abort. Failures stay recoverable by the Worker sweep. */
export async function revokeCancelledRunHandles(
  runIds: readonly string[],
  deps: {
    jobs: { cancel: (key: string) => Promise<unknown> };
    abort?: (runId: string) => Promise<void>;
  },
): Promise<void> {
  await Promise.all(
    runIds.flatMap((runId) => [
      deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
      deps.abort?.(runId).catch(() => undefined) ?? Promise.resolve(),
    ]),
  );
}
