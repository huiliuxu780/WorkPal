import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

const DISPLAY_IMAGE = readFileSync("e2e/fixtures/display-image.png").toString("base64");

async function finishWelcomeSetup(page: Page) {
  const choice = page.getByRole("button", { name: /Day-to-day work/ });
  if (await choice.isVisible().catch(() => false)) {
    await choice.click();
  }
}

async function scrollIntoView(locator: Locator) {
  await expect(async () => {
    await locator.scrollIntoViewIfNeeded();
  }).toPass({ timeout: 5_000 });
}

test("renders all nine DisplayBlock kinds from the server projection", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `display-blocks-${stamp}@rakazo.test`, "password12", "Display Blocks");
  await completeOnboarding(page);
  await finishWelcomeSetup(page);
  await page.setViewportSize({ width: 1440, height: 1200 });
  const botId = activeBotId(page);
  const snapshot = await rpc<{ threadId: string }>(page, "threads/get", { botId });

  const createArtifact = (name: string, mimeType: string, content: Buffer) =>
    rpc<{ id: string }>(page, "artifacts/create", {
      botId,
      name,
      mimeType,
      contentBase64: content.toString("base64"),
    });
  const image = await createArtifact(
    "chart.png",
    "image/png",
    Buffer.from(DISPLAY_IMAGE, "base64"),
  );
  const file = await createArtifact("notes.txt", "text/plain", Buffer.from("hello"));
  const html = await createArtifact(
    "report.html",
    "text/html",
    Buffer.from("<h1>Read-only report</h1><p>Sandboxed contents.</p>"),
  );
  const documentPage = await createArtifact(
    "brief.md",
    "text/markdown",
    Buffer.from("# Weekly brief\n\nA short document."),
  );

  const seeded = await page.request.post(`${process.env.API_URL}/__e2e/display-blocks`, {
    data: {
      botId,
      threadId: snapshot.threadId,
      imageId: image.id,
      fileId: file.id,
      htmlId: html.id,
      pageId: documentPage.id,
    },
  });
  expect(seeded.ok()).toBe(true);
  await page.reload();

  const markdown = page.locator('[data-testid="display-block"][data-kind="markdown"]');
  await expect(markdown).toBeVisible({ timeout: 30_000 });
  await expect(markdown).toContainText("Weekly report");
  await expect(markdown.getByRole("button", { name: "Read full text" })).toBeVisible();
  await scrollIntoView(page.locator('[data-kind="media"]').first());
  await expect(page.locator('[data-kind="media"] img')).toHaveCount(1, { timeout: 15_000 });
  await scrollIntoView(markdown);
  await captureScreenshot(page, testInfo, "display-blocks-desktop-1440");

  const chart = page.locator('[data-testid="display-block"][data-kind="chart"]');
  await expect(chart).toBeVisible();
  await scrollIntoView(chart);
  await chart.getByRole("button", { name: "Expand" }).click();
  const table = page.locator('[data-testid="display-block"][data-kind="table"]');
  await expect(table).toBeVisible();
  await expect(table).toContainText("Mon");
  await captureScreenshot(page, testInfo, "display-chart-detail-desktop");
  await page.getByRole("button", { name: "Close chart" }).click();

  await expect(page.locator('[data-testid="display-block"][data-kind="collection"]')).toContainText(
    "Owner",
  );
  const legacyConnect = page.locator('[data-testid="legacy-connect-card"]');
  await expect(legacyConnect).toContainText("Linear");
  await expect(legacyConnect).toContainText("Connected");
  // Legacy `connect` records replay as history, not as an authorization entry.
  await expect(legacyConnect.locator("button, a")).toHaveCount(0);
  await expect(page.locator('[data-testid="display-block"][data-kind="media"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="display-block"][data-kind="html"]')).toContainText(
    "report.html",
  );
  await expect(page.locator('[data-testid="display-block"][data-kind="page"]')).toContainText(
    "brief.md",
  );
  await expect(
    page.locator('[data-testid="display-block"][data-kind="task_status"]').first(),
  ).toContainText("Researcher");
  // A replaced cloud-agent card keeps its https destination reachable.
  const cloudAgentCard = page
    .locator('[data-testid="display-block"][data-kind="task_status"]')
    .filter({ hasText: "Remote fix" });
  await expect(cloudAgentCard.getByRole("link", { name: "Open external agent" })).toHaveAttribute(
    "href",
    "https://github.example.test/demo/pull/9",
  );
  // The result wraps far beyond the three-line clamp; the full text must stay
  // reachable through the same read-full-text entry as the markdown card.
  const taskStatus = page.locator('[data-testid="display-block"][data-kind="task_status"]').first();
  await expect(taskStatus.getByRole("button", { name: "Read full text" })).toBeVisible();
  await taskStatus.getByRole("button", { name: "Read full text" }).click();
  await expect(page.getByRole("dialog")).toContainText("Line 14");
  await page.getByRole("button", { name: "Close full text" }).click();
  const voice = page.locator('[data-testid="display-block"][data-kind="voice"]');
  await expect(voice).toContainText("The weather is sunny.");
  await scrollIntoView(voice);
  await captureScreenshot(page, testInfo, "display-blocks-desktop-lower");

  const htmlCard = page.locator('[data-testid="display-block"][data-kind="html"]');
  await scrollIntoView(htmlCard);
  await htmlCard.getByRole("button", { name: "Open report" }).click();
  await expect(page.getByTitle("report.html").last()).toBeVisible({ timeout: 15_000 });
  await captureScreenshot(page, testInfo, "display-html-detail-desktop");
  await page.getByRole("button", { name: "Close report" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await scrollIntoView(markdown);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
  await captureScreenshot(page, testInfo, "display-blocks-390-top");
  await page.emulateMedia({ colorScheme: "dark" });
  await captureScreenshot(page, testInfo, "display-blocks-390-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await scrollIntoView(voice);
  await captureScreenshot(page, testInfo, "display-blocks-390");

  await page.setViewportSize({ width: 375, height: 812 });
  await scrollIntoView(voice);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
  await captureScreenshot(page, testInfo, "display-blocks-375");
});

test("markdown card re-measures overflow when the viewport changes", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `display-reflow-${stamp}@rakazo.test`, "password12", "Display Reflow");
  await completeOnboarding(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const botId = activeBotId(page);
  const snapshot = await rpc<{ threadId: string }>(page, "threads/get", { botId });
  const image = await rpc<{ id: string }>(page, "artifacts/create", {
    botId,
    name: "probe.png",
    mimeType: "image/png",
    contentBase64: Buffer.from(DISPLAY_IMAGE, "base64").toString("base64"),
  });
  const probeText =
    "The team reviewed the weekly metrics and adjusted the rollout plan for the next sprint. " +
    "The dashboard shows steady growth across every region and the support queue is finally " +
    "moving again after the holiday slowdown. We agreed to keep the current pacing.";
  const seeded = await page.request.post(`${process.env.API_URL}/__e2e/display-blocks`, {
    data: {
      botId,
      threadId: snapshot.threadId,
      imageId: image.id,
      fileId: image.id,
      htmlId: image.id,
      pageId: image.id,
      probeText,
    },
  });
  expect(seeded.ok()).toBe(true);
  await page.reload();

  // At 390px the bubble exceeds the fold threshold so the message swaps to
  // the markdown card, whose content still fits at this width.
  const probeCard = page
    .locator('[data-testid="display-block"][data-kind="markdown"]')
    .filter({ hasText: "rollout plan" });
  await expect(probeCard).toBeVisible({ timeout: 30_000 });
  await scrollIntoView(probeCard);
  await expect(probeCard.getByRole("button", { name: "Read full text" })).toHaveCount(0);

  // Narrowing must re-measure the same mounted card: the text is unchanged,
  // but the narrower card wraps taller and crosses the fold cap.
  await page.setViewportSize({ width: 320, height: 700 });
  await scrollIntoView(probeCard);
  await expect(probeCard.getByRole("button", { name: "Read full text" })).toBeVisible({
    timeout: 15_000,
  });

  // Widening again re-fits the content and the entry must go away.
  await page.setViewportSize({ width: 1440, height: 1200 });
  await scrollIntoView(probeCard);
  await expect(probeCard.getByRole("button", { name: "Read full text" })).toHaveCount(0, {
    timeout: 15_000,
  });
  await page.setViewportSize({ width: 320, height: 700 });
  await scrollIntoView(probeCard);
  await captureScreenshot(page, testInfo, "display-markdown-320-reflow");
});

test("renders projected cards beside narration text", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `display-narration-${stamp}@rakazo.test`, "password12", "Display Narration");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const snapshot = await rpc<{ threadId: string }>(page, "threads/get", { botId });
  const image = await rpc<{ id: string }>(page, "artifacts/create", {
    botId,
    name: "narration.png",
    mimeType: "image/png",
    contentBase64: Buffer.from(DISPLAY_IMAGE, "base64").toString("base64"),
  });
  const seeded = await page.request.post(`${process.env.API_URL}/__e2e/display-blocks`, {
    data: {
      botId,
      threadId: snapshot.threadId,
      imageId: image.id,
      fileId: image.id,
      htmlId: image.id,
      pageId: image.id,
      narrationImageId: image.id,
    },
  });
  expect(seeded.ok()).toBe(true);
  await page.reload();

  // The remaining short text turns the message into a narration bubble; the
  // projected card must still render next to it instead of being dropped.
  const narrationMessage = page
    .locator("[data-message-id]")
    .filter({ hasText: "Here is the chart capture you asked for." });
  await expect(narrationMessage).toBeVisible({ timeout: 30_000 });
  await expect(narrationMessage.locator('[data-kind="media"] img')).toBeVisible({
    timeout: 15_000,
  });
});

test("renders projected cards when only tool activity remains", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `display-tools-${stamp}@rakazo.test`, "password12", "Display Tools");
  await completeOnboarding(page);
  await page.setViewportSize({ width: 1440, height: 1200 });
  const botId = activeBotId(page);
  const snapshot = await rpc<{ threadId: string }>(page, "threads/get", { botId });
  const image = await rpc<{ id: string }>(page, "artifacts/create", {
    botId,
    name: "probe.png",
    mimeType: "image/png",
    contentBase64: Buffer.from(DISPLAY_IMAGE, "base64").toString("base64"),
  });
  const seeded = await page.request.post(`${process.env.API_URL}/__e2e/display-blocks`, {
    data: {
      botId,
      threadId: snapshot.threadId,
      imageId: image.id,
      fileId: image.id,
      htmlId: image.id,
      pageId: image.id,
      toolProbeImageId: image.id,
      toolProbeText: "deep",
    },
  });
  expect(seeded.ok()).toBe(true);
  await page.reload();

  // Tool activity is hidden by default: the messages reduce to tool-only
  // narration, and their projected cards must still render.
  const mediaCard = page.locator('[data-testid="display-block"][data-kind="media"]').last();
  await expect(mediaCard.locator("img")).toBeVisible({ timeout: 30_000 });
  const markdownCard = page.locator('[data-testid="display-block"][data-kind="markdown"]').last();
  await expect(markdownCard).toContainText("Tool probe");
  await expect(page.getByTestId("tool-activity-line")).toHaveCount(0);

  // Showing tool activity keeps the same cards next to the steps.
  await page.evaluate(() => localStorage.setItem("rakazo.showToolActivity", "on"));
  await page.reload();
  await expect(page.getByTestId("tool-activity-line").first()).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-testid="display-block"][data-kind="media"]').last().locator("img"),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="display-block"][data-kind="markdown"]').last(),
  ).toContainText("Tool probe");
});
