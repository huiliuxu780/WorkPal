import { expect, test } from "@playwright/test";

// Intentional red spec so a GitHub run uploads the HTML report, trace,
// screenshot, and video. The follow-up commit deletes this file.
test("controlled failure produces a trace, screenshot, and video", async ({ page }) => {
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "H2 controlled failure" })).toBeVisible();
});
