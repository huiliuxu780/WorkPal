import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { appendEvent } from "./events.js";
import { loadCurrentRunSteps, publishRunStep } from "./run-steps.js";
import { loadCurrentRunTodos, publishRunTodo } from "./run-todos.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("semantic Run Steps (PostgreSQL)", () => {
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
      data: { id, name: "Step test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Step test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Step test" } });
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
        data: { spaceId: id, userId: id, name: "Step bot", color: "test" },
      })
    ).id;
    threadId = (await prisma.thread.create({ data: { spaceId: id, userId: id, botId } })).id;
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Step", status: "running" },
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
          leaseFence: 1,
        },
      })
    ).id;
    await prisma.attempt.create({ data: { runId, fence: 1, status: "running" } });
  });

  afterAll(async () => {
    if (!db) return;
    await prisma.organization.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("keeps Step identity across status updates and rejects stale or invalid evidence", async () => {
    const scope = { spaceId: id, threadId, botId, runId, toolExecutionId: "step-call-1" };
    const first = await publishRunStep(prisma, scope, {
      stepId: "review",
      expectedRevision: 0,
      order: 0,
      title: "Review source",
      status: "running",
    });
    expect(first.status).toBe("published");
    if (first.status === "conflict") throw new Error("unexpected conflict");
    expect(first.step).toMatchObject({ stepId: "review", revision: 1, status: "running" });
    expect(first.step.attemptId).toBeTruthy();
    expect(
      await publishRunStep(prisma, scope, {
        stepId: "review",
        expectedRevision: 0,
        order: 0,
        title: "Review source",
        status: "running",
      }),
    ).toMatchObject({ status: "replayed", seq: first.seq });
    expect(
      await publishRunStep(
        prisma,
        { ...scope, toolExecutionId: "stale" },
        {
          stepId: "review",
          expectedRevision: 0,
          order: 0,
          title: "Review source",
          status: "completed",
        },
      ),
    ).toEqual({ status: "conflict", currentRevision: 1 });
    await expect(
      publishRunStep(
        prisma,
        { ...scope, toolExecutionId: "bad-evidence" },
        {
          stepId: "review",
          expectedRevision: 1,
          order: 0,
          title: "Review source",
          status: "completed",
          evidence: [{ kind: "external_effect", id: "not-owned" }],
        },
      ),
    ).rejects.toThrow("does not belong");
    const done = await publishRunStep(
      prisma,
      { ...scope, toolExecutionId: "step-call-2" },
      {
        stepId: "review",
        expectedRevision: 1,
        order: 0,
        title: "Review source",
        status: "completed",
        resultSummary: "Reviewed",
      },
    );
    expect(done.status).toBe("published");
    if (done.status === "conflict") throw new Error("unexpected conflict");
    expect(done.step.startedAt).toBe(first.step.startedAt);
    expect(done.step.completedAt).toBeTruthy();
    expect(await prisma.event.count({ where: { runId, type: { startsWith: "step." } } })).toBe(2);
    expect((await prisma.$transaction((tx) => loadCurrentRunSteps(tx, threadId)))[0]).toMatchObject(
      { revision: 2, status: "completed" },
    );
    await expect(
      publishRunStep(
        prisma,
        { ...scope, toolExecutionId: "step-call-3" },
        {
          stepId: "review",
          expectedRevision: 2,
          order: 0,
          title: "Review source",
          status: "running",
        },
      ),
    ).rejects.toThrow("terminal Step");
  });

  it("does not restore Steps from a cleared generation", async () => {
    const scope = { spaceId: id, threadId, botId, runId, toolExecutionId: "todo-call-1" };
    const input = {
      todoId: "review-todo",
      expectedRevision: 0,
      order: 0,
      title: "Review source",
      status: "active",
      linkedStepId: "review",
    };
    expect((await publishRunTodo(prisma, scope, input)).status).toBe("published");
    expect(await publishRunTodo(prisma, scope, input)).toMatchObject({ status: "replayed" });
    expect(
      await publishRunTodo(
        prisma,
        { ...scope, toolExecutionId: "todo-stale" },
        {
          ...input,
          status: "resolved",
        },
      ),
    ).toEqual({ status: "conflict", currentRevision: 1 });
    expect((await prisma.$transaction((tx) => loadCurrentRunTodos(tx, threadId)))[0]).toMatchObject(
      { linkedStepId: "review" },
    );
    expect(
      (
        await publishRunTodo(
          prisma,
          { ...scope, toolExecutionId: "todo-defer" },
          {
            ...input,
            expectedRevision: 1,
            status: "deferred",
            reason: "Waiting for input",
          },
        )
      ).status,
    ).toBe("published");
    const reactivated = await publishRunTodo(
      prisma,
      { ...scope, toolExecutionId: "todo-reopen" },
      {
        ...input,
        expectedRevision: 2,
        status: "active",
      },
    );
    expect(reactivated.status).toBe("published");
    if (reactivated.status === "conflict") throw new Error("unexpected conflict");
    expect(reactivated.todo.reason).toBeNull();
    await appendEvent(prisma, {
      spaceId: id,
      threadId,
      botId,
      type: "thread.cleared",
      payload: {},
    });
    expect(await prisma.$transaction((tx) => loadCurrentRunSteps(tx, threadId))).toEqual([]);
    expect(await prisma.$transaction((tx) => loadCurrentRunTodos(tx, threadId))).toEqual([]);
  });
});
