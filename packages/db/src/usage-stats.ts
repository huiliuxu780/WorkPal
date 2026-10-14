import type { ModelUsageStats, UsageRange, UsageSummary } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

const DAY_MS = 86_400_000;

/** `all` has no lower bound; the window filters on the record creation time. */
export function usageRangeSince(range: UsageRange, now = new Date()): Date | null {
  if (range === "7d") return new Date(now.getTime() - 7 * DAY_MS);
  if (range === "30d") return new Date(now.getTime() - 30 * DAY_MS);
  return null;
}

export type SummarizeModelUsageInput = {
  spaceId: string;
  userId: string;
  range?: UsageRange;
  now?: Date;
};

/**
 * Aggregate persisted UsageRecords per provider+model for one user inside one
 * Space. `calls` is the UsageRecord row count (one row per measured model
 * call); it is not a distinct Run count and callers must not label it as runs.
 * Cache tokens are summed into their own fields only — vendor cache semantics
 * differ, so they are never folded into input/output totals. There is no price
 * table and no cost figure anywhere in this read model.
 */
export async function summarizeModelUsage(
  prisma: PrismaClient,
  input: SummarizeModelUsageInput,
): Promise<UsageSummary> {
  const since = usageRangeSince(input.range ?? "all", input.now);
  const groups = await prisma.usageRecord.groupBy({
    by: ["provider", "model"],
    where: {
      spaceId: input.spaceId,
      userId: input.userId,
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    _sum: {
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
    },
    _count: { _all: true },
  });
  const byModel: ModelUsageStats[] = groups
    .map((group) => ({
      provider: group.provider,
      model: group.model,
      calls: group._count._all,
      inputTokens: group._sum.inputTokens ?? 0,
      outputTokens: group._sum.outputTokens ?? 0,
      cacheReadTokens: group._sum.cacheReadTokens ?? 0,
      cacheWriteTokens: group._sum.cacheWriteTokens ?? 0,
    }))
    .sort(
      (left, right) =>
        right.calls - left.calls ||
        left.provider.localeCompare(right.provider) ||
        left.model.localeCompare(right.model),
    );
  return {
    calls: byModel.reduce((total, row) => total + row.calls, 0),
    inputTokens: byModel.reduce((total, row) => total + row.inputTokens, 0),
    outputTokens: byModel.reduce((total, row) => total + row.outputTokens, 0),
    cacheReadTokens: byModel.reduce((total, row) => total + row.cacheReadTokens, 0),
    cacheWriteTokens: byModel.reduce((total, row) => total + row.cacheWriteTokens, 0),
    byModel,
  };
}
