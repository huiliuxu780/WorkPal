import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

const apiKey = process.env.REAL_MODEL_API_KEY;

test.skip(
  process.env.AGENT_RUNTIME !== "agentscope" || !apiKey,
  "Run with --runtime=agentscope and REAL_MODEL_API_KEY",
);

function html(label: string, marker: string) {
  return `<!doctype html><html><body><main><h1>${label} ${marker}</h1><p>marker-${marker}</p></main></body></html>`;
}

async function waitForRun(page: import("@playwright/test").Page, botId: string) {
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status?: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? "completed";
      },
      { timeout: 360_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe("completed");
}

for (const [modelId, label] of [
  ["qwen3.8-flash", "Qwen Flash"],
  ["qwen3.8-max", "Qwen Max"],
] as const) {
  test(`real DashScope ${modelId} publishes and updates a page`, async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signup(
      page,
      `real-chat-chrome-${modelId}-${Date.now()}@rakazo.test`,
      "password12",
      `Real ${label}`,
    );
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
    await waitForRun(page, botId);

    const composer = page.getByPlaceholder(/Message/);
    await expect(composer).toBeEnabled({ timeout: 120_000 });
    await composer.fill(
      `Use the write_file tool to create report.html with this exact content: ${html(label, "A")}. Then use the attach_file tool with path "report.html". Do not call any other tool.`,
    );
    await page.keyboard.press("Enter");

    const cards = page.getByTestId("artifact-page-card");
    await expect(cards).toHaveCount(1, { timeout: 360_000 });
    await expect(cards.nth(0).getByText("页面", { exact: true })).toBeVisible();
    await waitForRun(page, botId);
    await cards.nth(0).scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await captureScreenshot(page, testInfo, `real-${modelId}-AC03-first-card`);

    await expect(composer).toBeEnabled({ timeout: 120_000 });
    await composer.fill(
      `Use the write_file tool to overwrite report.html with this exact content: ${html(label, "B")}. Then use the attach_file tool with path "report.html". Do not call any other tool.`,
    );
    await page.keyboard.press("Enter");
    await expect(cards).toHaveCount(2, { timeout: 360_000 });
    await expect(cards.nth(0)).toHaveAttribute("data-stale", "true");
    await expect(cards.nth(1)).not.toHaveAttribute("data-stale", "true");
    await waitForRun(page, botId);
    await cards.nth(1).scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await captureScreenshot(page, testInfo, `real-${modelId}-AC04-updated-cards`);

    await cards.nth(0).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const preview = dialog.frameLocator("iframe").frameLocator("#preview");
    await expect(preview.getByRole("heading", { name: `${label} B` })).toBeVisible({
      timeout: 30_000,
    });
    await captureScreenshot(page, testInfo, `real-${modelId}-AC05-latest-detail`);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}
