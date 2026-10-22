import { expect, type Page, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openNewGroup,
  rpc,
  signup,
} from "./helpers";

async function createBot(page: Page, name: string) {
  return createNamedBot(page, name);
}

/** Group rows carry BotAvatar role="img" labels before the name, so match on text. */
function sidebarRow(page: Page, name: string) {
  return page.locator("aside").first().locator("button", { hasText: name });
}

test("create group from + and see two bots in one transcript", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `group-${stamp}@rakazo.test`, "password12", "Group E2E");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const researcherId = await createBot(page, "Researcher");
  const writerId = await createBot(page, "Research Writer");

  await openNewGroup(page);
  const createDialog = page.getByTestId("create-group-dialog");
  await createDialog.locator("label:has-text('Name') input").fill("Draft team");
  await createDialog.getByRole("button", { name: "Researcher" }).click();
  await createDialog.getByRole("button", { name: "Research Writer" }).click();
  await captureScreenshot(page, testInfo, "group-creation");
  await page.route("**/rpc/groups/create", async (route) => route.abort("failed"));
  await createDialog.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(createDialog.getByRole("alert")).toHaveText("Failed to fetch");
  await expect(createDialog.getByRole("button", { name: "Create group", exact: true })).toBeEnabled();
  await page.unroute("**/rpc/groups/create");
  await createDialog.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);
  const groupUrl = page.url();
  const draftGroupId = new URL(groupUrl).pathname.split("/").at(-1)!;
  const reviewGroup = await rpc<{ id: string }>(page, "groups/create", {
    name: "Review team",
    botIds: [researcherId, writerId],
  });
  await rpc(page, "voice/connect", {
    provider: "scripted",
    apiKey: "fake-group-voice-key",
  });
  await page.reload();
  await expect(page).toHaveURL(groupUrl);
  await expect(page.getByRole("combobox", { name: "Message Draft team" })).toBeVisible();

  const groups = await rpc<
    Array<{
      id: string;
      members: Array<{ botId: string; name: string; color: string; status?: string }>;
    }>
  >(page, "groups/list", {});
  const groupSnapshot = await rpc<{
    members?: Array<{ botId: string; name: string; color: string; status?: string }>;
  }>(page, "threads/get", { groupId: draftGroupId });
  await page.route("**/rpc/groups/list", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: groups.map((group) => ({
          ...group,
          members: group.members.map((member, index) => ({
            ...member,
            status: index === 0 ? "running" : "idle",
          })),
        })),
      }),
    });
  });
  await page.route("**/rpc/threads/get", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          ...groupSnapshot,
          members: groupSnapshot.members?.map((member, index) => ({
            ...member,
            status: index === 0 ? "running" : "idle",
          })),
        },
      }),
    });
  });
  await page.reload();
  // Anchor ^ so Now/Recent activity rows ("Bot · Draft team, …") do not match.
  const groupAvatar = sidebarRow(page, "Draft team").locator(".rakazo-group-avatar");
  await expect(groupAvatar).toBeVisible();
  // Avatar activity comes from the durable catalog, not the raw chat status
  // (Shell sidebar comment), so the stubbed member status is not assertable here.
  await expect(groupAvatar.locator(".rakazo-agent-avatar")).toHaveCount(2);
  await captureScreenshot(page, testInfo, "group-avatar-active");
  await page.unroute("**/rpc/groups/list");
  await page.unroute("**/rpc/threads/get");
  await page.reload();

  await page.getByTestId("bot-settings-trigger").click();
  const desktopSettings = page.getByTestId("side-panel");
  await expect(desktopSettings).toHaveAttribute("data-panel", "group");
  const groupName = desktopSettings.getByTestId("group-name-field");
  // AC33: leaving the field commits the rename and every naming surface follows.
  await groupName.click();
  await groupName.fill("Draft team blur");
  await desktopSettings.getByTestId("group-panel-tab-details").click();
  await expect(sidebarRow(page, "Draft team blur")).toBeVisible();
  await groupName.click();
  await groupName.fill("Draft team");
  await groupName.press("Enter");
  await expect(sidebarRow(page, "Draft team blur")).toHaveCount(0);
  await page.route("**/rpc/groups/update", async (route) => route.abort("failed"));
  await groupName.click();
  await groupName.fill("Draft team renamed");
  await groupName.press("Enter");
  await expect(desktopSettings.getByRole("alert")).toHaveText("Failed to fetch");
  await page.unroute("**/rpc/groups/update");
  await groupName.click();
  await groupName.fill("Draft team renamed");
  await groupName.press("Enter");
  await expect(sidebarRow(page, "Draft team renamed")).toBeVisible();
  // Rename back so the composer assertions below keep their original anchors.
  await groupName.click();
  await groupName.fill("Draft team");
  await groupName.press("Enter");
  await expect(sidebarRow(page, "Draft team renamed")).toHaveCount(0);

  await page
    .getByRole("combobox", { name: "Message Draft team" })
    .fill("@Researcher unfinished draft");
  await sidebarRow(page, "Review team").click();
  await expect(page.getByRole("combobox", { name: "Message Review team" })).toHaveValue("");
  await sidebarRow(page, "Draft team").click();
  await expect(page.getByRole("combobox", { name: "Message Draft team" })).toHaveValue("");

  const composer = page.getByRole("combobox", { name: "Message Draft team" });
  await composer.fill("@Res");
  await captureScreenshot(page, testInfo, "group-mention-picker");
  await page.getByRole("option", { name: "@Research Writer", exact: true }).click();
  await expect(
    page.getByTestId("mention-chip").filter({ hasText: "Research Writer" }),
  ).toBeVisible();
  await composer.fill("turn the sources into a draft. @Res");
  await page.getByRole("option", { name: "@Researcher", exact: true }).click();
  await expect(page.getByTestId("mention-chip").filter({ hasText: "Researcher" })).toBeVisible();
  await composer.fill(`${await composer.inputValue()}gather sources.`);
  await composer.press("Enter");

  await expect(page.getByTestId("transcript")).toContainText(/handled|on it|gather/i, {
    timeout: 60_000,
  });
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText("Researcher", { exact: true }).first()).toBeVisible();
  await expect(transcript.getByText("Research Writer", { exact: true }).first()).toBeVisible();
  const researcherSpeak = transcript
    .locator("div")
    .filter({ has: page.getByText("Researcher", { exact: true }) })
    .filter({ has: page.getByRole("button", { name: "Speak this reply" }) })
    .first()
    .getByRole("button", { name: "Speak this reply" });
  const [speechRequest] = await Promise.all([
    page.waitForRequest(
      (request) => request.url().includes("/api/voice/speak") && request.method() === "POST",
    ),
    researcherSpeak.click(),
  ]);
  expect(speechRequest.postDataJSON()).toMatchObject({ botId: researcherId });
  await captureScreenshot(page, testInfo, "group-transcript");

  await composer.fill("@Res");
  await page.getByRole("option", { name: "@Research Writer", exact: true }).click();
  await expect(
    page.getByTestId("mention-chip").filter({ hasText: "Research Writer" }),
  ).toBeVisible();
  await composer.fill("ask me which city to use");
  await composer.press("Enter");
  // threads/get can observe waiting_input before the shell realtime feed paints the ask card.
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          groupId: draftGroupId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");
  const cityAsk = page.locator("p").filter({ hasText: /^Which city should I use\?$/ });
  if ((await cityAsk.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("combobox", { name: "Message Draft team" })).toBeVisible({
      timeout: 15_000,
    });
  }
  await expect(cityAsk).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Edit first" }).click();
  await page.getByRole("textbox", { name: "Answer" }).fill("Paris");
  await page.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByText("Answered: Paris", { exact: true })).toBeVisible({ timeout: 30_000 });

  const firstMessage = transcript.locator("[data-message-id]").first();
  await firstMessage.hover();
  const replyButton = firstMessage.getByRole("button", { name: "Reply" });
  await expect(replyButton).toBeVisible();
  await replyButton.click();
  await expect(page.getByTestId("reply-chip")).toContainText(/Replying to/);
  await page.getByRole("button", { name: "Cancel reply" }).click();

  let releaseReviewSnapshot!: () => void;
  let sawReviewSnapshot!: () => void;
  const reviewSnapshotReleased = new Promise<void>((resolve) => {
    releaseReviewSnapshot = resolve;
  });
  const reviewSnapshotIntercepted = new Promise<void>((resolve) => {
    sawReviewSnapshot = resolve;
  });
  await page.route("**/rpc/threads/get", async (route) => {
    if (route.request().postData()?.includes(reviewGroup.id) !== true) {
      await route.continue();
      return;
    }
    sawReviewSnapshot();
    await reviewSnapshotReleased;
    await route.continue();
  });
  await sidebarRow(page, "Review team").click();
  await reviewSnapshotIntercepted;
  await expect(page).toHaveURL(new RegExp(`/app/g/${reviewGroup.id}$`));
  await expect(page.getByTestId("transcript")).not.toContainText("Answered: Paris");
  releaseReviewSnapshot();
  await expect(page.getByRole("combobox", { name: "Message Review team" })).toBeVisible();
  await page.unroute("**/rpc/threads/get");
  await sidebarRow(page, "Draft team").click();
  await expect(page.getByText("Answered: Paris", { exact: true })).toBeVisible();

  await composer.fill(
    "@Researcher write path notes/group-preview.md and attach it to the thread says # Group artifact",
  );
  await composer.press("Enter");
  const groupMarkdown = page.getByRole("button", { name: "Preview group-preview.md" });
  await expect(groupMarkdown).toBeVisible({ timeout: 30_000 });
  await groupMarkdown.click();
  const markdownDialog = page.getByRole("dialog", { name: "group-preview.md" });
  await expect(markdownDialog.getByRole("heading", { name: "Group artifact" })).toBeVisible();
  await markdownDialog.getByRole("button", { name: "Close preview" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await expect(page.getByTestId("app-rail")).toHaveCount(0);
  // Chat fills the phone width.
  const transcriptBox = await transcript.boundingBox();
  expect(transcriptBox?.x).toBeLessThanOrEqual(16);
  expect(transcriptBox?.width).toBeGreaterThan(390 - 24);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
  await page.getByRole("button", { name: "Close navigation" }).click();
  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("side-panel");
  await expect(settings).toHaveAttribute("data-panel", "group");
  expect((await settings.boundingBox())?.width).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "group-settings-mobile");

  await rpc(page, "groups/remove", { groupId: reviewGroup.id });
  await page.goto(`/app/g/${reviewGroup.id}`);
  await page.waitForURL(/\/app\/(?!g\/)[^/]+$/);
  await expect(page.getByRole("combobox", { name: /Message/ })).toBeVisible();
});
