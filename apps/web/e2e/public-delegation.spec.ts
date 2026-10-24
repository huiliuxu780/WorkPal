import { expect, type Locator, type Page, test } from "@playwright/test";
import { createDb } from "../../../packages/db/src/index.js";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

const GROUP_NAME = "Launch room";

/**
 * FIX-MSG-A acceptance evidence at the real production boundary:
 * Web → API → scripted Agent Runtime → executor `message_bot` → group Thread.
 *
 * Every delegation below is a persisted public `bot_message_sent` /
 * `bot_message_received` pair written by the production transactional path.
 * Nothing here hand-writes DOM or stubs a projection response.
 *
 * The one seeded state is branch-F-OFFLINE: the current backend refuses an
 * unavailable target before it writes anything, so an orphaned sender record
 * cannot be produced through the API. The spec creates a real delivery first,
 * lets its Run settle, then removes the target record and that delivery's
 * downstream activity to reproduce the persisted anomaly the projection must
 * render as "Not sent to <name>" instead of a receipt. A later real user turn
 * keeps the orphan interior to the window.
 */
test("public group delegation renders as natural chat messages", async ({ page }, testInfo) => {
  test.skip(
    process.env.ROUNDTABLE_PUBLIC_COLLABORATION_ENABLED !== "true",
    "Run with ROUNDTABLE_PUBLIC_COLLABORATION_ENABLED=true to exercise public group delegation",
  );

  const stamp = Date.now();
  await signup(page, `public-delegation-${stamp}@rakazo.test`, "password12", "Roundtable E2E");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const joy = await createBot(page, "Joy");
  const blue = await createBot(page, "Blue");
  const orange = await createBot(page, "Orange");

  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: GROUP_NAME,
    botIds: [joy.id, blue.id, orange.id],
  });
  await page.goto(`/app/g/${group.id}`);
  const composer = page.getByRole("combobox", { name: `Message ${GROUP_NAME}` });
  await expect(composer).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });

  // main-stage-2: the moderator delegates publicly in the group Thread.
  const firstBody =
    "attach file notes/performance-baseline.md into the thread says performance baseline unchanged";
  await sendWithMention(page, composer, "Joy", `message the bot named Blue saying ${firstBody}`);

  const firstDelegation = page
    .getByTestId("public-delegation")
    .filter({ has: page.getByText("@Blue", { exact: true }) });
  await expect(firstDelegation).toBeVisible({ timeout: 60_000 });
  await expect(firstDelegation).toHaveAttribute("data-sender-bot-id", joy.id);
  await expect(firstDelegation).toContainText("@Blue");
  await expect(firstDelegation).toContainText(firstBody);
  await expect(firstDelegation.getByTestId("public-delegation-trace")).toHaveText(
    "Assigned to Blue",
  );
  await expect(firstDelegation.getByTestId("public-delegation-target")).toHaveAttribute(
    "data-target-bot-id",
    blue.id,
  );
  // The wake prompt is a transport record, not the user's own message: exactly
  // the user command and the delegation bubble carry this body. A rendered
  // wake prompt would add a third bubble.
  await expect(
    page.getByTestId("transcript").locator("[data-message-id]").filter({ hasText: firstBody }),
  ).toHaveCount(2);
  await expect(page.getByTestId("peer-receipt-chip")).toHaveCount(0);
  await expect(page.getByTestId("peer-conversation-view")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "main-stage-2-public-delegation-1440");

  // A public mention navigates to the user's own chat with that Bot, never to
  // the Agent-to-Agent private pair view.
  await firstDelegation.getByTestId("agent-mention").first().click();
  await page.waitForURL(new RegExp(`/app/${blue.id}$`));
  await expect(page.getByTestId("peer-conversation-view")).toHaveCount(0);
  await page.goto(`/app/g/${group.id}`);
  await expect(page.getByRole("combobox", { name: `Message ${GROUP_NAME}` })).toBeVisible();

  // main-stage-3: the delegated member answers in the same group Thread, then
  // the moderator adds a second, independent public delegation.
  await waitForBotText(page, group.id, blue.id);
  await sendWithMention(
    page,
    composer,
    "Joy",
    "message the bot named Orange saying attach file notes/first-screen-options.md into the thread says desktop and mobile options are costed",
  );

  const secondDelegation = page
    .getByTestId("public-delegation")
    .filter({ has: page.getByText("@Orange", { exact: true }) });
  await expect(secondDelegation).toBeVisible({ timeout: 60_000 });
  await expect(secondDelegation).toContainText("@Orange");
  await expect(secondDelegation.getByTestId("public-delegation-trace")).toHaveText(
    "Assigned to Orange",
  );
  await waitForBotText(page, group.id, orange.id);
  await expect(page.getByTestId("peer-receipt-chip")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "main-stage-3-group-collaboration-1440");

  // branch-F-OFFLINE: remove the persisted target record of the second real
  // delivery and everything that followed it. The sender record is now an
  // orphan, which the projection must surface as an explicit dispatch failure
  // rather than a silent receipt. A later real turn keeps it interior.
  const orphanSeq = await removeTargetRecordAndLater(page, group.id, orange.id, joy.id);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("combobox", { name: `Message ${GROUP_NAME}` })).toBeVisible({
    timeout: 20_000,
  });
  await sendWithMention(
    page,
    composer,
    "Joy",
    "attach file notes/fallback-plan.md into the thread says hold the Orange review until it is available",
  );
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{
          messages: Array<{ seq: number; botId?: string; blocks: Array<{ kind: string }> }>;
        }>(page, "threads/get", { groupId: group.id });
        return snapshot.messages.some(
          (message) =>
            message.seq > orphanSeq &&
            message.botId === joy.id &&
            message.blocks.some((block) => block.kind === "text"),
        );
      },
      { timeout: 60_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  const failedDelegation = page
    .getByTestId("public-delegation")
    .filter({ has: page.getByText("@Orange", { exact: true }) });
  await expect(failedDelegation).toBeVisible({ timeout: 20_000 });
  const failedTrace = failedDelegation.getByTestId("public-delegation-trace");
  await expect(failedTrace).toHaveText("Not sent to Orange");
  await expect(failedTrace).toHaveClass(/text-destructive/);
  await expect(page.getByTestId("peer-receipt-chip")).toHaveCount(0);

  await failedDelegation.scrollIntoViewIfNeeded();
  const box = await failedDelegation.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "branch-F-OFFLINE-not-sent-390");
});

async function createBot(page: Page, name: string) {
  return rpc<{ id: string; name: string }>(page, "bots/create", {
    name,
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
}

/** Wait for the delegated member's own text reply in the group Thread. */
async function waitForBotText(page: Page, groupId: string, botId: string) {
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{
          messages: Array<{ botId?: string; blocks: Array<{ kind: string }> }>;
        }>(page, "threads/get", { groupId });
        return snapshot.messages.some(
          (message) =>
            message.botId === botId && message.blocks.some((block) => block.kind === "text"),
        );
      },
      { timeout: 60_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true);
}

/**
 * Keep the structured mention in the draft. `fill()` replaces the whole value
 * and the mention chip disappears with its token, which would send plain text
 * and let the group routing treat it as an answer to an open ask.
 */
async function sendWithMention(page: Page, composer: Locator, botName: string, body: string) {
  await composer.fill(`@${botName.slice(0, 3)}`);
  await page.getByRole("option", { name: `@${botName}`, exact: true }).click();
  await expect(page.getByTestId("mention-chip").filter({ hasText: botName })).toBeVisible();
  await composer.press("End");
  await composer.type(body);
  await composer.press("Enter");
}

/**
 * Seed the persisted orphan shape for branch-F-OFFLINE. The delivery itself was
 * produced by the real API; after its Run and automatic outcome settle, its
 * target `bot_message_received` record and the downstream activity are removed,
 * leaving the sender's `bot_message_sent` record without a pair. Returns the
 * orphan's seq so the caller can keep it interior to the window.
 */
async function removeTargetRecordAndLater(
  page: Page,
  groupId: string,
  targetBotId: string,
  outcomeBotId: string,
): Promise<number> {
  const snapshot = await rpc<{ threadId: string }>(page, "threads/get", { groupId });
  const { prisma } = createDb(process.env.DATABASE_URL!);
  const blockList = (blocks: unknown) =>
    Array.isArray(blocks) ? (blocks as Array<Record<string, unknown>>) : [];
  try {
    const rows = await prisma.message.findMany({
      where: { threadId: snapshot.threadId },
      select: { id: true, seq: true, botId: true, blocks: true },
      orderBy: { seq: "asc" },
    });
    const outbound = rows.find((row) =>
      blockList(row.blocks).some(
        (block) => block.kind === "bot_message_sent" && block.toBotId === targetBotId,
      ),
    );
    expect(outbound, "real public delegation outbound record").toBeTruthy();
    const inbound = rows.find((row) =>
      blockList(row.blocks).some(
        (block) =>
          block.kind === "bot_message_received" && block.returnToMessageId === outbound!.id,
      ),
    );
    expect(inbound, "paired target record for the public delegation").toBeTruthy();

    // Wait for the delegated Run's automatic outcome to land in the Thread and
    // for every peer Run to become terminal, so nothing can append activity
    // behind the orphan after it is seeded.
    await expect
      .poll(
        async () => {
          const later = await prisma.message.findMany({
            where: { threadId: snapshot.threadId, seq: { gt: outbound!.seq } },
            select: { botId: true, blocks: true },
          });
          return later.some(
            (row) =>
              row.botId === outcomeBotId &&
              blockList(row.blocks).some((block) => block.kind === "text"),
          );
        },
        { timeout: 60_000, intervals: [250, 500, 1_000] },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          prisma.run.count({
            where: {
              threadId: snapshot.threadId,
              trigger: "bot_message",
              status: { in: ["queued", "running", "waiting_input", "waiting_takeover"] },
            },
          }),
        { timeout: 30_000, intervals: [250, 500, 1_000] },
      )
      .toBe(0);

    await prisma.message.deleteMany({
      where: { threadId: snapshot.threadId, seq: { gt: outbound!.seq } },
    });
    return outbound!.seq;
  } finally {
    await prisma.$disconnect();
  }
}
