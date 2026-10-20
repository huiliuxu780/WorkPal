import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

interface FactDto {
  id: string;
  text: string;
  state: string;
  origin: string;
  revision: number;
  scopeKind: string;
  evidenceCount: number;
  indexCleanupPending: boolean;
}

/**
 * ME-01/ME-02 acceptance M-A01: remember through conversation → the fact is
 * usable after the thread is cleared (new generation of the same thread) →
 * sources are visible → correction keeps one identity with a revision trail →
 * delete removes it from display and every read path. Injection consistency
 * itself is pinned by the memory-injection unit suite and the durable-memory
 * goldens; this spec proves the product journey end to end against real PG.
 */
test("remember, recall after clear, correct and delete a first-party memory fact", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `memory-facts-${stamp}@rakazo.test`, "password12", `Facts ${stamp}`);
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = await activeBotId(page);

  // 1. Remember through a normal conversation turn. The scripted runtime
  //    exercises the production tool path: trusted human_web turn → a single
  //    explicit memory activates once as user_direct.
  await rpc(page, "threads/send", {
    botId,
    text: `remember that the release train departs on sundays ${stamp}`,
  });
  let factId = "";
  await expect(async () => {
    const result = await rpc<{ facts: FactDto[] }>(page, "memory/facts/list", { botId });
    const fact = result.facts.find((entry) => entry.text.includes(String(stamp)));
    expect(fact, "fact created from the trusted turn").toBeDefined();
    expect(fact!.state).toBe("active");
    expect(fact!.origin).toBe("user_direct");
    expect(fact!.evidenceCount).toBeGreaterThan(0);
    factId = fact!.id;
  }).toPass({ timeout: 30_000 });

  // 2. Clearing the thread keeps the confirmed memory (new generation, same
  //    thread = a fresh conversation still backed by the fact).
  await rpc(page, "threads/clear", { botId });
  const afterClear = await rpc<{ facts: FactDto[] }>(page, "memory/facts/list", { botId });
  expect(afterClear.facts.some((fact) => fact.id === factId)).toBe(true);
  await rpc(page, "threads/send", { botId, text: "what is the release schedule?" });
  await expect(async () => {
    const result = await rpc<{ facts: FactDto[] }>(page, "memory/facts/list", { botId });
    expect(result.facts.some((fact) => fact.id === factId && fact.state === "active")).toBe(true);
  }).toPass({ timeout: 30_000 });

  // 3. The Knowledge panel shows it under Remembered with sources.
  await page.locator("main").getByRole("button", { name: /^Chief/ }).click();
  const settings = page.getByTestId("bot-settings");
  await settings.getByText("Advanced", { exact: true }).click();
  const knowledge = settings.getByTestId("bot-knowledge");
  const factsSection = knowledge.getByTestId("bot-knowledge-facts");
  await expect(factsSection.getByTestId("bot-knowledge-facts-remembered")).toBeVisible();
  const factRow = factsSection
    .getByTestId("bot-knowledge-facts-fact")
    .filter({ hasText: String(stamp) })
    .first();
  await expect(factRow).toBeVisible();
  await factRow.getByRole("button").first().click();
  const editor = factsSection.getByTestId("bot-knowledge-facts-fact-editor").first();
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Sources", exact: true }).click();
  const evidence = editor.getByTestId("bot-knowledge-facts-evidence");
  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText("explicit_instruction");
  await captureScreenshot(page, testInfo, "90-memory-fact-sources");

  // 4. Correct it in place: one identity, revision trail, display updates.
  const correctedText = `the release train departs on mondays ${stamp}`;
  await editor.getByLabel("Memory text").fill(correctedText);
  await editor.getByRole("button", { name: "Save correction", exact: true }).click();
  await expect(factsSection.getByText("Correction saved")).toBeVisible();
  await expect(async () => {
    const detail = await rpc<{ fact: FactDto }>(page, "memory/facts/get", { factId, botId });
    expect(detail.fact.text).toBe(correctedText);
    expect(detail.fact.revision).toBe(2);
  }).toPass({ timeout: 15_000 });

  // 5. Delete with the two-step confirm: gone from display and every read path.
  const deletedRow = factsSection
    .getByTestId("bot-knowledge-facts-fact")
    .filter({ hasText: String(stamp) })
    .first();
  const deleteEditor = factsSection.getByTestId("bot-knowledge-facts-fact-editor").first();
  if (!(await deleteEditor.isVisible())) {
    await deletedRow.getByRole("button").first().click();
  }
  await deleteEditor.getByRole("button", { name: "Delete", exact: true }).click();
  await deleteEditor.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(async () => {
    const result = await rpc<{ facts: FactDto[] }>(page, "memory/facts/list", {
      botId,
      states: ["active", "candidate", "superseded"],
      includeExpired: true,
    });
    expect(result.facts.some((fact) => fact.id === factId)).toBe(false);
  }).toPass({ timeout: 15_000 });
  const response = await page.request.post("/rpc/memory/facts/get", {
    data: { json: { factId, botId } },
    headers: { "x-rakazo-space-id": await spaceIdOf(page) },
  });
  expect(response.status()).not.toBe(200);

  // 6. The user-facing add form activates in one step and shows the receipt
  //    only after the transaction succeeded.
  await factsSection.getByLabel("Add a memory").fill(`standup notes live in docs/standup ${stamp}`);
  await factsSection.getByRole("button", { name: "Remember", exact: true }).click();
  await expect(factsSection.getByRole("status")).toHaveText("Remembered");
  await expect(async () => {
    const result = await rpc<{ facts: FactDto[] }>(page, "memory/facts/list", { botId });
    const created = result.facts.find((fact) => fact.text.includes("docs/standup"));
    expect(created?.state).toBe("active");
    expect(created?.origin).toBe("user_direct");
  }).toPass({ timeout: 15_000 });
  await captureScreenshot(page, testInfo, "91-memory-facts-remembered");
});

async function spaceIdOf(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => window.localStorage.getItem("rakazo:space-id") ?? "");
}
