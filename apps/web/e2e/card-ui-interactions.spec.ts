import { expect, type Locator, type Page, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function scrollIntoView(locator: Locator) {
  await expect(async () => {
    await locator.scrollIntoViewIfNeeded();
  }).toPass({ timeout: 5_000 });
}

async function waitForWaitingRun(page: Page, botId: string) {
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");
}

async function finishWelcomeSetup(page: Page) {
  // Local onboarding can leave the first-focus choice open; answer it so the
  // first Run is not queued behind an unanswered welcome card.
  const choice = page.getByRole("button", { name: /Day-to-day work/ });
  if (await choice.isVisible().catch(() => false)) {
    await choice.click();
  }
}

async function send(page: Page, text: string) {
  const composer = page.getByPlaceholder(/Message/);
  await expect(composer).toBeEnabled({ timeout: 60_000 });
  await composer.fill(text);
  await page.keyboard.press("Enter");
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
}

test("renders an MCP assignment as the unified CARD-01B card and settles it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `card-mcp-${stamp}@rakazo.test`, "password12", "Card MCP");
  await completeOnboarding(page);
  await finishWelcomeSetup(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await send(page, "show an mcp approval card");

  const card = page
    .locator('[data-testid="interaction-card"][data-kind="action_approval"]')
    .filter({ hasText: "MCP assignment" });
  // The welcome flow can leave its own pending connection card on screen;
  // scope the region assertion to this Run's MCP card.
  await expect(card).toBeVisible({ timeout: 30_000 });
  const region = card.locator(
    'xpath=ancestor::section[@data-testid="intervention-region"][@data-surface="interaction-v2"]',
  );
  await expect(region).toBeVisible();
  await expect(card.getByTestId("interaction-status")).toContainText("Waiting for your decision");
  await expect(card.getByTestId("mcp-allow-all-tools")).toContainText("allowAllTools: true");
  await expect(card).toContainText("All tools on this server");
  await expect(page.getByTestId("mcp-approval-card")).toHaveCount(0);
  await expect(page.locator("[data-intervention-id]")).toHaveCount(0);
  await scrollIntoView(card);
  await captureScreenshot(page, testInfo, "card-ui-mcp-desktop-1440");

  await page.setViewportSize({ width: 390, height: 844 });
  await scrollIntoView(card);
  await expect(card).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureScreenshot(page, testInfo, "card-ui-mcp-390");

  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page);
  await captureScreenshot(page, testInfo, "card-ui-mcp-375");

  await page.setViewportSize({ width: 1440, height: 900 });
  await card.getByRole("button", { name: "Allow all tools", exact: true }).click();
  await expect(card.getByTestId("interaction-status")).toContainText("Allowed", {
    timeout: 20_000,
  });
  await expect(card.getByRole("button", { name: "Allow all tools", exact: true })).toHaveCount(0);
  // The settled card owns an Execution surface even after the Run finishes, so
  // it must stay in the DOM rather than vanishing with the pending signal.
  await expect(card).toBeVisible();
  expect(await card.evaluate((element) => element.className.includes("opacity-"))).toBe(false);
  await page.emulateMedia({ colorScheme: "dark" });
  await scrollIntoView(card);
  await captureScreenshot(page, testInfo, "card-ui-mcp-terminal-dark");
});

test("replaces the legacy approval ask with one CARD-01B decision card", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `card-approval-${stamp}@rakazo.test`, "password12", "Card Approval");
  await completeOnboarding(page);
  await finishWelcomeSetup(page);
  const botId = activeBotId(page);
  await rpc(page, "approvalRules/set", {
    effect: "require_approval",
    matchKind: "connector",
    matchValue: "destination.write",
  });

  await send(page, "write this to the destination crm as a note");
  await waitForWaitingRun(page, botId);

  const card = page
    .locator('[data-testid="interaction-card"][data-kind="action_approval"]')
    .filter({ hasText: "Allow once" });
  // The welcome flow can leave its own pending connection card on screen;
  // scope every assertion to this Run's decision card.
  await expect(card).toBeVisible({ timeout: 30_000 });
  const region = card.locator(
    'xpath=ancestor::section[@data-testid="intervention-region"][@data-surface="interaction-v2"]',
  );
  await expect(region).toBeVisible();
  await expect(card.getByTestId("interaction-status")).toContainText("Waiting for your decision");
  await expect(card.getByTestId("approval-primary")).toContainText("Allow once");
  await expect(card.getByTestId("approval-secondary")).toContainText("Deny");
  // The projection is the only surface: the legacy ask never double-renders.
  await expect(page.locator("[data-intervention-id]")).toHaveCount(0);
  await expect(page.getByText("Allow once", { exact: true })).toHaveCount(1);
  await scrollIntoView(card);
  await captureScreenshot(page, testInfo, "card-ui-tool-approval");

  await card.getByTestId("approval-secondary").click();
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0, {
    timeout: 45_000,
  });
});

test("edits and confirms an A10 outbound draft in the same card", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `card-outbound-${stamp}@rakazo.test`, "password12", "Card Outbound");
  await completeOnboarding(page);
  await finishWelcomeSetup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = activeBotId(page);
  const snapshot = await rpc<{ threadId: string }>(page, "threads/get", { botId });
  const seeded = await page.request.post(`${process.env.API_URL}/__e2e/outbound-draft`, {
    data: { botId, threadId: snapshot.threadId },
  });
  expect(seeded.ok()).toBe(true);
  await page.reload();

  const card = page
    .locator('[data-testid="interaction-card"][data-kind="action_approval"]')
    .filter({ hasText: "Outbound draft" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Outbound draft · r1");
  await expect(card).toContainText("Weekly digest");
  await scrollIntoView(card);
  await captureScreenshot(page, testInfo, "card-ui-outbound-r1-desktop");

  await card.getByTestId("outbound-edit").click();
  const form = page.getByTestId("outbound-edit-form");
  await form.locator("#outbound-subject").fill("Weekly digest r2");
  await form.locator("#outbound-body").fill("Edited body for r2");
  await captureScreenshot(page, testInfo, "card-ui-outbound-edit-desktop");
  await page.getByTestId("outbound-save").click();

  const revisions = page.getByTestId("outbound-revisions");
  await expect(revisions).toContainText("r2");
  await expect(page.getByTestId("outbound-revision-1")).toContainText("Superseded");
  await expect(page.getByTestId("outbound-revision-2")).toContainText("Pending");
  await captureScreenshot(page, testInfo, "card-ui-outbound-r2-audit-desktop");

  await page.getByTestId("outbound-prepare").click();
  const confirm = page.getByTestId("outbound-confirm");
  await expect(confirm).toContainText("r2");
  await expect(confirm).toContainText("Edited body for r2");
  await captureScreenshot(page, testInfo, "card-ui-outbound-confirm-desktop");

  for (const [width, height, name] of [
    [390, 844, "card-ui-outbound-confirm-390"],
    [375, 812, "card-ui-outbound-confirm-375"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(confirm).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(1);
    await captureScreenshot(page, testInfo, name);
  }

  await page
    .getByTestId("outbound-draft-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.getByTestId("outbound-draft-dialog")).toHaveCount(0);
  await expect(card).toBeVisible();
  await expect(card).toContainText("r2");
  await scrollIntoView(card);
  await captureScreenshot(page, testInfo, "card-ui-outbound-r2-card-375");

  await page.setViewportSize({ width: 1440, height: 900 });
  await scrollIntoView(card);
  await captureScreenshot(page, testInfo, "card-ui-outbound-r2-card-desktop");
});

// GROUP-DM-GATE-01: the group/DM hard gate and the honest terminal states are
// asserted against the real page by injecting the server-projection views into
// the snapshot. The UI owner-only backend check is covered by the PostgreSQL
// contract test; here we prove what the user can actually see and click.
test("group ask guidance, group approval without always, DM input and expired honesty", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `card-gate-${stamp}@rakazo.test`, "password12", "Card Gate");
  await completeOnboarding(page);
  await finishWelcomeSetup(page);
  const chiefId = activeBotId(page);
  const second = await rpc<{ id: string }>(page, "bots/create", {
    name: "Reviewer",
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Gate team",
    botIds: [chiefId, second.id],
  });
  const iso = new Date().toISOString();
  const sourceOf = (threadId: string, botId = chiefId) => ({
    spaceId: "space-e2e",
    threadId,
    messageId: null,
    runId: null,
    botId,
  });
  const toolApproval = (effectStatus: string) => ({
    kind: "tool",
    authority: "external_effect",
    effectId: "effect-gate-1",
    effectStatus,
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "always", label: "Always allow this tool" },
      { id: "deny", label: "Deny" },
    ],
  });
  const inputView = (threadId: string, id: string, botId = chiefId) => ({
    kind: "input_request",
    interactionId: id,
    revision: 1,
    status: "pending",
    createdAt: iso,
    expiresAt: null,
    attentionAt: iso,
    source: sourceOf(threadId, botId),
    presentation: { text: "Which supplier should I compare next?" },
    input: {
      mode: "question",
      prompt: "Which supplier should I compare next?",
      placeholder: null,
    },
  });
  const approvalView = (threadId: string, id: string, status: string, effectStatus: string) => ({
    kind: "action_approval",
    interactionId: id,
    revision: 1,
    status,
    createdAt: iso,
    expiresAt: null,
    attentionAt: iso,
    source: sourceOf(threadId),
    presentation: { text: "Approve the export?", detail: "Sends the comparison out." },
    decision: null,
    approval: toolApproval(effectStatus),
  });

  await page.route("**/rpc/threads/get", async (route) => {
    const post = route.request().postData() ?? "";
    const isGroup = post.includes(group.id);
    if (!isGroup && !post.includes(second.id) && !post.includes(chiefId)) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const parsed = (await response.json()) as {
      json?: Record<string, unknown> & { threadId?: string };
    };
    const snapshot = parsed.json;
    if (!snapshot?.threadId) {
      await route.fulfill({ response });
      return;
    }
    const interactions = isGroup
      ? [
          inputView(snapshot.threadId, "i-group-input"),
          approvalView(snapshot.threadId, "i-group-approval", "pending", "intended"),
          approvalView(snapshot.threadId, "i-group-expired", "expired", "expired"),
        ]
      : [inputView(snapshot.threadId, "i-dm-input", second.id)];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...parsed, json: { ...snapshot, interactions } }),
    });
  });

  await page.goto(`/app/g/${group.id}`);
  await expect(page.getByRole("combobox", { name: /Message Gate team/ })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });

  // GDG-02: a group ask is text + direct-chat guidance, never a submit control.
  const groupInput = page
    .locator('[data-testid="interaction-card"][data-kind="input_request"]')
    .first();
  await expect(groupInput).toBeVisible({ timeout: 30_000 });
  await expect(groupInput).toContainText("Which supplier should I compare next?");
  await expect(groupInput).toContainText("Open the direct chat with this Bot");
  await expect(groupInput.locator('textarea[aria-label="Your answer"]')).toHaveCount(0);
  await expect(groupInput.getByTestId("input-card-submit")).toHaveCount(0);
  await scrollIntoView(groupInput);
  await captureScreenshot(page, testInfo, "GDG-02-group-ask");

  // GDG-04: the group approval keeps the owner decision but drops "always".
  const groupApproval = page
    .locator('[data-testid="interaction-card"][data-kind="action_approval"]')
    .filter({ hasText: "Approve the export?" })
    .first();
  await expect(groupApproval).toBeVisible();
  await expect(groupApproval).toContainText("Allow once");
  await expect(groupApproval).not.toContainText("Always allow this tool");
  await scrollIntoView(groupApproval);
  await captureScreenshot(page, testInfo, "GDG-04-group-approval");

  // GDG-07: expired approval has no re-run, explains itself and keeps the body.
  const expired = page
    .locator('[data-testid="interaction-card"][data-kind="action_approval"]')
    .filter({ hasText: "Approve the export?" })
    .last();
  await expect(expired).toContainText("Effect expired");
  await expect(expired).toContainText("This approval expired before a decision");
  await expect(expired).not.toContainText(/retry|重新执行/i);
  await expect(expired.getByTestId("approval-primary")).toHaveCount(0);
  await scrollIntoView(expired);
  await captureScreenshot(page, testInfo, "GDG-07-expired-no-rerun");

  // GDG-03: the same question in a direct chat remains answerable. Use a real
  // scripted ask after removing the snapshot mock, so the server producer and
  // the card both participate.
  await page.unroute("**/rpc/threads/get");
  await page.goto(`/app/${second.id}`);
  await send(page, "run 1 tracked steps then ask");
  const dmInput = page
    .locator('[data-testid="interaction-card"][data-kind="input_request"]')
    .first();
  await expect(dmInput).toBeVisible({ timeout: 60_000 });
  await expect(dmInput.locator('textarea[aria-label="Your answer"]')).toBeVisible();
  await expect(dmInput.getByTestId("input-card-submit")).toBeVisible();
  await scrollIntoView(dmInput);
  await captureScreenshot(page, testInfo, "GDG-03-dm-ask");
});
