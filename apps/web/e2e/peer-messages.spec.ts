import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("shows peer chips in transcript and opens view-only peer chat", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `peer-msg-${stamp}@rakazo.test`, "password12", "Peer Msg");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await rpc(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("message the bot named Researcher saying peer-exchange-alpha");
  await composer.press("Enter");
  await expect(page.getByText("messaging that bot now.").first()).toBeVisible({
    timeout: 60_000,
  });

  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  const transcript = page.getByTestId("transcript");
  const receipt = transcript
    .getByTestId("peer-receipt-row")
    .filter({ hasText: "Researcher" })
    .first();
  await expect(receipt).toBeVisible({ timeout: 30_000 });
  await expect(receipt.getByText(/Messaged/)).toBeVisible();
  await expect(receipt.getByRole("button", { name: "Messaged Researcher" })).toBeVisible();
  await expect(receipt.locator(".rakazo-agent-avatar")).toBeVisible();
  await expect(receipt).not.toContainText("{peer}");
  // User bubble still contains the phrase; the private body stays out of the row.
  await expect(receipt).not.toContainText("peer-exchange-alpha");
  await expect(
    transcript.getByTestId("message-user-bubble").getByText("peer-exchange-alpha"),
  ).toHaveCount(1);
  const assertReceiptCompact = async () => {
    const transcriptBox = await transcript.boundingBox();
    // The row is a full-width centering track; the visible receipt pill is the
    // compact unit the prototype constrains.
    const pillBox = await receipt
      .getByRole("button", { name: "Messaged Researcher" })
      .boundingBox();
    expect(transcriptBox).not.toBeNull();
    expect(pillBox).not.toBeNull();
    // The prototype centers the lightweight receipt divider in the transcript.
    const transcriptCenter = transcriptBox!.x + transcriptBox!.width / 2;
    const pillCenter = pillBox!.x + pillBox!.width / 2;
    expect(Math.abs(transcriptCenter - pillCenter)).toBeLessThanOrEqual(24);
    // Stay under 75% of the transcript width so the row cannot become a full-width bar.
    expect(pillBox!.width).toBeLessThan(transcriptBox!.width * 0.75);
  };

  await assertReceiptCompact();
  await expect(composer).toBeVisible();
  await captureScreenshot(page, testInfo, "peer-receipt-desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await receipt.scrollIntoViewIfNeeded();
  await expect(receipt).toBeVisible();
  await expect(composer).toBeVisible();
  await assertReceiptCompact();
  await captureScreenshot(page, testInfo, "peer-receipt-mobile");

  const trigger = receipt.getByRole("button", { name: "Messaged Researcher" });
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  const view = page.getByTestId("peer-conversation-view");
  await expect(view).toBeVisible();
  await expect(view.getByRole("heading", { name: /Chief · Researcher/ })).toBeVisible();
  await expect(
    view.getByText(
      "You can read this collaboration record, but you cannot speak in the chat between Agents.",
    ),
  ).toBeVisible();
  await expect(view.getByRole("button", { name: "Close chat", exact: true })).toHaveCount(1);
  await expect(view.getByText("peer-exchange-alpha").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(view.getByRole("textbox")).toHaveCount(0);
  await expect(view.getByText("Loading")).toHaveCount(0);
  const peerTranscript = view.getByTestId("peer-conversation-transcript");
  await peerTranscript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      peerTranscript.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      ),
    )
    .toBe(true);
  await captureScreenshot(page, testInfo, "peer-view-only");
});

test("expands a multi-target receipt and opens one bound private pair", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `peer-multi-${stamp}@rakazo.test`, "password12", "Peer Multi");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  for (const name of ["Researcher", "Analyst"]) {
    await rpc(page, "bots/create", {
      name,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
  }
  await page.reload();
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("message both bots named Researcher and Analyst saying peer-multi-alpha");
  await composer.press("Enter");

  const transcript = page.getByTestId("transcript");
  const row = transcript.getByTestId("peer-receipt-row").filter({ hasText: "2 Agents" });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toHaveAttribute("data-receipt-count", "2");
  await expect(row).not.toContainText("peer-multi-alpha");
  await captureScreenshot(page, testInfo, "peer-receipt-multi-desktop");

  const toggle = row.getByRole("button", {
    name: "Show the 2 Agents this message was sent to",
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("menuitem", { name: "Open the chat with Researcher" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Open the chat with Analyst" })).toBeVisible();
  await captureScreenshot(page, testInfo, "peer-receipt-multi-open");

  await page.getByRole("menuitem", { name: "Open the chat with Researcher" }).click();
  const view = page.getByTestId("peer-conversation-view");
  await expect(view).toBeVisible();
  await expect(view.getByRole("heading", { name: /Chief · Researcher/ })).toBeVisible();
  await expect(view.getByText("peer-multi-alpha").first()).toBeVisible({ timeout: 30_000 });
  await expect(view.getByRole("button", { name: "Close chat", exact: true })).toHaveCount(1);
  await expect(view.getByRole("textbox")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "peer-overlay-multi-desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(view).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
  await captureScreenshot(page, testInfo, "peer-overlay-multi-narrow");
  await view.getByRole("button", { name: "Close chat", exact: true }).click();
  await expect(view).toHaveCount(0);
});
