import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test.describe.configure({ mode: "serial" });

const pageHtml = (marker: string) =>
  `<!doctype html><html><body><main><h1>Report ${marker}</h1><p>marker-${marker}</p></main></body></html>`;

async function sendPage(page: import("@playwright/test").Page, marker: string) {
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(
    `write path report.html and attach it to the thread says ${pageHtml(marker)}`,
  );
  await page.keyboard.press("Enter");
}

async function openPageCard(page: import("@playwright/test").Page, index: number) {
  await page.getByTestId("artifact-page-card").nth(index).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "report.html" })).toBeVisible();
  return dialog;
}

async function expectReport(page: import("@playwright/test").Page, marker: string) {
  const dialog = page.getByRole("dialog");
  const preview = dialog.frameLocator("iframe").frameLocator("#preview");
  await expect(preview.getByRole("heading", { name: `Report ${marker}` })).toBeVisible({
    timeout: 15_000,
  });
}

test("chat chrome page cards, updates, latest detail and responsive shell", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const stamp = Date.now();
  await signup(page, `chat-chrome-${stamp}@rakazo.test`, "password12", "Chat Chrome");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  const column = page.getByTestId("chat-column");
  await expect(column).toBeVisible();
  const columnBox = await column.boundingBox();
  expect(columnBox?.width).toBeCloseTo(704, 0);

  const cards = page.getByTestId("artifact-page-card");
  await sendPage(page, "A");
  await expect(cards).toHaveCount(1, { timeout: 30_000 });
  await expect(cards.nth(0)).not.toHaveAttribute("data-stale", "true");
  await expect(cards.nth(0).getByText("页面", { exact: true })).toBeVisible();
  expect((await cards.nth(0).boundingBox())?.width).toBeCloseTo(704, 0);

  const userBubble = page.getByTestId("message-user-bubble").last();
  const bubbleBox = await userBubble.boundingBox();
  const bubbleStyle = await userBubble.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color };
  });
  expect(bubbleBox ? bubbleBox.x + bubbleBox.width : 0).toBeCloseTo(
    (columnBox?.x ?? 0) + (columnBox?.width ?? 0),
    0,
  );
  expect(bubbleStyle).toEqual({
    background: "rgb(74, 102, 240)",
    color: "rgb(255, 255, 255)",
  });
  await captureScreenshot(page, testInfo, "batch1-AC01-1440-light-user-bubble");
  await captureScreenshot(page, testInfo, "batch2-AC03-1440-light-first-card");

  const shadowBefore = await cards
    .nth(0)
    .evaluate((element) => getComputedStyle(element).boxShadow);
  await cards.nth(0).hover();
  await page.waitForTimeout(250);
  const shadowAfter = await cards.nth(0).evaluate((element) => getComputedStyle(element).boxShadow);
  expect(shadowAfter).not.toBe(shadowBefore);
  expect(
    await cards
      .nth(0)
      .evaluate((element) => element.closest('[data-testid="message-bot-bubble"]') !== null),
  ).toBe(false);

  await cards.nth(0).focus();
  await page.keyboard.press("Enter");
  const keyboardDialog = page.getByRole("dialog");
  await expect(keyboardDialog).toBeVisible();
  await expectReport(page, "A");
  await page.keyboard.press("Escape");
  await expect(keyboardDialog).toHaveCount(0);
  await expect(cards.nth(0)).toBeFocused();

  await sendPage(page, "B");
  await expect(cards).toHaveCount(2, { timeout: 30_000 });
  await expect(cards.nth(0)).toHaveAttribute("data-stale", "true");
  await expect(cards.nth(1)).not.toHaveAttribute("data-stale", "true");

  await sendPage(page, "C");
  await expect(cards).toHaveCount(3, { timeout: 30_000 });
  await expect(cards.nth(0)).toHaveAttribute("data-stale", "true");
  await expect(cards.nth(1)).toHaveAttribute("data-stale", "true");
  await expect(cards.nth(2)).not.toHaveAttribute("data-stale", "true");
  await expect(page.getByText("已在下方更新")).toHaveCount(2);
  await captureScreenshot(page, testInfo, "batch3-AC04-1440-light-updated-cards");

  const shortComposer = page.getByPlaceholder(/Message/);
  await shortComposer.fill("hi");
  await page.keyboard.press("Enter");
  const shortBubble = page.getByTestId("message-user-bubble").last();
  await expect(shortBubble).toHaveText("hi");
  const shortBox = await shortBubble.boundingBox();
  expect(shortBox?.width ?? 0).toBeLessThan((columnBox?.width ?? 0) - 100);
  expect(shortBox ? shortBox.x + shortBox.width : 0).toBeCloseTo(
    (columnBox?.x ?? 0) + (columnBox?.width ?? 0),
    0,
  );
  await captureScreenshot(page, testInfo, "batch1-AC01-1440-light-short-message");

  await page.setViewportSize({ width: 1280, height: 800 });
  expect((await page.getByTestId("chat-column").boundingBox())?.width).toBeCloseTo(704, 0);
  expect((await cards.last().boundingBox())?.width).toBeCloseTo(704, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "batch4-AC10-1280-light-cards");
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await page.getByTestId("chat-column").boundingBox())?.width).toBeCloseTo(358, 0);
  expect((await cards.last().boundingBox())?.width).toBeCloseTo(358, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "batch4-AC10-390-light-cards");
  await page.setViewportSize({ width: 1440, height: 900 });

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("chat chrome grouping fixture");
  await page.keyboard.press("Enter");
  const grouped = page.getByTestId("message-bot-bubble").filter({ hasText: "grouped bubble" });
  await expect(grouped).toHaveCount(3, { timeout: 30_000 });
  const radii = await grouped.evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return {
        topLeft: style.borderTopLeftRadius,
        bottomLeft: style.borderBottomLeftRadius,
      };
    }),
  );
  expect(radii[0]).toEqual({ topLeft: "18px", bottomLeft: "2px" });
  expect(radii[1]).toEqual({ topLeft: "2px", bottomLeft: "2px" });
  expect(radii[2]).toEqual({ topLeft: "2px", bottomLeft: "18px" });
  await captureScreenshot(page, testInfo, "batch1-AC02-1440-light-bot-group");

  const transcript = page.getByTestId("transcript");
  const scrollBefore = await transcript.evaluate((element) => element.scrollTop);
  await page.getByTestId("artifact-page-card").nth(0).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "report.html" })).toBeVisible();
  await expect(dialog.getByText(/^(v\d+|version)/i)).toHaveCount(0);
  await expect(dialog.locator("iframe").first()).toHaveAttribute("sandbox", "allow-scripts");
  await expectReport(page, "C");
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download page" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("report.html");
  expect(readFileSync((await download.path())!, "utf8")).toContain("Report C");
  await captureScreenshot(page, testInfo, "batch4-AC05-AC06-1440-light-latest-detail");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("artifact-page-card").nth(0)).toBeFocused();
  const scrollAfter = await transcript.evaluate((element) => element.scrollTop);
  expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(1);

  await page.reload();
  await expect(page.getByTestId("artifact-page-card")).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByTestId("artifact-page-card").nth(0)).toHaveAttribute("data-stale", "true");
  await expect(page.getByTestId("artifact-page-card").nth(1)).toHaveAttribute("data-stale", "true");
  await openPageCard(page, 0);
  await expectReport(page, "C");
  const scrollBeforeUpdate = await transcript.evaluate((element) => element.scrollTop);
  await rpc(page, "threads/send", {
    botId,
    text: `write path report.html and attach it to the thread says ${pageHtml("D")}`,
    clientNonce: `chat-chrome-d-${Date.now()}`,
  });
  await expect(page.getByTestId("artifact-page-card")).toHaveCount(4, { timeout: 30_000 });
  await expectReport(page, "C");
  await captureScreenshot(page, testInfo, "batch4-AC11-1440-light-detail-stays-on-C");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const scrollAfterUpdate = await transcript.evaluate((element) => element.scrollTop);
  expect(Math.abs(scrollAfterUpdate - scrollBeforeUpdate)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("artifact-page-card").nth(0)).toHaveAttribute("data-stale", "true");
  await expect(page.getByTestId("artifact-page-card").nth(1)).toHaveAttribute("data-stale", "true");
  await expect(page.getByTestId("artifact-page-card").nth(2)).toHaveAttribute("data-stale", "true");
  await expect(page.getByTestId("artifact-page-card").nth(3)).not.toHaveAttribute(
    "data-stale",
    "true",
  );
  await openPageCard(page, 0);
  await expectReport(page, "D");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId("artifact-page-card")).toHaveCount(4, { timeout: 30_000 });
  const narrowColumn = await page.getByTestId("chat-column").boundingBox();
  expect(narrowColumn?.width).toBeCloseTo(358, 0);
  expect((await page.getByTestId("artifact-page-card").last().boundingBox())?.width).toBeCloseTo(
    358,
    0,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await openPageCard(page, 3);
  await page.waitForTimeout(200);
  const narrowDialog = await page.getByRole("dialog").boundingBox();
  expect(narrowDialog?.width).toBeCloseTo(390, 0);
  expect(Math.abs((narrowDialog?.height ?? 0) - 844)).toBeLessThanOrEqual(1);
  await captureScreenshot(page, testInfo, "batch4-AC10-390-light-detail");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await page.reload();
  await expect(page.getByTestId("artifact-page-card")).toHaveCount(4, { timeout: 30_000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureScreenshot(page, testInfo, "batch4-AC10-1440-dark-cards");
  await openPageCard(page, 3);
  await expectReport(page, "D");
  await captureScreenshot(page, testInfo, "batch4-AC10-1440-dark-detail");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1280, height: 800 });
  expect((await page.getByTestId("chat-column").boundingBox())?.width).toBeCloseTo(704, 0);
  await captureScreenshot(page, testInfo, "batch4-AC10-1280-dark-cards");
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await page.getByTestId("chat-column").boundingBox())?.width).toBeCloseTo(358, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "batch4-AC10-390-dark-cards");
  await openPageCard(page, 3);
  await expectReport(page, "D");
  await captureScreenshot(page, testInfo, "batch4-AC10-390-dark-detail");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("failed update keeps the last successful page valid", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const stamp = Date.now();
  await signup(page, `chat-chrome-failed-${stamp}@rakazo.test`, "password12", "Chat Chrome Failed");
  await completeOnboarding(page);
  await sendPage(page, "A");
  const cards = page.getByTestId("artifact-page-card");
  await expect(cards).toHaveCount(1, { timeout: 30_000 });

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("write path broken.exe and attach it to the thread says nope");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2_500);
  await expect(cards).toHaveCount(1);
  await expect(cards.nth(0)).not.toHaveAttribute("data-stale", "true");
  await captureScreenshot(page, testInfo, "batch3-AC07-1440-light-failed-update");

  await cards.nth(0).click();
  await expectReport(page, "A");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await sendPage(page, "B");
  await expect(cards).toHaveCount(2, { timeout: 30_000 });
  await expect(cards.nth(0)).toHaveAttribute("data-stale", "true");
  await expect(cards.nth(1)).not.toHaveAttribute("data-stale", "true");
  await cards.nth(0).click();
  await expectReport(page, "B");
  await page.keyboard.press("Escape");
});

test("detail failure is closable and retryable", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const stamp = Date.now();
  await signup(page, `chat-chrome-retry-${stamp}@rakazo.test`, "password12", "Chat Chrome Retry");
  await completeOnboarding(page);
  await sendPage(page, "A");
  await expect(page.getByTestId("artifact-page-card")).toHaveCount(1, { timeout: 30_000 });

  let fail = true;
  await page.route("**/rpc**", async (route) => {
    const request = route.request();
    const haystack = `${request.url()} ${request.postData() ?? ""} ${JSON.stringify(request.headers())}`;
    if (!fail || !haystack.includes("getLatest")) {
      return route.continue();
    }
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "forced page read failure" } }),
    });
  });

  await page.getByTestId("artifact-page-card").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByRole("button", { name: "Close page" })).toBeVisible();
  await captureScreenshot(page, testInfo, "batch4-AC09-1440-light-detail-error");
  fail = false;
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expectReport(page, "A");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
