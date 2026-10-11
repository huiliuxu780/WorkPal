import { type AutomaticRetryReason, automaticRetryDelayMs } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";

export async function scheduleAutomaticRunRetry(
  prisma: PrismaClient,
  input: {
    runId: string;
    attemptId: string;
    leaseOwner: string;
    leaseFence: number;
    reason: AutomaticRetryReason;
    error: string;
  },
  now = new Date(),
): Promise<{ retryAt: Date; attempt: number; seq: number } | null> {
  const lookup = await prisma.run.findUnique({
    where: { id: input.runId },
    select: { threadId: true },
  });
  if (!lookup) return null;
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT "id" FROM "threads" WHERE "id" = ${lookup.threadId} FOR UPDATE`;
    const run = await tx.run.findUnique({ where: { id: input.runId } });
    if (
      run?.status !== "running" ||
      run.leaseOwner !== input.leaseOwner ||
      run.leaseFence !== input.leaseFence
    )
      return null;
    const [completedAutoRetries, previousTool, effect] = await Promise.all([
      tx.attempt.count({ where: { runId: run.id, status: "retry_scheduled" } }),
      tx.event.findFirst({
        where: { runId: run.id, type: "agent.tool.called" },
        select: { id: true },
      }),
      tx.externalEffect.findFirst({
        where: {
          runId: run.id,
          status: { in: ["intended", "approved", "executing", "completed"] },
        },
        select: { id: true },
      }),
    ]);
    const delay = automaticRetryDelayMs({
      completedAutoRetries,
      reason: input.reason,
      hasCommittedOrUncertainEffect: Boolean(effect),
      hasToolCall: Boolean(previousTool),
    });
    if (delay === null) return null;
    const retryAt = new Date(now.getTime() + delay);
    const attempt = completedAutoRetries + 2;
    const currentAttempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: run.id,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "retry_scheduled", error: input.error, finishedAt: now },
    });
    if (currentAttempt.count !== 1) return null;
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "run.retried",
      schemaVersion: 2,
      payload: { attempt, reason: input.reason },
    });
    const queued = await tx.run.updateMany({
      where: {
        id: run.id,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: "queued",
        waitKind: null,
        error: input.error,
        retryAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (queued.count !== 1) throw new Error("Run changed while scheduling retry");
    await tx.task.updateMany({ where: { id: run.taskId }, data: { status: "queued" } });
    return { retryAt, attempt, seq: event.seq };
  });
}
