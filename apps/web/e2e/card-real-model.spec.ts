import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

/**
 * Live-model smoke for the CARD-01E producer path. It is opt-in because it
 * spends real model tokens and depends on provider behavior:
 *
 *   CARDS_UNIFIED_V2_ENABLED=true AGENT_RUNTIME=agentscope \
 *   REAL_MODEL_API_KEY=... pnpm test:e2e --runtime=agentscope \
 *   --spec="card-real-model.spec.ts"
 *
 * The key is read from the environment and written only to the disposable
 * test database; it is never part of the repository or the test output.
 */
const apiKey = process.env.REAL_MODEL_API_KEY;
const modelId = process.env.REAL_MODEL_ID ?? "qwen3.8-flash";

test.skip(
  process.env.AGENT_RUNTIME !== "agentscope" ||
    !apiKey ||
    process.env.CARDS_UNIFIED_V2_ENABLED !== "true",
  "Run with --runtime=agentscope, CARDS_UNIFIED_V2_ENABLED=true and REAL_MODEL_API_KEY",
);

test("real DashScope model creates an ask card that reaches attention and resumes", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  await signup(page, `real-model-${stamp}@rakazo.test`, "password12", "Real Model");
  await page.waitForURL(/\/(onboarding|app)/, { timeout: 20_000 });
  await rpc(page, "models/connect", {
    provider: "dashscope",
    modelId,
    apiKey,
  });
  await page.reload();
  await completeOnboarding(page);
  const welcome = page.getByRole("button", { name: /Day-to-day work/ });
  if (await welcome.isVisible().catch(() => false)) {
    await welcome.click();
  }
  const botId = activeBotId(page);
  await rpc(page, "bots/update", {
    botId,
    modelProvider: "dashscope",
    modelId,
  });
  // The welcome Run uses the same real model; let it settle before sending the
  // card prompt so the new message is not queued behind an open welcome turn.
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status?: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? "completed";
      },
      { timeout: 180_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe("completed");
  await page.setViewportSize({ width: 1440, height: 900 });

  const composer = page.getByPlaceholder(/Message/);
  await expect(composer).toBeEnabled({ timeout: 60_000 });
  await composer.fill(
    "I'm planning a short city break and I can't decide where to go. Ask me which city I should use, with exactly two options: Berlin and Seoul.",
  );
  await page.keyboard.press("Enter");

  const card = page.locator('[data-testid="interaction-card"][data-kind="input_request"]');
  await expect(card).toBeVisible({ timeout: 180_000 });
  await expect(card).toContainText(/city/i);
  await expect(card.getByRole("radio", { name: "Berlin" })).toBeVisible();
  await expect(card.getByRole("radio", { name: "Seoul" })).toBeVisible();
  await captureScreenshot(page, testInfo, "real-model-ask-card-1440");

  // The same pending request is an attention row; the queue only navigates
  // back to the source and never becomes a second action surface. Onboarding
  // may leave its own pending app-connection approvals in the queue, so assert
  // this specific row rather than a total that includes unrelated cards.
  const queueRow = page.getByTestId("attention-item").filter({ hasText: /city/i });
  await expect(page.getByTestId("attention-count")).toContainText(/\d+/);
  await page.getByTestId("attention-entry").click();
  await expect(page.getByTestId("attention-queue")).toBeVisible();
  await expect(queueRow).toBeVisible({ timeout: 60_000 });
  await captureScreenshot(page, testInfo, "real-model-attention-1440");
  await page.keyboard.press("Escape");

  await card.getByRole("radio", { name: "Berlin" }).check();
  await card.getByTestId("input-card-submit").click();
  await expect(card.getByTestId("input-card-submit")).toHaveCount(0, { timeout: 120_000 });
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status?: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? "completed";
      },
      { timeout: 180_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe("completed");
  await page.getByTestId("attention-entry").click();
  await expect(page.getByTestId("attention-item").filter({ hasText: /city/i })).toHaveCount(0, {
    timeout: 60_000,
  });
  await page.keyboard.press("Escape");
  await captureScreenshot(page, testInfo, "real-model-answered-1440");

  await page.reload();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("input-card-submit")).toHaveCount(0);
  await page.getByTestId("attention-entry").click();
  await expect(page.getByTestId("attention-item").filter({ hasText: /city/i })).toHaveCount(0, {
    timeout: 30_000,
  });
});
