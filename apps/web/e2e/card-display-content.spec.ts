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
  await expect(page.locator('[data-testid="display-block"][data-kind="media"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="display-block"][data-kind="html"]')).toContainText(
    "report.html",
  );
  await expect(page.locator('[data-testid="display-block"][data-kind="page"]')).toContainText(
    "brief.md",
  );
  await expect(
    page.locator('[data-testid="display-block"][data-kind="task_status"]'),
  ).toContainText("Researcher");
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
