import { randomUUID } from "node:crypto";
import { createDb, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachReportEnvelopes } from "./report-envelope.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("report envelope projection (PostgreSQL)", () => {
  const id = randomUUID();
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let botId: string;
  let groupThreadId: string;
  let groupName: string;
  let nextSeq = 0;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    await prisma.user.create({
      data: { id, name: "Ada Test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Report test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Report test" } });
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
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Scout", color: "test" },
    });
    botId = bot.id;
    const group = await prisma.chatGroup.create({
      data: { spaceId: id, userId: id, kind: "standard", name: "Ops room" },
    });
    groupName = group.name;
    const thread = await prisma.thread.create({
      data: { spaceId: id, userId: id, groupId: group.id },
    });
    groupThreadId = thread.id;
  }, 180_000);

  afterAll(async () => {
    await db?.prisma.$disconnect().catch(() => undefined);
    await db?.pool.end().catch(() => undefined);
  }, 60_000);

  async function seedDelivery(options: {
    prompt: string;
    state: "ok" | "failed";
    dispatcher?: { originBotName: string };
  }) {
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId: groupThreadId,
        prompt: options.prompt,
        status: "completed",
      },
    });
    let originRunId: string | null = null;
    if (options.dispatcher) {
      const originBot = await prisma.bot.create({
        data: { spaceId: id, userId: id, name: options.dispatcher.originBotName, color: "test" },
      });
      const directThread = await prisma.thread.create({
        data: { spaceId: id, userId: id, botId: originBot.id },
      });
      const originTask = await prisma.task.create({
        data: {
          spaceId: id,
          userId: id,
          botId: originBot.id,
          threadId: directThread.id,
          prompt: "dispatch",
          status: "completed",
        },
      });
      const originRun = await prisma.run.create({
        data: {
          spaceId: id,
          userId: id,
          botId: originBot.id,
          threadId: directThread.id,
          taskId: originTask.id,
          status: "completed",
          trigger: "message",
        },
      });
      originRunId = originRun.id;
    }
    const sourceRun = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId: groupThreadId,
        taskId: task.id,
        status: options.state === "failed" ? "failed" : "completed",
        trigger: originRunId ? "bot_message" : "message",
        ...(originRunId ? { originRunId } : {}),
      },
    });
    const message = await prisma.$transaction((tx) =>
      tx.message.create({
        data: {
          threadId: groupThreadId,
          seq: ++nextSeq,
          role: "bot",
          blocks: [{ kind: "text", text: "done" }],
        },
      }),
    );
    await prisma.deliveryRecord.create({
      data: {
        runId: sourceRun.id,
        threadId: groupThreadId,
        threadGeneration: 0,
        kind: "run_result",
        status: options.state === "failed" ? "failed" : "sent",
        idempotencyKey: `report-${randomUUID()}`,
        resultMessageId: message.id,
      },
    });
    return message;
  }

  it("composes the envelope from the delivery, run, task and thread", async () => {
    const message = await seedDelivery({ prompt: "Compare supplier landed costs", state: "ok" });
    const [withReport] = await attachReportEnvelopes(prisma, [message]);
    expect(withReport?.report).toEqual({
      state: "ok",
      from: { botId, name: "Scout" },
      room: groupName,
      work: "Compare supplier landed costs",
      to: { kind: "user", name: "Ada Test" },
    });
  });

  it("marks a failed delivery and names the dispatching Bot", async () => {
    const message = await seedDelivery({
      prompt: "Quote renewal",
      state: "failed",
      dispatcher: { originBotName: "Broker" },
    });
    const [withReport] = await attachReportEnvelopes(prisma, [message]);
    expect(withReport?.report?.state).toBe("failed");
    expect(withReport?.report?.to).toEqual({ kind: "bot", name: "Broker" });
  });

  it("omits provenance when one message merges results from several Runs", async () => {
    const message = await seedDelivery({ prompt: "Compare supplier landed costs", state: "ok" });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId: groupThreadId,
        prompt: "Quote renewal",
        status: "completed",
      },
    });
    const secondRun = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId: groupThreadId,
        taskId: task.id,
        status: "completed",
        trigger: "message",
      },
    });
    await prisma.deliveryRecord.create({
      data: {
        runId: secondRun.id,
        threadId: groupThreadId,
        threadGeneration: 0,
        kind: "run_result",
        status: "sent",
        idempotencyKey: `report-${randomUUID()}`,
        resultMessageId: message.id,
      },
    });
    const [merged] = await attachReportEnvelopes(prisma, [message]);
    expect(merged?.report).toBeUndefined();
  });

  it("leaves messages without a delivery record untouched", async () => {
    const plain = await prisma.$transaction((tx) =>
      tx.message.create({
        data: {
          threadId: groupThreadId,
          seq: ++nextSeq,
          role: "bot",
          blocks: [{ kind: "text", text: "plain" }],
        },
      }),
    );
    const [untouched] = await attachReportEnvelopes(prisma, [plain]);
    expect(untouched?.report).toBeUndefined();
  });
});
