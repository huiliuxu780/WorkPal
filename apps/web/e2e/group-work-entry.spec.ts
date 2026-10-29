import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

test("group Work entry opens the existing work tab without becoming a second capsule", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `work-entry-${stamp}@rakazo.test`, "password12", "Work Entry E2E");
  await completeOnboarding(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const joy = await createNamedBot(page, "Joy");
  const blue = await createNamedBot(page, "Blue");
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Work entry roundtable",
    botIds: [joy, blue],
  });
  await page.goto(`/app/g/${group.id}`);
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  const entry = page.getByTestId("group-work-entry");
  const trigger = page.getByTestId("bot-settings-trigger");
  const panel = page.getByTestId("side-panel");
  const workTab = panel.getByTestId("group-panel-tab-work");

  await expect(entry).toBeVisible();
  await expect(entry).toHaveText("Work");
  await expect(entry).toHaveAccessibleName("Work");
  await expect(trigger.getByTestId("group-work-entry")).toHaveCount(0);
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await captureScreenshot(page, testInfo, "fix-work-entry-1440-default");

  await trigger.focus();
  await page.keyboard.press("Tab");
  await expect(entry).toBeFocused();

  await entry.click();
  await expect(panel).toHaveAttribute("data-panel", "group");
  await expect(workTab).toHaveAttribute("aria-selected", "true");
  await expect(entry).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByTestId("group-work-unavailable")).toBeVisible();
  await expect(workTab).toHaveText("Work");
  await captureScreenshot(page, testInfo, "fix-work-entry-1440-work");

  await panel.getByTestId("group-panel-tab-library").click();
  await entry.click();
  await expect(workTab).toHaveAttribute("aria-selected", "true");
  await panel.getByTestId("group-panel-tab-members").click();
  await entry.click();
  await expect(workTab).toHaveAttribute("aria-selected", "true");

  // A second activation while Work is already open keeps the rail open.
  await entry.click();
  await expect(panel).toHaveAttribute("data-panel", "group");
  await expect(workTab).toHaveAttribute("aria-selected", "true");

  await trigger.click();
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await entry.focus();
  await expect(entry).toBeFocused();
  await page.keyboard.press("Space");
  await expect(panel).toHaveAttribute("data-panel", "group");
  await expect(workTab).toHaveAttribute("aria-selected", "true");

  await trigger.click();
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await entry.focus();
  await page.keyboard.press("Enter");
  await expect(panel).toHaveAttribute("data-panel", "group");
  await expect(workTab).toHaveAttribute("aria-selected", "true");

  // The group capsule remains the rail master toggle and always targets Details.
  await trigger.click();
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await trigger.click();
  await expect(panel).toHaveAttribute("data-panel", "group");
  await expect(panel.getByTestId("group-panel-tab-details")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await entry.click();
  await expect(workTab).toHaveAttribute("aria-selected", "true");
  await trigger.click();
  await expect(panel).toHaveAttribute("data-panel", "closed");

  await page.setViewportSize({ width: 430, height: 900 });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(panel).toHaveAttribute("data-panel", "group");
  await expect(workTab).toHaveAttribute("aria-selected", "true");
  expect((await panel.boundingBox())?.width).toBeLessThanOrEqual(430);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  // The entry yields the top-right corner to the overlay's own close control.
  await expect(entry).toBeHidden();
  await captureScreenshot(page, testInfo, "fix-work-entry-430-work");
  await panel.getByTestId("group-panel-close").click();
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await expect(entry).toBeVisible();

  await page.goto(`/app/${joy}`);
  await page.waitForURL(new RegExp(`/app/${joy}$`));
  await expect(page.getByTestId("group-work-entry")).toHaveCount(0);

  await page.goto("/desktop-settings");
  await expect(page.getByTestId("group-work-entry")).toHaveCount(0);

  await rpc(page, "groups/remove", { groupId: group.id });
});
