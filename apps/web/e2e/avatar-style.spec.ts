import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("Avatar Studio presents four distinct character silhouettes", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-style-${stamp}@rakazo.test`, "password12", "Avatar Style QA");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  await page.getByTestId("bot-settings-trigger").click();
  await page.getByTestId("bot-settings").getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  await expect(studio.getByRole("tab", { name: "Characters" })).toBeVisible();
  const silhouettes: string[] = [];
  for (const character of ["dot", "treble", "wave", "bounce"]) {
    const avatar = studio.getByRole("button", { name: character }).locator(".rakazo-agent-avatar");
    await expect(avatar).toHaveAttribute("data-character", character);
    silhouettes.push(
      await avatar.locator(".rakazo-agent-avatar-art svg").evaluate((element) => element.outerHTML),
    );
  }
  expect(new Set(silhouettes).size).toBe(4);
  await captureScreenshot(page, testInfo, "avatar-four-characters");
});
