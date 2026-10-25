import { randomUUID } from "node:crypto";
import type { MessageBlock, PlanReviewContent } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cardMessageFact, projectThreadCardSurface } from "./card-interactions.js";
import type { PrismaClient } from "./client.js";
import { pauseRunForInput } from "./events.js";
import { loadInterventionViews } from "./interventions.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
const TX = { timeout: 20_000, maxWait: 20_000 } as const;

describePostgres("CARD-01 card projection (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("card_interactions");
    prisma = isolated.db.prisma;
    await prisma.user.create({
      data: { id, name: "Card owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Card test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Card test" } });
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
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  async function freshThread() {
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Card bot", color: "test" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: bot.id },
    });
    return { botId: bot.id, threadId: thread.id };
  }

  async function runningRun() {
    const { botId, threadId } = await freshThread();
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        prompt: "Wait",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    return { run, attempt, botId, threadId };
  }

  async function surfaceFor(targetThreadId: string, runIds: string[]) {
    return prisma.$transaction(async (tx) => {
      const messages = await tx.message.findMany({
        where: { threadId: targetThreadId },
        orderBy: { seq: "asc" },
      });
      const views = await loadInterventionViews(
        tx,
        targetThreadId,
        messages.map((row) => ({ id: row.id, runId: row.runId, blocks: row.blocks })),
        runIds,
      );
      return projectThreadCardSurface({
        spaceId: id,
        threadId: targetThreadId,
        messages: messages.map((row) =>
          cardMessageFact(
            {
              id: row.id,
              threadId: row.threadId,
              botId: row.botId ?? undefined,
              runId: row.runId ?? undefined,
              createdAt: row.createdAt.toISOString(),
              blocks: row.blocks as MessageBlock[],
            },
            id,
          ),
        ),
        interventions: views,
        runs: [],
        computer: null,
      });
    }, TX);
  }

  it("projects pending and terminal interventions, attention, and revision", async () => {
    const { run, attempt, botId, threadId } = await runningRun();
    await pauseRunForInput(
      prisma,
      {
        spaceId: id,
        threadId,
        botId,
        runId: run.id,
        attemptId: attempt.id,
        leaseOwner: "worker",
        leaseFence: 1,
        blocks: [{ kind: "ask", text: "Which city?", status: "pending" }],
      },
      undefined,
    );
    const pending = await surfaceFor(threadId, [run.id]);
    expect(pending.interactions).toEqual([
      expect.objectContaining({
        kind: "input_request",
        revision: 1,
        status: "pending",
        source: expect.objectContaining({ threadId, runId: run.id, botId }),
      }),
    ]);
    expect(pending.attention).toHaveLength(1);

    await prisma.intervention.updateMany({
      where: { runId: run.id, status: "pending" },
      data: {
        status: "answered",
        revision: { increment: 1 },
        resolvedAt: new Date(),
        resolvedByUserId: id,
        pendingRunKey: null,
      },
    });
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: "completed",
        waitKind: null,
        waitStartedAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    const terminal = await surfaceFor(threadId, [run.id]);
    expect(terminal.interactions).toEqual([
      expect.objectContaining({ kind: "input_request", status: "answered", revision: 2 }),
    ]);
    expect(terminal.attention).toEqual([]);
  });

  it("synthesizes a legacy pending ask but never revives a settled one", async () => {
    const { run, botId, threadId } = await runningRun();
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: "waiting_input",
        waitKind: "input",
        waitStartedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    const thread = await prisma.thread.update({
      where: { id: threadId },
      data: { nextMessageSeq: { increment: 1 } },
      select: { nextMessageSeq: true },
    });
    const pendingMessage = await prisma.message.create({
      data: {
        threadId,
        seq: thread.nextMessageSeq - 1,
        role: "bot",
        botId,
        runId: run.id,
        blocks: [{ kind: "ask", text: "Legacy question", status: "pending" }],
      },
    });
    const pending = await surfaceFor(threadId, [run.id]);
    expect(pending.interactions).toEqual([
      expect.objectContaining({
        interactionId: `legacy_${pendingMessage.id}`,
        status: "pending",
        kind: "input_request",
      }),
    ]);
    expect(pending.attention).toHaveLength(1);

    // Settle only the message block, exactly as an upgrade-window settle would.
    await prisma.message.update({
      where: { id: pendingMessage.id },
      data: {
        blocks: [{ kind: "ask", text: "Legacy question", status: "answered", answer: "Paris" }],
      },
    });
    const settled = await surfaceFor(threadId, [run.id]);
    expect(settled.interactions).toEqual([]);
    expect(settled.attention).toEqual([]);
  });

  it("keeps plan review independent and preserves cross-thread sources", async () => {
    const { run, attempt, botId, threadId } = await runningRun();
    const plan: PlanReviewContent = {
      planId: "plan-1",
      contentVersion: 1,
      revision: 2,
      goal: "Ship cards",
      items: [{ id: "item-1", title: "Define schemas", status: "pending" }],
      source: "plan_exit",
    };
    await pauseRunForInput(
      prisma,
      {
        spaceId: id,
        threadId,
        botId,
        runId: run.id,
        attemptId: attempt.id,
        leaseOwner: "worker",
        leaseFence: 1,
        blocks: [
          {
            kind: "ask",
            text: "Review the plan",
            status: "pending",
            planReview: plan,
            actions: [
              { id: "approve", label: "Approve" },
              { id: "request_changes", label: "Request changes" },
              { id: "reject", label: "Reject" },
            ],
          },
        ],
      },
      undefined,
    );
    const planSurface = await surfaceFor(threadId, [run.id]);
    const planView = planSurface.interactions.find((view) => view.kind === "plan_review");
    expect(planView).toMatchObject({ kind: "plan_review", plan: { planId: "plan-1" } });
    expect(planView).not.toHaveProperty("approval");
    expect(JSON.stringify(planView)).not.toContain("effectId");

    // A pending Intervention projected into another Thread keeps both the
    // presentation source and the executing Run.
    const presentationBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Presentation bot", color: "test" },
    });
    const presentationThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: presentationBot.id },
    });
    const crossRun = await runningRun();
    await prisma.intervention.create({
      data: {
        id: randomUUID(),
        revision: 7,
        kind: "input",
        status: "pending",
        spaceId: id,
        threadId: presentationThread.id,
        runId: crossRun.run.id,
        attemptId: crossRun.attempt.id,
        botId: crossRun.botId,
        messageId: "cross-message",
        pendingRunKey: crossRun.run.id,
        expiresAt: new Date(Date.now() + 60_000),
        inputMode: "text",
        presentation: { text: "Answer from the source thread" },
        createdAt: new Date(),
      },
    });
    const crossSurface = await surfaceFor(presentationThread.id, []);
    expect(crossSurface.interactions).toEqual([
      expect.objectContaining({
        kind: "input_request",
        revision: 7,
        source: {
          spaceId: id,
          threadId: presentationThread.id,
          messageId: "cross-message",
          runId: crossRun.run.id,
          botId: crossRun.botId,
        },
      }),
    ]);
  });
});
