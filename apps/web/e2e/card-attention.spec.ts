import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

const ASK_PROMPT = "Ask me which city to use.";
const GROUP_NAME = "Attention room";

/**
 * CARD-01D at the production boundary: the attention queue reads real pending
 * facts, returns to (and focuses) the source Interaction, refreshes after a
 * local decision, notifies only for new requests, and marks waiting group
 * members from that group's own pending items.
 */
test.describe("attention queue (N1-N4)", () => {
  test.skip(
    process.env.CARDS_UNIFIED_V2_ENABLED !== "true",
    "Run with CARDS_UNIFIED_V2_ENABLED=true",
  );

  test("queues pending requests, returns to the source, and notifies new ones", async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    await page.addInitScript(() => {
      type AttentionNotification = { title: string; body?: string; tag?: string };
      class FakeNotification {
        static permission = "granted";
        static requestPermission = async () => "granted";
        onclick: (() => void) | null = null;
        closed = false;
        constructor(title: string, options?: NotificationOptions) {
          (
            window as unknown as { __attentionNotifications: AttentionNotification[] }
          ).__attentionNotifications.push({ title, body: options?.body, tag: options?.tag });
          (
            window as unknown as { __lastAttentionNotification: FakeNotification }
          ).__lastAttentionNotification = this;
        }
        close() {
          this.closed = true;
        }
      }
      (
        window as unknown as { __attentionNotifications: AttentionNotification[] }
      ).__attentionNotifications = [];
      (window as unknown as { Notification: unknown }).Notification = FakeNotification;
    });

    const stamp = Date.now();
    await signup(page, `attention-${stamp}@rakazo.test`, "password12", "Attention E2E");
    await completeOnboarding(page);
    await page.goto("/app");
    await page.waitForURL(/\/app\/[^/]+$/);

    const joy = await createBot(page, "Joy");
    const scout = await createBot(page, "Scout");
    const blue = await createBot(page, "Blue");

    await page.goto(`/app/${joy.id}`);
    await page.waitForURL(new RegExp(`/app/${joy.id}$`));
    const composer = page.getByTestId("composer-bar").getByRole("combobox");
    await expect(composer).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await composer.fill(ASK_PROMPT);
    await composer.press("Enter");

    // N1: one real pending input appears in the queue with a safe summary.
    const entry = page.getByTestId("attention-entry");
    await expect(entry).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("attention-count")).toHaveText("1", { timeout: 30_000 });
    await entry.click();
    const queue = page.getByTestId("attention-queue");
    await expect(queue).toBeVisible();
    const row = queue.getByTestId("attention-item").first();
    await expect(row).toContainText("Which city should I use?");
    await expect(row).toContainText("Joy");
    await expect(row).not.toContainText("Intervention");
    await captureScreenshot(page, testInfo, "N1-queue-1440");

    // 375px and dark: the panel stays inside the viewport.
    await page.setViewportSize({ width: 375, height: 900 });
    await expect(queue).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await captureScreenshot(page, testInfo, "N1-queue-375");
    await page.emulateMedia({ colorScheme: "dark" });
    // The appearance listener resolves on the next frame; capture only after
    // the root really carries the dark tokens.
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme), {
        timeout: 10_000,
      })
      .toBe("dark");
    await captureScreenshot(page, testInfo, "N1-queue-375-dark");
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(queue).toBeVisible();
    await captureScreenshot(page, testInfo, "N1-queue-390-dark");
    await page.setViewportSize({ width: 375, height: 900 });

    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1440, height: 900 });

    // Keyboard: Escape closes the panel and returns focus to the entry.
    await page.keyboard.press("Escape");
    await expect(queue).toBeHidden();
    await expect(entry).toBeFocused();

    // Opening the row returns to the source card and focuses it.
    await entry.click();
    await row.click();
    await page.waitForURL(new RegExp(`/app/${joy.id}\\?.*i=`));
    await expect
      .poll(
        async () =>
          page.evaluate(() => document.activeElement?.getAttribute("data-interaction-id") ?? null),
        { timeout: 15_000, intervals: [200, 500, 1_000] },
      )
      .not.toBeNull();

    // Answering in the source card must drop the queue row and count.
    const card = page.locator("[data-interaction-id]").first();
    await expect(card).toBeVisible();
    await card.locator("textarea").fill("Berlin");
    await card.getByTestId("input-card-submit").click();
    await expect(card).toContainText("Answered", { timeout: 30_000 });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("attention-count")).toHaveCount(0, { timeout: 30_000 });

    // N4: a request that appears in another thread while this one is foreground
    // notifies once with only the Bot and a safe summary; clicking returns.
    await rpc(page, "threads/send", { botId: scout.id, text: ASK_PROMPT });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __attentionNotifications: unknown[] })
                .__attentionNotifications.length,
          ),
        { timeout: 30_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(1);
    const notification = await page.evaluate(() =>
      (
        window as unknown as {
          __attentionNotifications: Array<{ title: string; body?: string; tag?: string }>;
        }
      ).__attentionNotifications.at(0),
    );
    expect(notification?.title).toContain("Scout");
    expect(notification?.body).toContain("Which city should I use?");
    expect(notification?.body).not.toMatch(/@|\\$|\\d{4}-\\d{4}/);
    await captureScreenshot(page, testInfo, "N4-notification-1440");

    await page.evaluate(() =>
      (
        window as unknown as { __lastAttentionNotification: { onclick?: () => void } }
      ).__lastAttentionNotification.onclick?.(),
    );
    await page.waitForURL(new RegExp(`/app/${scout.id}\\?.*i=`), { timeout: 15_000 });

    // N2: the group member marker comes from that group's own pending item.
    const group = await rpc<{ id: string }>(page, "groups/create", {
      name: GROUP_NAME,
      botIds: [joy.id, blue.id],
    });
    await page.goto(`/app/g/${group.id}`);
    await page.waitForURL(/\/app\/g\/[^/]+$/);
    const groupComposer = page.getByTestId("composer-bar").getByRole("combobox");
    await expect(groupComposer).toBeVisible();
    await groupComposer.fill(ASK_PROMPT);
    await groupComposer.press("Enter");
    await expect(page.getByTestId("attention-count")).toBeVisible({ timeout: 60_000 });

    await page.getByTestId("bot-settings-trigger").click();
    const panel = page.getByTestId("side-panel");
    await expect(panel).toHaveAttribute("data-panel", "group");
    await panel.getByTestId("group-panel-tab-members").click();
    const waiting = panel.getByTestId("group-member-waiting").first();
    await expect(waiting).toBeVisible({ timeout: 30_000 });
    await captureScreenshot(page, testInfo, "N2-member-waiting-1440");
    await waiting.click();
    await page.waitForURL(/\/app\/g\/[^/]+\?.*i=/, { timeout: 15_000 });

    // N3: attention and unread are separate facts on separate elements.
    const attentionBadge = page.getByTestId("attention-count");
    await expect(attentionBadge).toBeVisible();
    expect(await attentionBadge.evaluate((element) => element.textContent)).toMatch(/^\d+$/);
  });

  test("keeps the list usable when browser notifications are denied", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => {
      class DeniedNotification {
        static permission = "denied";
        static requestPermission = async () => "denied";
        constructor() {}
        close() {}
      }
      (window as unknown as { Notification: unknown }).Notification = DeniedNotification;
    });
    const stamp = Date.now();
    await signup(page, `attention-denied-${stamp}@rakazo.test`, "password12", "Attention E2E");
    await completeOnboarding(page);
    await page.goto("/app");
    await page.waitForURL(/\/app\/[^/]+$/);
    const joy = await createBot(page, "Joy");
    await page.goto(`/app/${joy.id}`);
    await page.waitForURL(new RegExp(`/app/${joy.id}$`));
    const composer = page.getByTestId("composer-bar").getByRole("combobox");
    await composer.fill(ASK_PROMPT);
    await composer.press("Enter");
    await expect(page.getByTestId("attention-count")).toHaveText("1", { timeout: 60_000 });
    await page.getByTestId("attention-entry").click();
    await expect(page.getByTestId("attention-item").first()).toContainText(
      "Which city should I use?",
    );
    await captureScreenshot(page, testInfo, "N1-queue-denied-1440");
  });
});

async function createBot(page: Parameters<typeof rpc>[0], name: string) {
  return rpc<{ id: string; name: string }>(page, "bots/create", {
    name,
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
}
