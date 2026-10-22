import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

/**
 * RT-22 (AC32-AC36): the group capsule and the right panel share one real
 * identity projection, the inline group name propagates to every surface that
 * names the group, and the Work / Library / Members pages stay honest about
 * what is connected.
 */
test("group capsule and right panel read real group scope data", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `panel-${stamp}@rakazo.test`, "password12", "Panel E2E");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const joy = await createNamedBot(page, "Joy");
  const blue = await createNamedBot(page, "Blue");
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Release roundtable",
    botIds: [joy, blue],
  });
  await page.goto(`/app/g/${group.id}`);
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  const trigger = page.getByTestId("bot-settings-trigger");
  const panel = page.getByTestId("side-panel");
  const capsuleCluster = trigger.getByTestId("group-identity-cluster");

  // AC32: one capsule toggles one panel; capsule and panel share one identity set.
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect(panel).toHaveAttribute("data-panel", "group");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(capsuleCluster).toBeVisible();
  await expect(capsuleCluster.locator(".rakazo-agent-avatar")).toHaveCount(2);
  await expect(capsuleCluster).toContainText("P");
  const panelCluster = panel.getByTestId("group-identity-cluster");
  await expect(panelCluster).toBeVisible();
  await expect(panelCluster).toHaveCount(1);
  expect(await panelCluster.getAttribute("aria-label")).toBe(
    await capsuleCluster.getAttribute("aria-label"),
  );
  await captureScreenshot(page, testInfo, "group-panel-details");
  await trigger.click();
  await expect(panel).toHaveAttribute("data-panel", "closed");

  // AC33: Escape drops the draft without any write; Enter saves and syncs everywhere.
  let updateCalls = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/groups/update")) updateCalls += 1;
  });
  await trigger.click();
  const nameField = panel.getByTestId("group-name-field");
  await nameField.click();
  await nameField.fill("Wrong name");
  await nameField.press("Escape");
  await expect(nameField).toHaveValue("Release roundtable");
  expect(updateCalls).toBe(0);
  await nameField.click();
  await nameField.fill("Launch table");
  await nameField.press("Enter");
  await expect(nameField).toHaveValue("Launch table");
  expect(updateCalls).toBe(1);
  await expect(trigger).toContainText("Launch table");
  await expect(page.getByRole("combobox", { name: "Message Launch table" })).toBeVisible();
  await expect(
    page
      .locator("aside")
      .first()
      .getByText("Launch table", { exact: false })
      .first(),
  ).toBeVisible();

  // AC34: the Work tab carries no count and shows no fabricated work rows.
  const workTab = panel.getByTestId("group-panel-tab-work");
  await expect(workTab).toHaveText("Work");
  await workTab.click();
  await expect(panel.getByTestId("group-work-unavailable")).toBeVisible();
  await expect(panel.getByTestId("group-routine-row")).toHaveCount(0);
  await workTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(panel.getByTestId("group-panel-tab-library")).toBeFocused();

  // AC36: real group artifacts land in a date-grouped, frameless list.
  const content = Buffer.from("# Panel proof\n").toString("base64");
  await rpc(page, "artifacts/create", {
    groupId: group.id,
    name: "panel-proof.md",
    mimeType: "text/markdown",
    contentBase64: content,
  });
  await rpc(page, "artifacts/create", {
    groupId: group.id,
    name: "release-checklist.md",
    mimeType: "text/markdown",
    contentBase64: content,
  });
  await panel.getByTestId("group-panel-tab-library").click();
  // Reopening the panel refreshes the group-scoped reads.
  await trigger.click();
  await trigger.click();
  await panel.getByTestId("group-panel-tab-library").click();
  const libraryRows = panel.getByTestId("group-library-row");
  await expect(libraryRows).toHaveCount(2);
  await expect(panel.getByTestId("group-panel").getByText("panel-proof.md")).toBeVisible();
  await expect(panel.getByTestId("group-panel").getByText("release-checklist.md")).toBeVisible();
  const libraryRow = libraryRows.first();
  await expect(panel.getByText("Today", { exact: true })).toBeVisible();
  await libraryRow.focus();
  await expect(libraryRow).toBeFocused();
  const resting = await libraryRow.evaluate((node) => getComputedStyle(node).backgroundColor);
  await libraryRow.hover();
  const hovered = await libraryRow.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(hovered).not.toBe(resting);
  await captureScreenshot(page, testInfo, "group-panel-library");

  // AC35: the member head counts Agents only; rows and add entries stay borderless.
  await panel.getByTestId("group-panel-tab-members").click();
  await expect(panel.getByText("2 Agents")).toBeVisible();
  await expect(panel.getByText("3 Agents")).toHaveCount(0);
  const memberRows = panel.getByTestId("group-member-row");
  await expect(memberRows).toHaveCount(2);
  for (const row of await memberRows.all()) {
    expect(await row.evaluate((node) => getComputedStyle(node).borderTopWidth)).toBe("0px");
  }
  const addAgent = panel.getByTestId("group-add-agent");
  await expect(addAgent).toContainText("＋");
  expect(await addAgent.evaluate((node) => getComputedStyle(node).borderTopWidth)).toBe("0px");
  await captureScreenshot(page, testInfo, "group-panel-members");
  await addAgent.click();
  await expect(panel).toHaveAttribute("data-panel", "group-settings");

  // Narrow screens: the panel overlays instead of squeezing the transcript.
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await expect(panel).toHaveAttribute("data-panel", "group");
  expect((await panel.boundingBox())?.width).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "group-panel-mobile");

  await rpc(page, "groups/remove", { groupId: group.id });
});
