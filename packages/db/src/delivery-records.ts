import { Prisma, type PrismaClient } from "./client.js";

export const DELIVERY_MERGE_MS = 30_000;
export const DELIVERY_LEASE_MS = 120_000;
export const DELIVERY_RETRY_MS = [10_000, 30_000, 120_000, 600_000, 1_800_000] as const;
/** Per-query bound for the window claim loop; the loop repeats until the window is empty. */
const DELIVERY_CLAIM_CHUNK = 500;
/**
 * Defensive bound for one claimed window. A window this large cannot occur from
 * real Run completions; if it ever did, the overflow stays pending and merges
 * into the next claim for the same Thread instead of exhausting worker memory.
 */
export const DELIVERY_WINDOW_CLAIM_MAX = 5_000;
/** Keeps `IN (...)` expansions far below the PostgreSQL parameter limit. */
const ID_LIST_CHUNK = 1_000;

function idChunks(ids: readonly string[], size = ID_LIST_CHUNK): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += size) chunks.push(ids.slice(start, start + size));
  return chunks;
}

export type DeliveryKind = "background_task" | "routine" | "run_result";

export async function enqueueDeliveryInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    backgroundTaskId?: string;
    threadId: string;
    threadGeneration: number;
    kind: DeliveryKind;
    idempotencyKey: string;
    createdAt?: Date;
  },
) {
  const createdAt = input.createdAt ?? new Date();
  const inserted = await tx.deliveryRecord.createMany({
    data: [
      {
        ...input,
        createdAt,
        nextAttemptAt: new Date(createdAt.getTime() + DELIVERY_MERGE_MS),
        status: "pending",
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count === 0) return null;
  return tx.deliveryRecord.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
}

export type ClaimedDeliveryBatch = Awaited<ReturnType<typeof claimDueDeliveryBatch>>;

/** Claims one due Thread window. PostgreSQL row locks prevent competing workers from taking it. */
export async function claimDueDeliveryBatch(
  prisma: PrismaClient,
  workerId: string,
  now = new Date(),
) {
  return prisma.$transaction(async (tx) => {
    const first = await tx.$queryRaw<
      Array<{
        id: string;
        threadId: string;
        threadGeneration: number;
        createdAt: Date;
        deliveryRunId: string | null;
      }>
    >`
      SELECT candidate."id", candidate."threadId", candidate."threadGeneration",
             candidate."createdAt", candidate."deliveryRunId"
      FROM "delivery_records" AS candidate
      WHERE candidate."status" IN ('pending', 'claimed')
        AND candidate."nextAttemptAt" <= ${now}
        AND candidate."createdAt" <= ${new Date(now.getTime() - DELIVERY_MERGE_MS)}
        AND NOT EXISTS (
          SELECT 1 FROM "delivery_records" AS earlier
          WHERE earlier."threadId" = candidate."threadId"
            AND earlier."threadGeneration" = candidate."threadGeneration"
            AND earlier."status" IN ('pending', 'claimed')
            AND (earlier."createdAt", earlier."id") < (candidate."createdAt", candidate."id")
            AND earlier."createdAt" >= candidate."createdAt" - INTERVAL '30 seconds'
        )
      ORDER BY candidate."createdAt", candidate."id"
      LIMIT 1 FOR UPDATE SKIP LOCKED
    `;
    const seed = first[0];
    if (!seed) return [];
    const windowEnd = new Date(seed.createdAt.getTime() + DELIVERY_MERGE_MS);
    // One window must merge into exactly one delivery Run no matter how many
    // records it holds, so claim in bounded chunks until the window is empty
    // instead of capping the window itself. Records already selected in this
    // transaction are still 'pending' until the flip below, so exclude them.
    const ids: string[] = [];
    for (;;) {
      const exclusion = ids.length
        ? Prisma.sql`AND "id" NOT IN (${Prisma.join(ids)})`
        : Prisma.empty;
      const claimed = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "delivery_records"
        WHERE "threadId" = ${seed.threadId}
          AND "threadGeneration" = ${seed.threadGeneration}
          AND "deliveryRunId" IS NOT DISTINCT FROM ${seed.deliveryRunId}
          AND "status" IN ('pending', 'claimed')
          AND ("nextAttemptAt" <= ${now} OR ("status" = 'pending' AND "attempts" = 0))
          AND "createdAt" <= ${windowEnd}
          ${exclusion}
        ORDER BY "createdAt", "id"
        LIMIT ${DELIVERY_CLAIM_CHUNK} FOR UPDATE SKIP LOCKED
      `;
      if (claimed.length === 0) break;
      for (const row of claimed) ids.push(row.id);
      if (claimed.length < DELIVERY_CLAIM_CHUNK || ids.length >= DELIVERY_WINDOW_CLAIM_MAX) break;
    }
    if (ids.length === 0) return [];
    const rows: Array<{ id: string; status: string }> = [];
    for (const chunk of idChunks(ids)) {
      rows.push(
        ...(await tx.deliveryRecord.findMany({
          where: { id: { in: chunk } },
          select: { id: true, status: true },
        })),
      );
    }
    const pendingIds = rows.filter((row) => row.status === "pending").map((row) => row.id);
    const expiredLeaseIds = rows.filter((row) => row.status === "claimed").map((row) => row.id);
    for (const chunk of idChunks(pendingIds)) {
      await tx.deliveryRecord.updateMany({
        where: { id: { in: chunk } },
        data: {
          status: "claimed",
          claimedBy: workerId,
          nextAttemptAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
          attempts: { increment: 1 },
        },
      });
    }
    for (const chunk of idChunks(expiredLeaseIds)) {
      await tx.deliveryRecord.updateMany({
        where: { id: { in: chunk } },
        data: {
          claimedBy: workerId,
          nextAttemptAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
        },
      });
    }
    const claimedRows: Awaited<ReturnType<typeof tx.deliveryRecord.findMany>> = [];
    for (const chunk of idChunks(ids)) {
      claimedRows.push(...(await tx.deliveryRecord.findMany({ where: { id: { in: chunk } } })));
    }
    return claimedRows.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
  });
}

export function deliveryRetryAt(attempts: number, now = new Date()): Date | null {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("Invalid delivery attempt");
  const delay = DELIVERY_RETRY_MS[attempts - 1];
  return delay === undefined ? null : new Date(now.getTime() + delay);
}

export async function releaseDeliveryBatch(
  tx: Prisma.TransactionClient,
  ids: string[],
  workerId: string,
  attempts: number,
  reason: string,
  now = new Date(),
) {
  const retryAt = deliveryRetryAt(attempts, now);
  const updated = await tx.deliveryRecord.updateMany({
    where: { id: { in: ids }, status: "claimed", claimedBy: workerId },
    data: retryAt
      ? {
          status: "pending",
          claimedBy: null,
          deliveryRunId: null,
          nextAttemptAt: retryAt,
          lastError: reason,
        }
      : { status: "failed", claimedBy: null, deliveryRunId: null, lastError: reason },
  });
  return { retryAt, updatedCount: updated.count };
}
