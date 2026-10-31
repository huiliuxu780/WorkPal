import { expect, test } from "@playwright/test";
import { createDb } from "../../../packages/db/src/index.js";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test.skip(process.env.AGENT_RUNTIME === "agentscope", "Scripted pagination fixture only");

const pageHtml = (marker: string) =>
  `<!doctype html><html><body><main><h1>Report ${marker}</h1><p>marker-${marker}</p></main></body></html>`;

async function sendPage(page: import("@playwright/test").Page, marker: string) {
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(
    `write path report.html and attach it to the thread says ${pageHtml(marker)}`,
  );
  await page.keyboard.press("Enter");
}

test("old page restores stale state and opens the latest page", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signup(page, `chat-chrome-page-${Date.now()}@rakazo.test`, "password12", "Pagination");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const cards = page.getByTestId("artifact-page-card");
  await sendPage(page, "A");
  await expect(cards).toHaveCount(1, { timeout: 30_000 });
  await sendPage(page, "B");
  await expect(cards).toHaveCount(2, { timeout: 30_000 });
  await expect(cards.nth(0)).toHaveAttribute("data-stale", "true");

  const snapshot = await rpc<{ threadId: string; messages: Array<{ seq: number }> }>(
    page,
    "threads/get",
    { botId },
  );
  const maxSeq = Math.max(...snapshot.messages.map((message) => message.seq));
  const db = createDb(process.env.DATABASE_URL!);
  try {
    await db.prisma.message.createMany({
      data: Array.from({ length: 110 }, (_, index) => ({
        threadId: snapshot.threadId,
        seq: maxSeq + index + 1,
        role: "user",
        blocks: [{ kind: "text", text: `pagination filler ${index}` }],
      })),
    });
    await db.prisma.thread.update({
      where: { id: snapshot.threadId },
      data: { nextMessageSeq: maxSeq + 111 },
    });
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }

  await page.reload();
  await expect(page.getByTestId("chat-column")).toContainText("pagination filler 109", {
    timeout: 30_000,
  });
  await expect(cards).toHaveCount(0);
  const loadEarlier = page.getByRole("button", { name: "Load earlier messages" });
  await expect(loadEarlier).toBeVisible({ timeout: 60_000 });
  // One click loads the remaining page; re-clicking races the button, whose
  // label becomes "Loading…" and then unmounts once the history is exhausted.
  await loadEarlier.click();
  await expect(cards).toHaveCount(2, { timeout: 60_000 });
  await expect(cards.nth(0)).toHaveAttribute("data-stale", "true");
  await captureScreenshot(page, testInfo, "pagination-AC08-old-page");
  await cards.nth(0).click();
  const dialog = page.getByRole("dialog");
  const preview = dialog.frameLocator("iframe").frameLocator("#preview");
  await expect(preview.getByRole("heading", { name: "Report B" })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
