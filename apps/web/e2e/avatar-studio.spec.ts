import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("avatar studio changes a Bot character and offers one-step undo", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-studio-${stamp}@rakazo.test`, "password12", "Avatar Studio");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const initial = await rpc<{ avatarCharacter: string | null; avatarBodyColor: string }>(page, "bots/get", {
    botId: activeBotId(page),
  });
  const selected = initial.avatarCharacter === "wave" ? "bounce" : "wave";
  const otherTab = await page.context().newPage();
  await otherTab.goto(page.url());
  const otherTabAvatar = otherTab
    .getByTestId("bot-settings-trigger")
    .locator(".rakazo-agent-avatar");
  await expect(otherTabAvatar).toBeVisible();

  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();

  await settings.getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  await expect(studio).toBeVisible();
  await expect(studio.getByText("Avatar Studio", { exact: true })).toBeVisible();
  await expect(studio.getByRole("tab", { name: "Characters" })).toBeVisible();
  await expect(studio.getByRole("tab", { name: "Upload" })).toBeVisible();
  await expect(studio.getByRole("button", { name: "Generate" })).toHaveCount(0);
  await expect(studio.getByRole("button", { name: selected })).toBeVisible();
  await captureScreenshot(page, testInfo, "avatar-studio-light");
  await studio.getByRole("button", { name: selected }).click();
  const bodyColor = initial.avatarBodyColor === "blue" ? "pink" : "blue";
  await studio.getByRole("button", { name: bodyColor, exact: true }).click();
  await studio.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("Avatar updated");
  await expect(
    settings.getByTestId("avatar-studio-trigger").locator(`[data-character="${selected}"]`),
  ).toBeVisible();
  await expect(otherTabAvatar).toHaveAttribute("data-character", selected);
  await expect(otherTabAvatar).toHaveAttribute("data-body-color", bodyColor);
  const history = settings.locator("details").filter({ hasText: "Avatar history" });
  await history.locator("summary").click();
  await expect(history).toContainText(`${initial.avatarCharacter} · ${initial.avatarBodyColor}`);
  await expect(history).toContainText(`${selected} · ${bodyColor}`);
  const [latestChange] = await rpc<Array<{ id: string }>>(page, "bots/avatarChanges", {
    botId: activeBotId(page),
  });
  await rpc(page, "bots/undoAvatarChange", { changeId: latestChange!.id });
  await expect(otherTabAvatar).toHaveAttribute("data-character", initial.avatarCharacter ?? "dot");
  await expect(otherTabAvatar).toHaveAttribute("data-body-color", initial.avatarBodyColor);
  await settings.getByTestId("avatar-studio-trigger").click();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  });
  await captureScreenshot(page, testInfo, "avatar-studio-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "avatar-studio-narrow");
  await studio.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId("side-panel").getByRole("button", { name: "Close panel" }).click();
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("ping");
  await composer.press("Enter");
  await expect(page.getByTestId("message-bot-bubble").last()).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "avatar-one-to-one-narrow");
});

test("Avatar Studio rejects an invalid file and saves a cropped upload with undo", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `avatar-upload-${stamp}@rakazo.test`, "password12", "Avatar Upload QA");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = activeBotId(page);
  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  await settings.getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  await studio.getByRole("tab", { name: "Upload" }).click();
  const file = studio.getByLabel("Choose avatar image");
  await file.setInputFiles({
    name: "invalid.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(studio.getByRole("alert")).toContainText("Choose a PNG, JPEG, or WebP image");
  await file.setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(studio.getByRole("alert")).toHaveCount(0);
  await studio.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("Avatar updated");
  const uploaded = await rpc<{ avatarMode: string; color: string }>(page, "bots/get", { botId });
  expect(uploaded.avatarMode).toBe("upload");
  expect(uploaded.color).toMatch(/^data:image\/webp;base64,/);
  await settings.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(async () => (await rpc<{ avatarMode: string }>(page, "bots/get", { botId })).avatarMode)
    .toBe("character");
  const invalidUpload = await page.request.post("/rpc/bots/changeAvatar", {
    data: {
      json: { botId, choice: { avatarMode: "upload", color: "data:image/png;base64,AA==" } },
    },
  });
  expect(invalidUpload.ok()).toBe(false);
  expect((await rpc<Array<unknown>>(page, "bots/avatarChanges", { botId })).length).toBe(1);
});
