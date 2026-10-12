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
