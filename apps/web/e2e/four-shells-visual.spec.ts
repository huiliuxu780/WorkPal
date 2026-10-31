import { expect, type Page, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

async function send(page: Page, text: string) {
  const composer = page.getByPlaceholder(/Message/);
  await expect(composer).toBeEnabled({ timeout: 60_000 });
  await composer.fill(text);
  await page.keyboard.press("Enter");
}

async function dismissWelcomeChoice(page: Page) {
  const choice = page.getByRole("button", { name: /Day-to-day work/ });
  if (await choice.isVisible().catch(() => false)) await choice.click();
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
}

async function setAppearance(page: Page, value: "light" | "dark") {
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId(`ui-appearance-${value}`).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", value);
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
}

test("interaction shell keeps the column width, icon well, actions and viewports", async ({
  page,
}, testInfo) => {
  await signup(page, `four-shells-visual-${Date.now()}@rakazo.test`, "password12", "Four Shells");
  await completeOnboarding(page);
  await dismissWelcomeChoice(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await send(page, "which city should I pick");
  const card = page.locator('[data-testid="interaction-card"][data-kind="input_request"]').first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  // Centre it: a card aligned to the scroll top sits under the floating pill.
  await card.evaluate((element) => element.scrollIntoView({ block: "center" }));

  const width = (await card.boundingBox())?.width ?? 0;
  const chain = await page.evaluate(() => {
    const rows: Array<{ tag: string; testid: string | null; width: number; cls: string }> = [];
    let element: Element | null = document.querySelector('[data-testid="interaction-card"]');
    while (element && rows.length < 10) {
      rows.push({
        tag: element.tagName.toLowerCase(),
        testid: element.getAttribute("data-testid"),
        width: Math.round(element.getBoundingClientRect().width),
        cls: (element.getAttribute("class") ?? "").slice(0, 120),
      });
      element = element.parentElement;
    }
    return rows;
  });
  console.log("WIDTH_CHAIN", JSON.stringify(chain));

  // B3: the content column is 704. A run-anchored card is inset by its
  // Execution card (16px padding + 1px border each side), so the card fills its
  // slot rather than the column; the 360/520 caps are what must be gone.
  const column = page.getByTestId("chat-column");
  expect(Math.round((await column.boundingBox())?.width ?? 0)).toBe(704);
  const slotWidth = await card.evaluate((element) =>
    Math.round((element.parentElement?.getBoundingClientRect().width ?? 0) as number),
  );
  expect(Math.round(width)).toBe(slotWidth);
  expect(width).toBeGreaterThan(600);
  expect(await card.evaluate((element) => getComputedStyle(element).maxWidth)).toBe("none");
  await captureScreenshot(page, testInfo, "FS-F02-1440-light-width");

  const iconWell = card.locator('header > span[aria-hidden="true"]').first();
  await expect(iconWell.locator("svg").first()).toBeVisible();
  expect(await iconWell.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    "rgba(0, 0, 0, 0)",
  );
  await captureScreenshot(page, testInfo, "FS-F03-1440-light-icon");

  const actions = card.locator('[data-testid="interaction-actions"]');
  expect(await actions.evaluate((element) => getComputedStyle(element).justifyContent)).toBe(
    "flex-end",
  );
  await captureScreenshot(page, testInfo, "FS-F04-1440-light-actions");

  for (const viewport of [390, 375]) {
    await page.setViewportSize({ width: viewport, height: 844 });
    await expectNoHorizontalOverflow(page);
    await captureScreenshot(page, testInfo, `FS-F25-${viewport}-light`);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await setAppearance(page, "dark");
  await expect(card).toBeVisible();
  expect(await iconWell.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    "rgba(0, 0, 0, 0)",
  );
  await captureScreenshot(page, testInfo, "FS-F03-1440-dark-icon");
  await captureScreenshot(page, testInfo, "FS-F25-1440-dark");

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await captureScreenshot(page, testInfo, "FS-F25-390-dark");
});
