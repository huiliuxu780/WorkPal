import { ACTIVE_RUN_STATUSES, parseRunOrchestration } from "@rakazo/core";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { appendEventInTransaction } from "./events.js";

/** Reconcile children after any parent cancellation path, including an interrupted request. */
export async function cancelChildrenOfCancelledRuns(prisma: PrismaClient) {
  const candidates = await prisma.$queryRaw<Array<{ id: string; threadId: string }>>`
    SELECT child."id", child."threadId"
    FROM "runs" child
    LEFT JOIN "runs" parent ON parent."id" =
      (child."orchestration" #>> '{collaboration,parentRunId}')
    WHERE (child."orchestration" #>> '{collaboration,parentRunId}') IS NOT NULL
      AND (parent."status" = 'cancelled' OR parent."id" IS NULL)
      AND child."status" IN ('queued', 'leased', 'running', 'waiting_input', 'waiting_takeover')
    ORDER BY child."createdAt", child."id"
    LIMIT 100
  `;
  const cancelled: Array<{ id: string; threadId: string; seq: number }> = [];
  for (const candidate of candidates) {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT "id" FROM "threads" WHERE "id" = ${candidate.threadId} FOR UPDATE`;
      const child = await tx.run.findUnique({ where: { id: candidate.id } });
      if (
        !child ||
        !ACTIVE_RUN_STATUSES.includes(child.status as (typeof ACTIVE_RUN_STATUSES)[number])
      ) {
        return null;
      }
      const parentRunId = parseRunOrchestration(child.orchestration)?.collaboration?.parentRunId;
      if (!parentRunId) return null;
      const parent = await tx.run.findUnique({
        where: { id: parentRunId },
        select: { status: true },
      });
      if (parent && parent.status !== "cancelled") return null;
      await cancelRunsInTransaction(tx, [child], new Date());
      await tx.run.update({ where: { id: child.id }, data: { error: "parent_cancelled" } });
      await expireComputerExecutionLeases(tx, { runId: child.id });
      const event = await appendEventInTransaction(tx, {
        spaceId: child.spaceId,
        threadId: child.threadId,
        botId: child.botId,
        runId: child.id,
        parentRunId,
        type: "run.cancelled",
        payload: { reason: "parent_cancelled" },
      });
      return { id: child.id, threadId: child.threadId, seq: event.seq };
    });
    if (result) cancelled.push(result);
  }
  return cancelled;
}
