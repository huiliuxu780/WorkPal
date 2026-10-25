import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

const GROUP_NAME = "新版发布圆桌";
const SOURCE_PROMPT = `Take the performance risk review to the group named "${GROUP_NAME}".`;
const GROUP_PROMPT = "Check the launch performance risk and report back.";
const GROUP_RESULT =
  "Group result: ship Friday behind a 10% rollout after the chart bundle is lazy-loaded.";
const RETURN_SUMMARY =
  "I brought the result back: Friday can still ship behind a 10% rollout.";

/**
 * RT-11 closed loop at the production boundary:
 * source direct chat → message_group → independent group Task/owner Run →
 * scripted execution → origin outcome → source receipt + separate report.
 */
test("message_group carries new work to a group and returns the result", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.ROUNDTABLE_MESSAGE_GROUP_ENABLED !== "true",
    "Run with ROUNDTABLE_MESSAGE_GROUP_ENABLED=true to exercise message_group",
  );

  const stamp = Date.now();
  await signup(page, `message-group-${stamp}@rakazo.test`, "password12", "Roundtable E2E");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const joy = await createBot(page, "Joy");
  const blue = await createBot(page, "Blue");
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: GROUP_NAME,
    botIds: [joy.id, blue.id],
  });

  // Keep signup/onboarding selectors stable, then switch only the app shell to
  // zh-CN so the receipt copy matches the approved prototype.
  await page.addInitScript(() => {
    window.localStorage.setItem("rakazo.uiLocale", "zh-CN");
  });
  await page.goto(`/app/${joy.id}`);
  await page.waitForURL(new RegExp(`/app/${joy.id}$`));
  const composer = page.getByTestId("composer-bar").getByRole("combobox");
  await expect(composer).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await composer.fill(SOURCE_PROMPT);
  await composer.press("Enter");

  const receipt = page.getByTestId("group-destination-receipt");
  await expect(receipt).toBeVisible({ timeout: 60_000 });
  await expect(receipt).toHaveAttribute("data-group-id", group.id);
  await expect(receipt).toContainText(`Joy 已进入「${GROUP_NAME}」`);
  await expect(receipt).toContainText("已入席");
  await expect(receipt).toContainText("正在阅读现场讨论，并接手“性能风险核对”。");
  await expect(receipt).toContainText("已接手 · 正在推进");
  await expect(receipt).toContainText("去现场看看");
  const destinationMessageId = await receipt.getAttribute("data-destination-message-id");
  expect(destinationMessageId).toBeTruthy();
  for (const term of ["queued", "Run", "Task", "Thread", "attempt", "steering"]) {
    await expect(receipt).not.toContainText(term);
  }
  await captureScreenshot(page, testInfo, "X-GROUP-source-1440");

  await page.setViewportSize({ width: 390, height: 900 });
  await expect(receipt).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await captureScreenshot(page, testInfo, "X-GROUP-source-390");

  await page.setViewportSize({ width: 1440, height: 900 });
  await receipt.getByRole("button").click();
  await page.waitForURL(new RegExp(`/app/g/${group.id}`));
  const targetMessage = page.locator(`[data-message-id="${destinationMessageId}"]`);
  await expect(targetMessage).toBeVisible({ timeout: 30_000 });
  await expect(targetMessage).toContainText(GROUP_PROMPT);
  await waitForGroupText(page, group.id);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText(GROUP_PROMPT, { exact: true })).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "X-GROUP-target-1440");

  await page.goto(`/app/${joy.id}`);
  await expect
    .poll(async () => (await sourceMessages(page, joy.id)).some((text) => text.includes(RETURN_SUMMARY)), {
      timeout: 60_000,
      intervals: [500, 1_000, 2_000],
    })
    .toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  const returnedReceipt = page.getByTestId("group-destination-receipt");
  await expect(returnedReceipt).toHaveAttribute("data-receipt-state", "completed");
  await expect(returnedReceipt).toContainText(`结论来自「${GROUP_NAME}」`);
  await expect(returnedReceipt).toContainText("已带回");
  await expect(returnedReceipt).toContainText("查看现场");
  await expect(returnedReceipt).toHaveAttribute(
    "data-destination-message-id",
    destinationMessageId!,
  );
  await expect(page.getByText(RETURN_SUMMARY, { exact: false })).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "X-RETURN-source-1440");

  await page.setViewportSize({ width: 390, height: 900 });
  await expect(returnedReceipt).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await captureScreenshot(page, testInfo, "X-RETURN-source-390");
});

async function createBot(page: Parameters<typeof rpc>[0], name: string) {
  return rpc<{ id: string; name: string }>(page, "bots/create", {
    name,
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
}

async function sourceMessages(page: Parameters<typeof rpc>[0], botId: string) {
  const snapshot = await rpc<{
    messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
  }>(page, "threads/get", { botId });
  return snapshot.messages.flatMap((message) =>
    message.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.text ?? "")
      .filter(Boolean),
  );
}

async function waitForGroupText(page: Parameters<typeof rpc>[0], groupId: string) {
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{
          messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
        }>(page, "threads/get", { groupId });
        return snapshot.messages
          .flatMap((message) => message.blocks)
          .some((block) => block.kind === "text" && (block.text ?? "").includes(GROUP_RESULT));
      },
      { timeout: 60_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true);
}
