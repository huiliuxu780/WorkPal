import { randomUUID } from "node:crypto";
import {
  appendEvent,
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  type PrismaClient,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadManualRetryChain, matchManualRetryEffect } from "./manual-retry-effects.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("manual retry effect chain (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let botId: string;
  let threadId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("mr_fx");
    prisma = isolated.db.prisma;
    await prisma.user.create({
      data: { id, name: "FX owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "FX org", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "FX space" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: {
        id: `${id}-sm`,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    botId = (
      await prisma.bot.create({ data: { spaceId: id, userId: id, name: "FX bot", color: "test" } })
    ).id;
    threadId = (await prisma.thread.create({ data: { spaceId: id, userId: id, botId } })).id;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  it("matches completed same-args effects on the retry chain and ignores off-chain rows", async () => {
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Send mail", status: "failed" },
    });
    const oldRun = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "failed",
        trigger: "user",
      },
    });
    await appendEvent(prisma, {
      spaceId: id,
      threadId,
      botId,
      runId: oldRun.id,
      type: "run.failed",
      payload: {},
    });
    const retry = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "queued",
        trigger: "user",
        retryOfRunId: oldRun.id,
      },
    });
    const outsiderTask = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Other", status: "completed" },
    });
    const outsider = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: outsiderTask.id,
        status: "completed",
        trigger: "user",
      },
    });
    await prisma.externalEffect.create({
      data: {
        spaceId: id,
        runId: oldRun.id,
        kind: "send_email",
        idempotencyKey: `old-${oldRun.id}`,
        status: "completed",
        request: { to: "ada@example.test", subject: "hi" },
        result: { id: "msg-1" },
      },
    });
    await prisma.externalEffect.create({
      data: {
        spaceId: id,
        runId: outsider.id,
        kind: "send_email",
        idempotencyKey: `out-${outsider.id}`,
        status: "completed",
        request: { to: "ada@example.test", subject: "hi" },
        result: { id: "should-not-reuse" },
      },
    });
    const chain = await loadManualRetryChain(prisma, retry.id);
    expect(chain).toHaveLength(1);
    const reuse = matchManualRetryEffect(
      chain,
      "send_email",
      { to: "ada@example.test", subject: "hi" },
      0,
    );
    expect(reuse).toMatchObject({ kind: "reuse", effect: { result: { id: "msg-1" } } });
    expect(
      matchManualRetryEffect(chain, "send_email", { to: "bob@example.test", subject: "hi" }, 0)
        .kind,
    ).toBe("execute");
    expect(
      matchManualRetryEffect(chain, "send_email", { to: "ada@example.test", subject: "hi" }, 1)
        .kind,
    ).toBe("execute");
  });
});
