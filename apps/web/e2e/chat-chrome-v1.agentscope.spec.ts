import { expect, test } from "@playwright/test";
import { startModelEmulator } from "../../../packages/testkit/src/model-emulator.js";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

const pageHtml = (marker: string) =>
  `<!doctype html><html><body><main><h1>Report ${marker}</h1><p>marker-${marker}</p></main></body></html>`;

test("Java AgentScope publishes and updates an HTML page in the chat", async ({
  page,
}, testInfo) => {
  test.skip(process.env.AGENT_RUNTIME !== "agentscope", "Run with --runtime=agentscope");
  test.setTimeout(180_000);
  const intro = await startModelEmulator({
    apiKey: "web-chat-chrome-intro-key",
    steps: [{ expect() {}, response: { type: "text", text: "Ready to help." } }],
  });
  let task: Awaited<ReturnType<typeof startModelEmulator>> | undefined;
  try {
    await signup(page, `java-chat-chrome-${Date.now()}@rakazo.test`, "password12", "Java Chat");
    await page.waitForURL(/\/(onboarding|app)/);
    await rpc(page, "models/connect", {
      provider: intro.model.provider,
      modelId: intro.model.id,
      baseUrl: intro.baseUrl,
      apiKey: "web-chat-chrome-intro-key",
    });
    await page.reload();
    await completeOnboarding(page);
    const botId = activeBotId(page);
    await expect
      .poll(
        async () => {
          const thread = await rpc<{ run?: { status?: string } | null }>(page, "threads/get", {
            botId,
          });
          return thread.run?.status ?? "completed";
        },
        { timeout: 45_000 },
      )
      .toBe("completed");

    task = await startModelEmulator({
      apiKey: "web-chat-chrome-task-key",
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Publish report A");
            expect(request.tools?.some((tool) => tool.function.name === "write_file")).toBe(true);
            expect(request.tools?.some((tool) => tool.function.name === "attach_file")).toBe(true);
          },
          response: {
            type: "tool",
            id: "chat-chrome-write-a",
            name: "write_file",
            arguments: { path: "report.html", content: pageHtml("A") },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("chat-chrome-write-a");
          },
          response: {
            type: "tool",
            id: "chat-chrome-attach-a",
            name: "attach_file",
            arguments: { path: "report.html" },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("chat-chrome-attach-a");
          },
          response: { type: "text", text: "Published report A." },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Update report B");
          },
          response: {
            type: "tool",
            id: "chat-chrome-write-b",
            name: "write_file",
            arguments: { path: "report.html", content: pageHtml("B") },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("chat-chrome-write-b");
          },
          response: {
            type: "tool",
            id: "chat-chrome-attach-b",
            name: "attach_file",
            arguments: { path: "report.html" },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("chat-chrome-attach-b");
          },
          response: { type: "text", text: "Updated report B." },
        },
      ],
    });
    await rpc(page, "models/connect", {
      provider: task.model.provider,
      modelId: task.model.id,
      baseUrl: task.baseUrl,
      apiKey: "web-chat-chrome-task-key",
    });
    await rpc(page, "bots/update", {
      botId,
      modelProvider: task.model.provider,
      modelId: task.model.id,
    });

    const composer = page.getByPlaceholder(/Message/);
    await composer.fill("Publish report A as report.html and attach it.");
    await page.keyboard.press("Enter");
    const cards = page.getByTestId("artifact-page-card");
    await expect(cards).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("transcript").getByText("Published report A.")).toBeVisible({
      timeout: 60_000,
    });
    await expect(cards.nth(0)).not.toHaveAttribute("data-stale", "true");
    await captureScreenshot(page, testInfo, "agentscope-AC03-first-card");

    await composer.fill("Update report B in the same report.html and attach it.");
    await page.keyboard.press("Enter");
    await expect(cards).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId("transcript").getByText("Updated report B.")).toBeVisible({
      timeout: 60_000,
    });
    await expect(cards.nth(0)).toHaveAttribute("data-stale", "true");
    await expect(cards.nth(1)).not.toHaveAttribute("data-stale", "true");
    await captureScreenshot(page, testInfo, "agentscope-AC04-updated-cards");

    await cards.nth(0).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const preview = dialog.frameLocator("iframe").frameLocator("#preview");
    await expect(preview.getByRole("heading", { name: "Report B" })).toBeVisible({
      timeout: 20_000,
    });
    await captureScreenshot(page, testInfo, "agentscope-AC05-latest-detail");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    task.assertComplete();
  } finally {
    await task?.close();
    await intro.close();
  }
});
