import type { Prisma, PrismaClient } from "./client.js";

export const DELIVERY_MERGE_MS = 30_000;
export const DELIVERY_LEASE_MS = 120_000;
export const DELIVERY_RETRY_MS = [10_000, 30_000, 120_000, 600_000, 1_800_000] as const;

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
    const claimed = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "delivery_records"
      WHERE "threadId" = ${seed.threadId}
        AND "threadGeneration" = ${seed.threadGeneration}
        AND "deliveryRunId" IS NOT DISTINCT FROM ${seed.deliveryRunId}
        AND "status" IN ('pending', 'claimed')
        AND ("nextAttemptAt" <= ${now} OR ("status" = 'pending' AND "attempts" = 0))
        AND "createdAt" <= ${windowEnd}
      ORDER BY "createdAt", "id"
      LIMIT 100 FOR UPDATE SKIP LOCKED
    `;
    const ids = claimed.map((row) => row.id);
    if (ids.length === 0) return [];
    const rows = await tx.deliveryRecord.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
    });
    const pendingIds = rows.filter((row) => row.status === "pending").map((row) => row.id);
    const expiredLeaseIds = rows.filter((row) => row.status === "claimed").map((row) => row.id);
    await tx.deliveryRecord.updateMany({
      where: { id: { in: pendingIds } },
      data: {
        status: "claimed",
        claimedBy: workerId,
        nextAttemptAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
        attempts: { increment: 1 },
      },
    });
    if (expiredLeaseIds.length) {
      await tx.deliveryRecord.updateMany({
        where: { id: { in: expiredLeaseIds } },
        data: {
          claimedBy: workerId,
          nextAttemptAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
        },
      });
    }
    return tx.deliveryRecord.findMany({
      where: { id: { in: ids } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
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
