import { ACTIVE_RUN_STATUSES, parseRunOrchestration } from "@rakazo/core";
import { applyCancelTerminalPolicy, cancelPolicyFor } from "./cancel-terminal.js";
import { Prisma, type PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { appendEventInTransaction } from "./events.js";

/** Reconcile children after any parent cancellation path, including an interrupted request.
 * With parent IDs, synchronously walk their full descendant tree for a user cancellation.
 */
export async function cancelChildrenOfCancelledRuns(
  prisma: PrismaClient,
  parentRunIds?: readonly string[],
) {
  if (parentRunIds?.length === 0) return [];
  let frontier = parentRunIds ? [...new Set(parentRunIds)] : null;
  const cancelled: Array<{ id: string; threadId: string; seq: number }> = [];
  do {
    const parentFilter = frontier
      ? Prisma.sql`AND (child."orchestration" #>> '{collaboration,parentRunId}') IN (${Prisma.join(frontier)})`
      : Prisma.empty;
    const candidates = await prisma.$queryRaw<Array<{ id: string; threadId: string }>>`
    SELECT child."id", child."threadId"
    FROM "runs" child
    LEFT JOIN "runs" parent ON parent."id" =
      (child."orchestration" #>> '{collaboration,parentRunId}')
    WHERE (child."orchestration" #>> '{collaboration,parentRunId}') IS NOT NULL
      AND (parent."status" = 'cancelled' OR parent."id" IS NULL)
      AND child."status" IN ('queued', 'leased', 'running', 'waiting_input', 'waiting_takeover')
      ${parentFilter}
    ORDER BY child."createdAt", child."id"
    ${frontier ? Prisma.empty : Prisma.sql`LIMIT 100`}
  `;
    const nextFrontier: string[] = [];
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
      const settled = await applyCancelTerminalPolicy(tx, [child], new Date(), {
        policy: cancelPolicyFor("parent_cancelled"),
        cancelOptions: { error: "parent_cancelled" },
        appendEvents: false,
      });
      if (settled.rows.length === 0) return null;
      await expireComputerExecutionLeases(tx, { runId: child.id });
      const event = await appendEventInTransaction(tx, {
        spaceId: child.spaceId,
        threadId: child.threadId,
        botId: child.botId,
        runId: child.id,
        parentRunId,
        type: "run.cancelled",
        payload: { reason: "parent_cancelled", reportDelegationOutcome: true, steering: "retain_unhandled" },
      });
      return { id: child.id, threadId: child.threadId, seq: event.seq };
    });
      if (result) {
        cancelled.push(result);
        nextFrontier.push(result.id);
      }
    }
    frontier = frontier ? nextFrontier : null;
  } while (frontier && frontier.length > 0);
  return cancelled;
}

/** Every descendant id, including runs already cancelled, so callers can abort them. */
export async function listDescendantRunIds(
  prisma: PrismaClient,
  parentRunIds: readonly string[],
): Promise<string[]> {
  if (parentRunIds.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE tree AS (
      SELECT "id", 1 AS depth
      FROM "runs"
      WHERE ("orchestration" #>> '{collaboration,parentRunId}') IN (${Prisma.join(parentRunIds)})
      UNION ALL
      SELECT child."id", tree.depth + 1
      FROM "runs" child
      INNER JOIN tree ON (child."orchestration" #>> '{collaboration,parentRunId}') = tree."id"
      WHERE tree.depth < 32
    )
    SELECT "id" FROM tree
  `;
  return rows.map((row) => row.id);
}
