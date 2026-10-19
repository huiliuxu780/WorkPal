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

test("compact work badge animates within the director while its SVG stays still", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/e2e/fixtures/avatar-motion.html?size=16");
  const avatar = page.locator(".rakazo-agent-avatar");
  await expect(avatar).toHaveAttribute("data-motion", "moving");
  const body = avatar.locator('g[id="body"]');
  const before = await body.getAttribute("transform");
  await page.waitForTimeout(300);
  expect(await body.getAttribute("transform")).toBe(before);
  await expect(avatar.locator(".rakazo-agent-avatar-dot")).toHaveCSS(
    "animation-name",
    "wp-status-breathe",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(avatar).toHaveAttribute("data-motion", "still");
  await expect(avatar.locator(".rakazo-agent-avatar-dot")).toHaveCSS("animation-name", "none");
});
