import type { Prisma } from "./client.js";

export const RUN_ABORT_KIND = "run_abort";
export const BACKGROUND_TASK_KIND = "background_task";

export type BackgroundRevocationInput = {
  taskId: string;
  runId: string;
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
};

type RevocationWriter = Partial<Pick<Prisma.TransactionClient, "executionRevocation">>;

/** Record remote run aborts that must survive the business-row transaction. */
export async function recordRunAbortRevocations(
  tx: RevocationWriter,
  runIds: readonly string[],
): Promise<void> {
  if (!tx.executionRevocation || runIds.length === 0) return;
  await tx.executionRevocation.createMany({
    data: runIds.map((runId) => ({
      kind: RUN_ABORT_KIND,
      subjectId: runId,
      runId,
    })),
    skipDuplicates: true,
  });
}

/**
 * Record background-task DELETEs before a cascade removes BackgroundAgentTask.
 * Callers pass the identity captured from the still-present row.
 */
export async function recordBackgroundRevocations(
  tx: RevocationWriter,
  tasks: readonly BackgroundRevocationInput[],
): Promise<void> {
  if (!tx.executionRevocation || tasks.length === 0) return;
  await tx.executionRevocation.createMany({
    data: tasks.map((task) => ({
      kind: BACKGROUND_TASK_KIND,
      subjectId: task.taskId,
      runId: task.runId,
      taskId: task.taskId,
      userId: task.userId,
      spaceId: task.spaceId,
      botId: task.botId,
      threadId: task.threadId,
    })),
    skipDuplicates: true,
  });
}

const LIVE_BACKGROUND_STATUSES = ["running", "cancelling"] as const;

const liveBackgroundSelect = {
  taskId: true,
  parentRunId: true,
  userId: true,
  spaceId: true,
  botId: true,
  threadId: true,
} as const;

export type LiveBackgroundTask = {
  taskId: string;
  parentRunId: string;
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
};

type BackgroundTaskStore = Partial<Pick<Prisma.TransactionClient, "backgroundAgentTask">>;

/**
 * Native background work can still be running after its parent Run is completed.
 * Callers select the business object (bot, group thread, removed members, or
 * dissolved threads). An absent delegate keeps partial unit-test transactions quiet.
 */
export async function findLiveBackgroundTasks(
  tx: BackgroundTaskStore,
  where: Prisma.BackgroundAgentTaskWhereInput,
): Promise<LiveBackgroundTask[]> {
  if (!tx.backgroundAgentTask) return [];
  return tx.backgroundAgentTask.findMany({
    where: { AND: [where, { status: { in: [...LIVE_BACKGROUND_STATUSES] } }] },
    select: liveBackgroundSelect,
  });
}

/** Keep the projection. A failed DELETE stays `cancelling` for the worker sweep. */
export async function markLiveBackgroundTasksCancelling(
  tx: BackgroundTaskStore,
  where: Prisma.BackgroundAgentTaskWhereInput,
): Promise<LiveBackgroundTask[]> {
  const tasks = await findLiveBackgroundTasks(tx, where);
  if (!tx.backgroundAgentTask || tasks.length === 0) return [];
  await tx.backgroundAgentTask.updateMany({
    where: {
      taskId: { in: tasks.map((task) => task.taskId) },
      status: { in: [...LIVE_BACKGROUND_STATUSES] },
    },
    data: { status: "cancelling" },
  });
  return tasks;
}

/** Parent runs that this call did not already cancel. Those still need their own revoke. */
export function backgroundParentRunIdsExcept(
  tasks: readonly { parentRunId: string }[],
  coveredRunIds: readonly string[],
): string[] {
  const covered = new Set(coveredRunIds);
  return [
    ...new Set(tasks.map((task) => task.parentRunId).filter((runId) => !covered.has(runId))),
  ];
}
