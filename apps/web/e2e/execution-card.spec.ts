import { expect, type Page, test } from "@playwright/test";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

type Summary = {
  runId: string;
  title: string;
  status: string;
  rev: number;
  outcome?: string;
  failure?: string;
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

async function executionsOf(page: Page, botId: string): Promise<Summary[]> {
  const snapshot = await rpc<{ executions?: Summary[] }>(page, "threads/get", { botId });
  return snapshot.executions ?? [];
}

async function send(page: Page, text: string) {
  const composer = page.getByPlaceholder(/Message/);
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill(text);
  await page.keyboard.press("Enter");
}

async function settledSummary(page: Page, botId: string, titlePart: string): Promise<Summary> {
  let found: Summary | undefined;
  await expect
    .poll(
      async () => {
        found = (await executionsOf(page, botId)).find((item) => item.title.includes(titlePart));
        return found && TERMINAL.has(found.status) ? 1 : 0;
      },
      { timeout: 90_000, intervals: [250, 500, 1_000] },
    )
    .toBe(1);
  return found!;
}

/**
 * Poll one Run by id until terminal. Free-text answers rewrite the Task
 * prompt, so the title is not a stable handle after an answer.
 */
async function settledSummaryById(page: Page, botId: string, runId: string): Promise<Summary> {
  let found: Summary | undefined;
  await expect
    .poll(
      async () => {
        found = (await executionsOf(page, botId)).find((item) => item.runId === runId);
        return found && TERMINAL.has(found.status) ? 1 : 0;
      },
      { timeout: 90_000, intervals: [250, 500, 1_000] },
    )
    .toBe(1);
  return found!;
}

async function summaryByTitle(page: Page, botId: string, titlePart: string): Promise<Summary> {
  let found: Summary | undefined;
  await expect
    .poll(
      async () => {
        found = (await executionsOf(page, botId)).find((item) => item.title.includes(titlePart));
        return found ? 1 : 0;
      },
      { timeout: 90_000, intervals: [250, 500, 1_000] },
    )
    .toBe(1);
  return found!;
}

async function waitingRun(page: Page, botId: string) {
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

function shellOf(page: Page, runId: string) {
  return page.locator(`section[data-testid="execution-shell"][data-run-id="${runId}"]`);
}

function cardOf(page: Page, runId: string) {
  return shellOf(page, runId).locator('article[data-testid="execution-card"]');
}

async function expandCard(page: Page, runId: string) {
  const button = cardOf(page, runId).locator("button[aria-expanded]").first();
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true", { timeout: 15_000 });
}

/** Every visible Run renders exactly one Execution Card. */
async function expectOneCardPerShell(page: Page) {
  const shells = await page.locator('section[data-testid="execution-shell"]').count();
  const cards = await page.locator('article[data-testid="execution-card"]').count();
  expect(cards).toBe(shells);
}

test("a completed Run restores its card, title and result across a refresh", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `card-done-${stamp}@rakazo.test`, "password12", "Card Done");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, `write a file named card-${stamp}.txt saying card quarter numbers`);
  const summary = await settledSummary(page, botId, "write a file named");
  expect(summary.outcome).toContain("writing that into my home");

  const card = cardOf(page, summary.runId);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveAttribute("data-status", "done");
  await expect(card).toContainText("write a file named");
  await expect(card).toContainText("writing that into my home");
  await expect(card.getByRole("button", { name: "View result", exact: true })).toBeVisible();
  await expectOneCardPerShell(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  const restoredCard = cardOf(page, summary.runId);
  await expect(restoredCard).toBeVisible({ timeout: 15_000 });
  await expect(restoredCard).toHaveAttribute("data-status", "done");
  await expect(restoredCard).toContainText("writing that into my home");

  const firstDetail = page.waitForResponse((response) =>
    response.url().includes("/rpc/runs/executionSnapshot"),
  );
  await expandCard(page, summary.runId);
  await firstDetail;
  // Expanded: the verb becomes Collapse and the card keeps a single status head.
  await expect(
    restoredCard.getByRole("button", { name: "Collapse", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  const statusCount = await restoredCard.locator(".exc-status").count();
  expect(statusCount).toBe(1);
});

test("pending approval stays discoverable, focuses and submits without a duplicate AskCard", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `card-approval-${stamp}@rakazo.test`, "password12", "Card Approval");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "approvalRules/set", {
    effect: "require_approval",
    matchKind: "connector",
    matchValue: "destination.write",
  });

  await send(page, "write this to the destination crm as a note");
  await waitingRun(page, botId);
  // threads/get can observe waiting_input before the realtime feed paints the card.
  if ((await page.getByTestId("intervention-region").count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  const region = page.getByRole("region", { name: "需要你处理" });
  await expect(region.getByRole("button", { name: "Deny", exact: true })).toBeVisible({
    timeout: 15_000,
  });

  const shell = page.locator('section[data-testid="execution-shell"]').first();
  const card = shell.locator('article[data-testid="execution-card"]');
  await expect(card).toHaveAttribute("data-status", "approval");
  const attention = card.getByRole("button", { name: "Needs your attention", exact: true });
  await expect(attention).toBeVisible();
  // A waiting Run is always expanded; the pending card is never hidden inside.
  await expect(attention).toHaveAttribute("aria-expanded", "true");
  await expect(shell.locator(".exc-details")).not.toHaveAttribute("hidden", "");

  // The attention action focuses the first authoritative Intervention control.
  await attention.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement?.closest('[data-testid="intervention-region"]') !== null,
      ),
    )
    .toBe(true);

  // One authoritative AskCard only — the message bubble renders no second one.
  await expect(page.locator("[data-intervention-id]")).toHaveCount(1);

  await region.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(
    region.locator("[data-intervention-id]").first().getByText("Denied", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(async () => {
      const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
        botId,
      });
      return snapshot.run?.status ?? null;
    }, { timeout: 60_000 })
    .toBeNull();
  await expectOneCardPerShell(page);
});

test("a pending input ask submits from the card region without a duplicate bubble card", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `card-input-${stamp}@rakazo.test`, "password12", "Card Input");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, "run 3 shell steps then ask");
  await waitingRun(page, botId);
  const pending = await summaryByTitle(page, botId, "run 3 shell steps then ask");
  if ((await page.getByTestId("intervention-region").count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  const region = page.getByRole("region", { name: "需要你处理" });
  await expect(region.getByText("Which city should I use?", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  const shell = page.locator('section[data-testid="execution-shell"]').first();
  const card = shell.locator('article[data-testid="execution-card"]');
  await expect(card).toHaveAttribute("data-status", "need_input");
  // The card line carries the sanitized question; the region carries the only
  // interactive card (no second AskCard in the message bubble).
  await expect(card.locator(".exc-line")).toContainText("Which city should I use?");
  await expect(page.locator("[data-intervention-id]")).toHaveCount(1);

  const answer = `CardAnswer-${stamp}`;
  await region.getByRole("button", { name: "Edit first", exact: true }).click();
  await region.getByRole("textbox", { name: "Answer" }).fill(answer);
  await region.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(region.getByText(`Answered: ${answer}`, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const settled = await settledSummaryById(page, botId, pending.runId);
  expect(settled.runId).toBe(pending.runId);

  // Card-layer storage contract: the expansion record keeps its four
  // whitelisted fields only, and the answer never reaches localStorage.
  // (Secret answers are never written to any storage — covered by
  // secret-card.spec.ts; a residual TEXT draft in sessionStorage after submit
  // is a pre-existing AskCard behavior, reported separately.)
  const localStorageDump = await page.evaluate(() => JSON.stringify({ ...window.localStorage }));
  expect(localStorageDump).not.toContain(answer);
  const expansions = await page.evaluate(() =>
    window.sessionStorage.getItem("rk:execution-expansion"),
  );
  if (expansions) {
    for (const entry of Object.values(JSON.parse(expansions) as Record<string, object>)) {
      expect(Object.keys(entry).sort()).toEqual(["open", "rev", "runId", "threadId"]);
    }
  }
});

test("a failed Run shows the safe failure summary and offers no retry", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `card-failed-${stamp}@rakazo.test`, "password12", "Card Failed");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, `fail this run ${stamp}`);
  const summary = await settledSummary(page, botId, "fail this run");
  expect(summary.status).toBe("failed");

  // The terminal event triggers a thread refresh; reload once if the feed raced.
  if ((await cardOf(page, summary.runId).count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  const card = cardOf(page, summary.runId);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveAttribute("data-status", "failed");
  // The safe failure projection only — no stack frames, no exception prefix.
  await expect(card.locator('.exc-line[data-kind="failure"]')).toContainText(
    "Scripted run failure",
  );
  const cardText = await card.innerText();
  expect(cardText).not.toContain("Error:");
  expect(cardText).not.toMatch(/\n\s+at\s/);
  // No retry affordance anywhere on the card.
  await expect(card.getByRole("button", { name: /retry/i })).toHaveCount(0);
  await expect(card.getByRole("button", { name: /重试/ })).toHaveCount(0);
  // A failed Run starts expanded (waiting detail stays visible), so the verb
  // is Collapse; collapsing flips it to the failed-state entry verb.
  const toggle = card.locator("button[aria-expanded]").first();
  await expect(toggle).toHaveText("Collapse");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveText("View execution");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("multiple Runs in one Thread keep exactly one detail expanded", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `card-multi-${stamp}@rakazo.test`, "password12", "Card Multi");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, "run 2 shell steps");
  const first = await settledSummary(page, botId, "run 2 shell steps");
  await send(page, "run 3 shell steps");
  const second = await settledSummary(page, botId, "run 3 shell steps");
  expect(first.runId).not.toBe(second.runId);

  await expandCard(page, first.runId);
  await expect(shellOf(page, first.runId).locator(".exc-details")).not.toHaveAttribute(
    "hidden",
    "",
  );
  await expect(shellOf(page, second.runId).locator(".exc-details")).toHaveAttribute("hidden", "");

  await expandCard(page, second.runId);
  await expect(shellOf(page, second.runId).locator(".exc-details")).not.toHaveAttribute(
    "hidden",
    "",
    { timeout: 15_000 },
  );
  await expect(shellOf(page, first.runId).locator(".exc-details")).toHaveAttribute("hidden", "");
  await expectOneCardPerShell(page);
});

test("a paged-out historical Run expands from its card after loading earlier messages", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `card-history-${stamp}@rakazo.test`, "password12", "Card History");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, "ask me which city to use");
  await waitingRun(page, botId);
  const pending = await summaryByTitle(page, botId, "ask me which city");
  const region = page.getByRole("region", { name: "需要你处理" });
  await expect(region.getByRole("button", { name: "Edit first", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await region.getByRole("button", { name: "Edit first", exact: true }).click();
  await region.getByRole("textbox", { name: "Answer" }).fill("Paris");
  await region.getByRole("button", { name: "Send answer", exact: true }).click();
  // The answer rewrites the Task prompt, so track the Run by id from here.
  const summary = await settledSummaryById(page, botId, pending.runId);

  // Push the Run's anchor message off the first page.
  const history = await rpc<{ messages: Array<{ id: string }> }>(page, "threads/messages", {
    botId,
  });
  const parent = history.messages[0]?.id;
  if (!parent) throw new Error("no message to react to");
  for (let index = 0; index < 105; index++) {
    await rpc(page, "threads/react", {
      botId,
      messageId: parent,
      reaction: "👍",
      clientNonce: `card-filler-${stamp}-${index}`,
    });
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });

  // Page back until the shell returns, then expand from the card.
  await expect
    .poll(
      async () => {
        if ((await shellOf(page, summary.runId).count()) > 0) return 1;
        const more = page.getByRole("button", { name: "Load earlier messages" });
        if ((await more.count()) === 0 || !(await more.isEnabled())) return 0;
        await more.click();
        await expect(more).toBeEnabled({ timeout: 15_000 }).catch(() => undefined);
        return (await shellOf(page, summary.runId).count()) > 0 ? 1 : 0;
      },
      { timeout: 60_000, intervals: [300, 700] },
    )
    .toBe(1);
  const detailRequest = page.waitForResponse((response) =>
    response.url().includes("/rpc/runs/executionSnapshot"),
  );
  await expandCard(page, summary.runId);
  await detailRequest;
  await expect(shellOf(page, summary.runId).locator(".exc-details")).not.toHaveAttribute(
    "hidden",
    "",
  );
  // The answered echo needs the ask message itself; page until it appears.
  const answeredText = shellOf(page, summary.runId)
    .getByText("Answered: Paris", { exact: true })
    .first();
  for (let guard = 0; guard < 12 && (await answeredText.count()) === 0; guard++) {
    const more = page.getByRole("button", { name: "Load earlier messages" });
    if ((await more.count()) === 0 || !(await more.isEnabled().catch(() => false))) break;
    await more.click();
    await page.waitForTimeout(300);
  }
  await expect(answeredText).toBeVisible({ timeout: 15_000 });
  // A late stale detail response cannot overwrite the newer snapshot (rev
  // guard) — covered end-to-end by execution-history.spec.ts; here the card
  // simply stays consistent after the paging dance.
  await expect(cardOf(page, summary.runId)).toHaveAttribute("data-status", "done");
});

test("a cleared Run's card never revives through artifact maintenance", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `card-clear-${stamp}@rakazo.test`, "password12", "Card Clear");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, `attach to the thread with path notes/card-${stamp}.txt says card marker`);
  const summary = await settledSummary(page, botId, "attach to the thread");
  let artifactId: string | undefined;
  await expect
    .poll(
      async () => {
        artifactId = (
          await rpc<{ executions?: Array<{ runId: string; artifacts?: Array<{ id: string }> }> }>(
            page,
            "threads/get",
            { botId },
          )
        ).executions?.find((item) => item.runId === summary.runId)?.artifacts?.[0]?.id;
        return artifactId ? 1 : 0;
      },
      { timeout: 30_000 },
    )
    .toBe(1);
  await expect(cardOf(page, summary.runId)).toBeVisible({ timeout: 15_000 });

  await rpc(page, "threads/clear", { botId });
  await expect
    .poll(
      async () =>
        (await executionsOf(page, botId)).some((item) => item.runId === summary.runId) ? 1 : 0,
      { timeout: 30_000 },
    )
    .toBe(0);

  // Deleting the stale Run's artifact lands a fresh thread.artifact event
  // naming a pre-clear Run; it must not revive the card.
  await rpc(page, "artifacts/remove", { artifactId });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1_000);
  await expect(shellOf(page, summary.runId)).toHaveCount(0);
  expect((await executionsOf(page, botId)).some((item) => item.runId === summary.runId)).toBe(
    false,
  );
});

test("cards never render invented percentages or processed/total counters", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `card-nopct-${stamp}@rakazo.test`, "password12", "Card NoPct");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, "run 5 shell steps");
  const summary = await settledSummary(page, botId, "run 5 shell steps");
  const card = cardOf(page, summary.runId);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expandCard(page, summary.runId);
  await page.waitForTimeout(500);

  const texts = await page
    .locator('article[data-testid="execution-card"]')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) {
    expect(text).not.toMatch(/%|percent/i);
    expect(text).not.toMatch(/processed|处理/i);
    expect(text).not.toContain("0 steps");
    expect(text).not.toContain("--");
  }
});

test("a long title wraps without horizontal overflow at 390px", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `card-narrow-${stamp}@rakazo.test`, "password12", "Card Narrow");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  const longPrompt = `summarize the ticket history ${"ticket-analysis-chunk ".repeat(30)}${stamp}`;
  await send(page, longPrompt);
  const summary = await settledSummary(page, botId, "summarize the ticket history");

  await page.setViewportSize({ width: 390, height: 844 });
  const card = cardOf(page, summary.runId);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expandCard(page, summary.runId);
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
  const cardBox = await card.evaluate((node) => ({
    scroll: node.scrollWidth,
    client: node.clientWidth,
  }));
  expect(cardBox.scroll).toBeLessThanOrEqual(cardBox.client + 1);
});

test("reduced motion disables the working glyph animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stamp = Date.now();
  await signup(page, `card-motion-${stamp}@rakazo.test`, "password12", "Card Motion");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, "keep working until i stop");
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
    .toBe("running");
  const shell = page.locator('section[data-testid="execution-shell"]').first();
  if ((await shell.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(shell).toBeVisible({ timeout: 15_000 });
  const glyph = shell.locator(".exc-glyph");
  await expect(glyph).toBeVisible();
  const animation = await glyph.evaluate((node) => getComputedStyle(node).animationName);
  expect(animation).toBe("none");
  const statusText = await shell.locator(".exc-status").innerText();
  expect(statusText).toBe("Executing");
});
