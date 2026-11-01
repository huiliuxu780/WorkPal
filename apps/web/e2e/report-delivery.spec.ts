import { expect, test } from "@playwright/test";
import { createDb } from "../../../packages/db/src/index.js";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

const RESULT_TEXT = "Landed cost comparison is ready: option B is 6% cheaper after freight.";
const FAILURE_TEXT = "这次工作没有完成。";
const LATE_TEXT = "迟到结果 · 已不收";

test("renders delegated results with the tag, the envelope and the late row", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await signup(page, `report-${Date.now()}@rakazo.test`, "password12", "Report E2E");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  await page.setViewportSize({ width: 1440, height: 900 });

  const scout = await rpc<{ id: string; name: string }>(page, "bots/create", {
    name: "Scout",
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  const snapshot = await rpc<{ threadId: string }>(page, "threads/get", { botId: scout.id });

  // Seed the three delivery shapes the worker produces: a delivered result, a
  // final failure and a refused late result. The page still resolves them
  // through the real projection and renders them.
  const db = createDb(process.env.DATABASE_URL!);
  try {
    const thread = await db.prisma.thread.findUniqueOrThrow({
      where: { id: snapshot.threadId },
      select: { spaceId: true, userId: true, nextMessageSeq: true },
    });
    const task = await db.prisma.task.create({
      data: {
        spaceId: thread.spaceId,
        userId: thread.userId,
        botId: scout.id,
        threadId: snapshot.threadId,
        prompt: "Compare supplier landed costs",
        status: "completed",
      },
    });
    const sourceRun = await db.prisma.run.create({
      data: {
        spaceId: thread.spaceId,
        userId: thread.userId,
        botId: scout.id,
        threadId: snapshot.threadId,
        taskId: task.id,
        status: "completed",
        trigger: "user",
      },
    });
    await db.prisma.attempt.create({
      data: { runId: sourceRun.id, fence: 1, status: "completed", finishedAt: new Date() },
    });
    let seq = thread.nextMessageSeq;
    const delivered = await db.prisma.message.create({
      data: {
        threadId: snapshot.threadId,
        seq: seq++,
        role: "bot",
        botId: scout.id,
        blocks: [{ kind: "text", text: RESULT_TEXT }],
      },
    });
    const failed = await db.prisma.message.create({
      data: {
        threadId: snapshot.threadId,
        seq: seq++,
        role: "bot",
        botId: scout.id,
        blocks: [{ kind: "text", text: FAILURE_TEXT }],
      },
    });
    await db.prisma.message.create({
      data: {
        threadId: snapshot.threadId,
        seq: seq++,
        role: "bot",
        botId: scout.id,
        blocks: [{ kind: "meta", text: LATE_TEXT }],
      },
    });
    await db.prisma.thread.update({
      where: { id: snapshot.threadId },
      data: { nextMessageSeq: seq },
    });
    await db.prisma.deliveryRecord.createMany({
      data: [
        {
          runId: sourceRun.id,
          threadId: snapshot.threadId,
          threadGeneration: 0,
          kind: "run_result",
          status: "sent",
          idempotencyKey: `report-ok-${delivered.id}`,
          resultMessageId: delivered.id,
        },
        {
          runId: sourceRun.id,
          threadId: snapshot.threadId,
          threadGeneration: 0,
          kind: "run_result",
          status: "failed",
          idempotencyKey: `report-failed-${failed.id}`,
          resultMessageId: failed.id,
        },
      ],
    });
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }

  await page.goto(`/app/${scout.id}`);
  await page.waitForURL(new RegExp(`/app/${scout.id}$`));
  await expect(page.getByText(RESULT_TEXT, { exact: false })).toBeVisible({ timeout: 30_000 });

  const tags = page.getByTestId("report-flow-tag");
  await expect(tags.nth(0)).toHaveText("回应 · 交来的结果");
  await expect(tags.nth(1)).toHaveText("回应 · 失败可见");
  const envelopes = page.getByTestId("report-envelope");
  await expect(envelopes).toHaveCount(2);
  const first = envelopes.nth(0);
  await expect(first).toContainText("Scout");
  await expect(first).toContainText("Scout");
  await expect(first).toContainText("Compare supplier landed costs");
  await expect(first).toContainText("Report E2E");
  const transcript = page.getByTestId("chat-column");
  const lateRow = transcript.getByText(LATE_TEXT, { exact: true });
  await expect(lateRow).toBeVisible();

  // Three real-page stills: the delivered result, the visible failure and the
  // refused late result.
  await page.getByText(RESULT_TEXT, { exact: false }).scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "RP-01-tag-envelope");
  await page.getByText(FAILURE_TEXT, { exact: true }).scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "RP-02-failure-visible");
  await lateRow.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "RP-03-late-row");
});
