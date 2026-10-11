import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { appendEvent } from "./events.js";
import { loadCurrentRunPlans, publishRunPlan } from "./run-plans.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("structured Run Plans (PostgreSQL)", () => {
  const id = randomUUID();
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let botId: string;
  let threadId: string;
  let runId: string;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    await prisma.user.create({
      data: { id, name: "Plan test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Plan test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Plan test" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: {
        id,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    botId = (
      await prisma.bot.create({
        data: { spaceId: id, userId: id, name: "Plan bot", color: "test" },
      })
    ).id;
    threadId = (await prisma.thread.create({ data: { spaceId: id, userId: id, botId } })).id;
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Plan", status: "running" },
    });
    runId = (
      await prisma.run.create({
        data: {
          spaceId: id,
          userId: id,
          botId,
          threadId,
          taskId: task.id,
          status: "running",
          trigger: "user",
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!db) return;
    await prisma.organization.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  const input = {
    expectedRevision: 0,
    goal: "Review and deliver",
    items: [{ id: "review", title: "Review source", status: "active" as const }],
  };

  it("publishes, replays by tool id and rejects stale revisions without extra events", async () => {
    const scope = { spaceId: id, threadId, botId, runId, toolExecutionId: "call-1" };
    const first = await publishRunPlan(prisma, scope, input);
    expect(first.status).toBe("published");
    if (first.status === "conflict") throw new Error("unexpected conflict");
    expect(first.plan).toMatchObject({ runId, revision: 1, items: input.items });
    expect(await publishRunPlan(prisma, scope, input)).toMatchObject({
      status: "replayed",
      seq: first.seq,
    });
    expect(
      await publishRunPlan(prisma, { ...scope, toolExecutionId: "call-stale" }, input),
    ).toEqual({ status: "conflict", currentRevision: 1 });
    expect(await prisma.event.count({ where: { runId, type: "plan.revised" } })).toBe(1);

    await expect(
      publishRunPlan(
        prisma,
        { ...scope, toolExecutionId: "call-invalid" },
        {
          expectedRevision: 1,
          goal: "Changed",
          items: [{ id: "other", title: "Other", status: "pending" }],
          changeReason: "Scope changed",
        },
      ),
    ).rejects.toThrow("retain prior item ids");

    const second = await publishRunPlan(
      prisma,
      { ...scope, toolExecutionId: "call-2" },
      {
        expectedRevision: 1,
        goal: "Review and deliver",
        items: [{ id: "review", title: "Review source", status: "completed" }],
        changeReason: "Review finished",
      },
    );
    expect(second.status).toBe("published");
    expect(await prisma.runPlanRevision.count({ where: { runId } })).toBe(2);
    expect((await prisma.$transaction((tx) => loadCurrentRunPlans(tx, threadId)))[0]).toMatchObject(
      { revision: 2, changeReason: "Review finished" },
    );
  });

  it("excludes Plans from a cleared thread generation", async () => {
    await appendEvent(prisma, {
      spaceId: id,
      threadId,
      botId,
      type: "thread.cleared",
      payload: {},
    });
    expect(await prisma.$transaction((tx) => loadCurrentRunPlans(tx, threadId))).toEqual([]);
  });
});
