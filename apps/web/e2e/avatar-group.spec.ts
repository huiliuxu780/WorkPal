import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("group sidebar uses two live character avatars with visible names", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-group-${stamp}@rakazo.test`, "password12", "Avatar Group QA");
  await completeOnboarding(page);
  const first = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  const second = await rpc<{ id: string }>(page, "bots/create", {
    name: "Writer",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Review team",
    botIds: [first.id, second.id],
  });
  await page.goto(`/app/g/${group.id}`);
  const row = page
    .locator("aside")
    .first()
    .getByText("Review team", { exact: true })
    .locator("xpath=ancestor::button[1]");
  await expect(row).toBeVisible();
  await expect(row.locator(".rakazo-group-avatar .rakazo-agent-avatar")).toHaveCount(2);
  await expect(row.locator(".rakazo-agent-avatar").first()).toHaveAttribute("data-size", "24");
  await captureScreenshot(page, testInfo, "avatar-group-light");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  });
  await captureScreenshot(page, testInfo, "avatar-group-dark");
});
