import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test.describe.configure({ mode: "serial" });

test("approval input resumes durable work", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `approval-${stamp}@rakazo.test`, "password12", "Approval");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("ask me which city to use");
  await page.keyboard.press("Enter");

  // Scoped to the Intervention Region: the Execution Card's auxiliary line
  // legitimately repeats the sanitized question as a one-line preview, and
  // this prompt counter tracks the ask cards across rounds, not card lines.
  const prompt = page
    .getByTestId("intervention-region")
    .locator("p")
    .filter({ hasText: /^Which city should I use\?$/ });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Reply with one city name.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send it" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit first" })).toBeVisible();
  await captureScreenshot(page, testInfo, "20-approval-input-request");

  await page.getByRole("button", { name: "Edit first" }).click();
  const answer = page.getByRole("textbox", { name: "Answer" });
  await answer.fill("ask me which city to use again");
  await expect(page.getByRole("button", { name: "Send answer" })).toBeEnabled();
  await captureScreenshot(page, testInfo, "21-approval-custom-answer");
  await page.getByRole("button", { name: "Send answer" }).click();

  // FIX-127 pinned the resumed ask to the persisted Runtime contract: the
  // answer resolves the pending ask_user call and the same Run finishes; it
  // does not replay the ask fixture into a second pending card. The answered
  // prompt stays as the bubble echo introduced by UX-01B.
  await expect(prompt).toHaveCount(0, { timeout: 30_000 });
  await expect(
    page.getByText("Answered: ask me which city to use again", { exact: true }),
  ).toBeVisible();
  const resumed = page
    .getByText("done. i handled: ask me which city to use again", { exact: true })
    .first();
  await expect(resumed).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send it" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "22-approval-resumed");

  await page.reload();
  await expect(prompt).toHaveCount(0, { timeout: 20_000 });
  await expect(
    page.getByText("Answered: ask me which city to use again", { exact: true }),
  ).toBeVisible();
  await expect(resumed).toBeVisible();
  await captureScreenshot(page, testInfo, "23-approval-resumed-after-reload");

  await composer.fill("ask me which city to use");
  await page.keyboard.press("Enter");
  // UX-01B: each waiting Run's region holds only its own card — the earlier
  // plain Runs keep no surface, so their answered asks live in their bubbles.
  await expect(prompt).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole("button", { name: "Stop" }).click();
  // A stopped plain Run keeps no execution surface, and its never-settled ask
  // never reappears as an operable card anywhere.
  await expect(page.getByTestId("intervention-region")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send it" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "24-stopped-approval-prompt");
});
