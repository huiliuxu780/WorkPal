import { expect, type Page, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function waitForWaitingRun(page: Page, botId: string) {
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");
}

async function finishWelcomeSetup(page: Page) {
  // Local onboarding can leave the first-focus choice open; answer it so the
  // first Run is not queued behind an unanswered welcome card.
  const choice = page.getByRole("button", { name: /Day-to-day work/ });
  if (await choice.isVisible().catch(() => false)) {
    await choice.click();
  }
}

async function send(page: Page, text: string) {
  const composer = page.getByPlaceholder(/Message/);
  await expect(composer).toBeEnabled({ timeout: 60_000 });
  await composer.fill(text);
  await page.keyboard.press("Enter");
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
}

test("renders an MCP assignment as the unified CARD-01B card and settles it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `card-mcp-${stamp}@rakazo.test`, "password12", "Card MCP");
  await completeOnboarding(page);
  await finishWelcomeSetup(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await send(page, "show an mcp approval card");

  const region = page.locator('[data-testid="intervention-region"][data-surface="interaction-v2"]');
  await expect(region).toBeVisible({ timeout: 30_000 });
  const card = page
    .locator('[data-testid="interaction-card"][data-kind="action_approval"]')
    .filter({ hasText: "MCP assignment" });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("interaction-status")).toContainText("Waiting for your decision");
  await expect(card.getByTestId("mcp-allow-all-tools")).toContainText("allowAllTools: true");
  await expect(card).toContainText("All tools on this server");
  await expect(page.getByTestId("mcp-approval-card")).toHaveCount(0);
  await expect(page.locator("[data-intervention-id]")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "card-ui-mcp-desktop-1440");

  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureScreenshot(page, testInfo, "card-ui-mcp-390");

  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page);
  await captureScreenshot(page, testInfo, "card-ui-mcp-375");

  await page.setViewportSize({ width: 1440, height: 900 });
  await card.getByRole("button", { name: "Allow all tools", exact: true }).click();
  await expect(card.getByTestId("interaction-status")).toContainText("Allowed", {
    timeout: 20_000,
  });
  await expect(card.getByRole("button", { name: "Allow all tools", exact: true })).toHaveCount(0);
  expect(await card.evaluate((element) => element.className.includes("opacity-"))).toBe(false);
  await page.emulateMedia({ colorScheme: "dark" });
  await card.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "card-ui-mcp-terminal-dark");
});

test("replaces the legacy approval ask with one CARD-01B decision card", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `card-approval-${stamp}@rakazo.test`, "password12", "Card Approval");
  await completeOnboarding(page);
  await finishWelcomeSetup(page);
  const botId = activeBotId(page);
  await rpc(page, "approvalRules/set", {
    effect: "require_approval",
    matchKind: "connector",
    matchValue: "destination.write",
  });

  await send(page, "write this to the destination crm as a note");
  await waitForWaitingRun(page, botId);

  const region = page.locator('[data-testid="intervention-region"][data-surface="interaction-v2"]');
  await expect(region).toBeVisible({ timeout: 30_000 });
  const card = region
    .locator('[data-testid="interaction-card"][data-kind="action_approval"]')
    .filter({ hasText: "Allow once" });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("interaction-status")).toContainText("Waiting for your decision");
  await expect(card.getByTestId("approval-primary")).toContainText("Allow once");
  await expect(card.getByTestId("approval-secondary")).toContainText("Deny");
  // The projection is the only surface: the legacy ask never double-renders.
  await expect(page.locator("[data-intervention-id]")).toHaveCount(0);
  await expect(page.getByText("Allow once", { exact: true })).toHaveCount(1);
  await captureScreenshot(page, testInfo, "card-ui-tool-approval");

  await card.getByTestId("approval-secondary").click();
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0, {
    timeout: 45_000,
  });
});
