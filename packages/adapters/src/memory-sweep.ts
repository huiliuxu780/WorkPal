import type { JobPublisher } from "@rakazo/adapter-kit";
import { memoryExtractJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

/**
 * ME-02 M3: the periodic gap-filler. Incremental extraction rides completed
 * human turns; this sweep catches threads whose cursor lagged behind (missed
 * enqueue, worker downtime, quota deferrals). It only looks at spaces whose
 * policy enables automatic inference, and the job itself re-checks policy,
 * generation and quotas before any model call.
 */
export async function enqueueLaggingMemoryExtractions(
  prisma: PrismaClient,
  jobs: JobPublisher,
  limit = 20,
): Promise<number> {
  const policies = await prisma.spaceMemoryPolicy.findMany({
    where: { autoExtraction: "on" },
    select: { spaceId: true },
  });
  if (policies.length === 0) return 0;
  const spaceIds = policies.map((policy) => policy.spaceId);
  const lagging = await prisma.$queryRaw<Array<{ threadId: string }>>`
    SELECT t.id AS "threadId"
    FROM threads t
    LEFT JOIN memory_extraction_cursors c ON c."threadId" = t.id
    WHERE t."spaceId" = ANY(${spaceIds}::text[])
      AND t."botId" IS NOT NULL
      AND t."nextMessageSeq" > 0
      AND COALESCE(c."highWatermarkSeq", -1) < t."nextMessageSeq" - 1
    ORDER BY t.id
    LIMIT ${limit}
  `;
  for (const row of lagging) {
    await jobs.enqueue(memoryExtractJob(row.threadId));
  }
  return lagging.length;
}
