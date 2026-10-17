import { expect, test } from "@playwright/test";

test("agent avatar pose stays still when reduced motion is enabled", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/e2e/fixtures/avatar-motion.html");

  const avatar = page.locator(".rakazo-agent-avatar");
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute("data-state", "working");

  const body = avatar.locator('g[id="body"]');
  await expect(body).toBeVisible();
  await expect(avatar).toHaveAttribute("data-motion-ready", "true");
  const snapshot = () => body.evaluate((el: SVGElement) => el.getAttribute("transform"));
  const first = await snapshot();
  await page.waitForTimeout(300);
  const second = await snapshot();

  expect(second).toEqual(first);
});
