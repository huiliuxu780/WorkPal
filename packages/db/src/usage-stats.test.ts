import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { summarizeModelUsage, usageRangeSince } from "./usage-stats.js";

describe("usage range windows", () => {
  it("bounds 7d and 30d windows and leaves all unbounded", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    expect(usageRangeSince("all", now)).toBeNull();
    expect(usageRangeSince("7d", now)).toEqual(new Date("2026-10-07T12:00:00Z"));
    expect(usageRangeSince("30d", now)).toEqual(new Date("2026-09-14T12:00:00Z"));
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("model usage statistics (PostgreSQL)", () => {
  const id = randomUUID();
  const otherUserId = randomUUID();
  const otherSpaceId = randomUUID();
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const now = new Date();
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000);

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    await prisma.user.create({
      data: { id, name: "Usage stats", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Usage stats", slug: id, createdAt: now },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Usage stats" } });
    await prisma.space.create({ data: { id: otherSpaceId, organizationId: id, name: "Other" } });
    await prisma.user.create({
      data: {
        id: otherUserId,
        name: "Other user",
        email: `${otherUserId}@example.test`,
        emailVerified: true,
      },
    });
    const record = (data: {
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      createdAt: Date;
      spaceId?: string;
      userId?: string;
    }) =>
      prisma.usageRecord.create({
        data: {
          spaceId: data.spaceId ?? id,
          userId: data.userId ?? id,
          provider: data.provider,
          model: data.model,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          cacheReadTokens: data.cacheReadTokens ?? 0,
          cacheWriteTokens: data.cacheWriteTokens ?? 0,
          createdAt: data.createdAt,
        },
      });
    // Two calls of one model inside a week, one older call of a second model,
    // and one call outside the 30-day window.
    await record({ provider: "p-a", model: "m-1", inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1, createdAt: at(0) });
    await record({ provider: "p-a", model: "m-1", inputTokens: 200, outputTokens: 20, createdAt: at(3) });
    await record({ provider: "p-b", model: "m-2", inputTokens: 50, outputTokens: 5, createdAt: at(10) });
    await record({ provider: "p-b", model: "m-2", inputTokens: 1_000, outputTokens: 100, createdAt: at(40) });
    // Other people and other Spaces must never leak into this user's stats.
    await record({ provider: "p-x", model: "m-x", inputTokens: 9_999, outputTokens: 999, createdAt: at(0), userId: otherUserId });
    await record({ provider: "p-x", model: "m-x", inputTokens: 8_888, outputTokens: 888, createdAt: at(0), spaceId: otherSpaceId, userId: otherUserId });
  });

  afterAll(async () => {
    if (!db) return;
    await prisma.organization.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id: { in: [id, otherUserId] } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("groups by provider and model with calls, tokens and separate cache columns", async () => {
    const summary = await summarizeModelUsage(prisma, { spaceId: id, userId: id, now });
    expect(summary.calls).toBe(4);
    expect(summary.inputTokens).toBe(1_350);
    expect(summary.outputTokens).toBe(135);
    // Cache tokens are summed into their own fields only.
    expect(summary.cacheReadTokens).toBe(5);
    expect(summary.cacheWriteTokens).toBe(1);
    expect(summary.byModel).toEqual([
      {
        provider: "p-a",
        model: "m-1",
        calls: 2,
        inputTokens: 300,
        outputTokens: 30,
        cacheReadTokens: 5,
        cacheWriteTokens: 1,
      },
      {
        provider: "p-b",
        model: "m-2",
        calls: 2,
        inputTokens: 1_050,
        outputTokens: 105,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
  });

  it("filters by the 7-day and 30-day windows", async () => {
    const week = await summarizeModelUsage(prisma, { spaceId: id, userId: id, range: "7d", now });
    expect(week.calls).toBe(2);
    expect(week.inputTokens).toBe(300);
    expect(week.byModel.map((row) => row.model)).toEqual(["m-1"]);
    const month = await summarizeModelUsage(prisma, {
      spaceId: id,
      userId: id,
      range: "30d",
      now,
    });
    expect(month.calls).toBe(3);
    expect(month.inputTokens).toBe(350);
    expect(month.byModel).toHaveLength(2);
  });

  it("never aggregates across users or Spaces", async () => {
    const summary = await summarizeModelUsage(prisma, { spaceId: id, userId: id, now });
    expect(JSON.stringify(summary)).not.toContain("p-x");
    expect(summary.inputTokens).toBeLessThan(9_999);
    const otherSpace = await summarizeModelUsage(prisma, {
      spaceId: otherSpaceId,
      userId: otherUserId,
      now,
    });
    expect(otherSpace.calls).toBe(1);
    expect(otherSpace.inputTokens).toBe(8_888);
  });

  it("reports an empty window honestly", async () => {
    const empty = await summarizeModelUsage(prisma, {
      spaceId: id,
      userId: randomUUID(),
      now,
    });
    expect(empty).toEqual({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      byModel: [],
    });
  });
});
