import { expect, type Page, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

type Summary = {
  runId: string;
  threadId: string;
  title: string;
  status: string;
  rev: number;
  waitKind?: string | null;
  anchorMessageId?: string;
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
 * Wait until the Run EXISTS server-side (any status). The composer send is
 * fire-and-forget; navigating away immediately would abort the in-flight
 * threads/send and the Run would never be created.
 */
async function appearedSummary(page: Page, botId: string, titlePart: string): Promise<Summary> {
  let found: Summary | undefined;
  await expect
    .poll(
      async () => {
        found = (await executionsOf(page, botId)).find((item) => item.title.includes(titlePart));
        return found ? 1 : 0;
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe(1);
  return found!;
}

async function waitingRun(page: Page, botId: string, waitKind?: string) {
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string; waitKind?: string | null } | null }>(
          page,
          "threads/get",
          { botId },
        );
        const run = snapshot.run;
        if (run?.status !== "waiting_input") return run?.status ?? "none";
        if (waitKind && run.waitKind !== waitKind) return `waiting:${run.waitKind ?? "null"}`;
        return "waiting_input";
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");
}

async function stopQuietly(page: Page, botId: string) {
  await rpc(page, "threads/stop", { botId }).catch(() => undefined);
}

/** One Task Center list item, located by its safe server title (no Run ids in the DOM). */
function tcItem(page: Page, titlePart: string) {
  return page.locator('[data-testid="task-center-item"]').filter({ hasText: titlePart });
}

function cardOfItem(item: ReturnType<typeof tcItem>) {
  return item.locator('article[data-testid="execution-card"]');
}

async function gotoTaskCenter(page: Page) {
  await page.goto("/app/tasks");
  await expect(page.getByTestId("task-center")).toBeVisible({ timeout: 20_000 });
}

/** The Task Center refreshes on window focus; tests simulate the user returning. */
async function refreshTaskCenter(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

test("two conversations' running Runs are listed together and survive a refresh", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `tc-two-${stamp}@rakazo.test`, "password12", "TC Two");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const runnerId = await createNamedBot(page, `TC Runner ${stamp}`);

  try {
    await send(page, `keep working until i stop you ${stamp} b`);
    await appearedSummary(page, runnerId, `${stamp} b`);
    await page.goto(`/app/${chiefId}`);
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 20_000 });
    await send(page, `keep working until i stop you ${stamp} a`);
    await appearedSummary(page, chiefId, `${stamp} a`);

    // The sidebar entry navigates and marks itself current.
    const entry = page.getByTestId("task-center-entry");
    await expect(entry).toBeVisible({ timeout: 20_000 });
    await entry.click();
    await page.waitForURL(/\/app\/tasks/, { timeout: 15_000 });
    await expect(entry).toHaveAttribute("aria-current", "page");

    await expect(tcItem(page, `${stamp} a`).first()).toBeVisible({ timeout: 30_000 });
    await expect(tcItem(page, `${stamp} b`).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("task-center-subtitle")).toHaveText("2 running in background", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("task-center-count")).toHaveText("2", { timeout: 20_000 });

    // A refresh restores the list and the authoritative count.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("task-center")).toBeVisible({ timeout: 20_000 });
    await expect(tcItem(page, `${stamp} a`).first()).toBeVisible({ timeout: 30_000 });
    await expect(tcItem(page, `${stamp} b`).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("task-center-count")).toHaveText("2", { timeout: 20_000 });
    await expect(page.getByTestId("task-center-subtitle")).toHaveText("2 running in background");
  } finally {
    await stopQuietly(page, chiefId);
    await stopQuietly(page, runnerId);
  }
});

test("waiting approval outranks running, and 去处理 focuses the approval control", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `tc-wait-${stamp}@rakazo.test`, "password12", "TC Wait");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const runnerId = await createNamedBot(page, `TC Busy ${stamp}`);

  try {
    // Chief: a real approval wait through the existing effect-approval path.
    await page.goto(`/app/${chiefId}`);
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 20_000 });
    await rpc(page, "approvalRules/set", {
      effect: "require_approval",
      matchKind: "connector",
      matchValue: "destination.write",
    });
    await send(page, `write this to the destination crm as a note ${stamp}`);
    await waitingRun(page, chiefId, "approval");

    // Runner: a plain running Run that is NEWER than the waiting one.
    await page.goto(`/app/${runnerId}`);
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 20_000 });
    await send(page, `keep working until i stop you ${stamp}`);
    await appearedSummary(page, runnerId, `keep working until i stop you ${stamp}`);

    await gotoTaskCenter(page);
    await expect(tcItem(page, `keep working until i stop you ${stamp}`).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(tcItem(page, `destination crm`).first()).toBeVisible({ timeout: 30_000 });

    // Waiting sorts first regardless of recency.
    const items = page.locator('[data-testid="task-center-item"]');
    await expect
      .poll(async () => (await items.first().innerText()).includes("destination crm"), {
        timeout: 20_000,
      })
      .toBe(true);
    await expect(cardOfItem(items.first())).toHaveAttribute("data-status", "approval");
    // The Task Center surface presents the running root Run with the existing
    // background presentation (trusted cross-conversation background entry).
    await expect(items.nth(1).locator('article[data-testid="execution-card"]')).toHaveAttribute(
      "data-status",
      "background",
    );
    await expect(items.nth(1).locator('article[data-testid="execution-card"]')).toHaveAttribute(
      "data-background",
      "1",
    );

    // 去处理 → the right conversation, expanded card, focus on the Intervention control.
    await items.first().getByRole("button", { name: "Handle now" }).click();
    await page.waitForURL(new RegExp(`/app/${chiefId}`), { timeout: 15_000 });
    const shell = page
      .locator('section[data-testid="execution-shell"]')
      .filter({ hasText: "destination crm" });
    await expect(shell.locator('article[data-testid="execution-card"]')).toHaveAttribute(
      "data-open",
      "1",
      { timeout: 20_000 },
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.activeElement?.closest('[data-testid="intervention-region"]') !== null,
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
  } finally {
    await stopQuietly(page, chiefId);
    await stopQuietly(page, runnerId);
  }
});

test("running → completed keeps exactly one freshest card", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `tc-one-${stamp}@rakazo.test`, "password12", "TC One");
  await completeOnboarding(page);
  const title = "run 150 shell steps";

  await send(page, title);
  // The Run must exist server-side before the navigation, or the aborted
  // send would leave the list honestly empty.
  await appearedSummary(page, activeBotId(page), title);
  await gotoTaskCenter(page);

  // Every observation keeps the single-card invariant; the terminal state wins.
  await expect
    .poll(
      async () => {
        await refreshTaskCenter(page);
        const items = tcItem(page, title);
        const count = await items.count();
        if (count !== 1) return `count:${count}`;
        return cardOfItem(items).getAttribute("data-status");
      },
      { timeout: 90_000, intervals: [300, 700, 1_200] },
    )
    .toBe("done");

  await expect(tcItem(page, title)).toHaveCount(1);
  await expect(page.getByTestId("task-center-subtitle")).toHaveText(
    "No tasks running in background",
  );
  await expect(page.getByTestId("task-center-count")).toHaveCount(0);
});

test("查看结果 returns to the right conversation, expands the card and keeps one result surface", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `tc-done-${stamp}@rakazo.test`, "password12", "TC Done");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, `summarize the quarter ${stamp}`);
  await settledSummary(page, botId, `summarize the quarter ${stamp}`);

  await gotoTaskCenter(page);
  const item = tcItem(page, `summarize the quarter ${stamp}`);
  await expect(item).toBeVisible({ timeout: 30_000 });
  await item.getByRole("button", { name: "View result" }).click();

  await page.waitForURL(new RegExp(`/app/${botId}`), { timeout: 15_000 });
  const shell = page
    .locator('section[data-testid="execution-shell"]')
    .filter({ hasText: `summarize the quarter ${stamp}` });
  await expect(shell.locator('article[data-testid="execution-card"]')).toHaveAttribute(
    "data-open",
    "1",
    { timeout: 20_000 },
  );
  // The result bubble is the canonical surface: exactly one result sentence.
  await expect(page.getByTestId("transcript").getByText("done. i handled:")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("execution-result")).toHaveCount(0);
  // A completed Run lands focus on the card's status line.
  await expect
    .poll(
      () => page.evaluate(() => Boolean(document.activeElement?.classList.contains("exc-status"))),
      { timeout: 15_000 },
    )
    .toBe(true);
});

test("an anchor pushed beyond 100 messages is still located and expanded", async ({ page }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  await signup(page, `tc-anchor-${stamp}@rakazo.test`, "password12", "TC Anchor");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const title = `tc-anchor-${stamp}`;

  await send(page, title);
  const summary = await settledSummary(page, botId, title);
  expect(summary.anchorMessageId).toBeTruthy();
  const anchorMessageId = summary.anchorMessageId!;

  // A hang Run absorbs every further send as steering: 100+ real messages
  // without creating 100+ Runs (which would push the anchor out of the
  // bounded terminal window instead of off the first message page).
  await send(page, `keep working until i stop you ${stamp}`);
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? "none";
      },
      { timeout: 60_000 },
    )
    .toBe("running");

  let flooding = true;
  let sent = 0;
  const flood = Promise.all(
    Array.from({ length: 3 }, async (_unused, lane) => {
      let index = 0;
      while (flooding) {
        try {
          await rpc(page, "threads/send", {
            botId,
            text: `tc-flood-${stamp}-${lane}-${index++}`,
            clientNonce: `tcf-${stamp}-${lane}-${index}`,
          });
          sent += 1;
        } catch {
          // A rejected send adds no messages; keep flooding.
        }
      }
    }),
  );
  try {
    await expect
      .poll(
        async () => {
          const history = await rpc<{ messages: Array<{ id: string }> }>(page, "threads/messages", {
            botId,
          });
          return history.messages.some((message) => message.id === anchorMessageId)
            ? "on-page"
            : "pushed";
        },
        { timeout: 120_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe("pushed");
  } finally {
    flooding = false;
    await flood;
    await stopQuietly(page, botId);
  }
  expect(sent).toBeGreaterThan(100);

  await gotoTaskCenter(page);
  const item = tcItem(page, title);
  await expect(item).toBeVisible({ timeout: 30_000 });

  const aroundJump = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/threads/messages") &&
      (response.request().postData() ?? "").includes('"around"'),
    { timeout: 20_000 },
  );
  await item.getByRole("button", { name: "View result" }).click();
  const around = await aroundJump;
  expect(around.ok()).toBe(true);

  const shell = page.locator('section[data-testid="execution-shell"]').filter({ hasText: title });
  await expect(shell.locator('article[data-testid="execution-card"]')).toHaveAttribute(
    "data-open",
    "1",
    { timeout: 30_000 },
  );
  await expect(shell).toBeInViewport({ timeout: 20_000 });
});

test("Thread Clear removes the stale card and the count", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `tc-clear-${stamp}@rakazo.test`, "password12", "TC Clear");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  try {
    await send(page, `keep working until i stop you ${stamp}`);
    await appearedSummary(page, botId, `keep working until i stop you ${stamp}`);
    await gotoTaskCenter(page);
    await expect(tcItem(page, `keep working until i stop you ${stamp}`).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("task-center-count")).toHaveText("1", { timeout: 20_000 });

    await rpc(page, "threads/clear", { botId });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("task-center")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("task-center-empty")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("task-center-count")).toHaveCount(0);
    await expect(page.getByTestId("task-center-subtitle")).toHaveText(
      "No tasks running in background",
    );
    // The cleared Run never comes back on a second look.
    await refreshTaskCenter(page);
    await expect(page.getByTestId("task-center-empty")).toBeVisible();
  } finally {
    await stopQuietly(page, botId);
  }
});

test("a fresh space with no surviving Runs shows the honest empty state", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `tc-empty-${stamp}@rakazo.test`, "password12", "TC Empty");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  // Onboarding's created-intro Run is a real terminal Run; clearing the
  // thread fences it out, leaving the honest empty state.
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run && !TERMINAL.has(snapshot.run.status) ? snapshot.run.status : "idle";
      },
      { timeout: 60_000 },
    )
    .toBe("idle");
  await rpc(page, "threads/clear", { botId });

  await gotoTaskCenter(page);
  await expect(page.getByTestId("task-center-empty")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("task-center-empty")).toContainText(
    "Nothing is running in the background",
  );
  await expect(page.getByTestId("task-center-subtitle")).toHaveText(
    "No tasks running in background",
  );
  await expect(page.getByTestId("task-center-count")).toHaveCount(0);
  await expect(page.locator('[data-testid="task-center-item"]')).toHaveCount(0);
});

test("a Run cleared after the list loaded shows stable feedback and never navigates", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `tc-gone-${stamp}@rakazo.test`, "password12", "TC Gone");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, `summarize the tickets ${stamp}`);
  const summary = await settledSummary(page, botId, `summarize the tickets ${stamp}`);

  await gotoTaskCenter(page);
  const item = tcItem(page, `summarize the tickets ${stamp}`);
  await expect(item).toBeVisible({ timeout: 30_000 });

  // The Run becomes unreachable while the (unrefreshed) list still shows it.
  await rpc(page, "threads/clear", { botId });
  await item.getByRole("button", { name: "View result" }).click();

  await expect(item.getByText("This task is no longer available.")).toBeVisible({
    timeout: 20_000,
  });
  expect(page.url()).toContain("/app/tasks");
  const body = await page.locator("#root").innerText();
  expect(body).not.toContain(summary.runId);
  expect(body).not.toContain("NOT_FOUND");

  // The stable feedback survives until the next natural refresh; the
  // authoritative window then drops the cleared Run for good.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("task-center")).toBeVisible({ timeout: 20_000 });
  await expect(tcItem(page, `summarize the tickets ${stamp}`)).toHaveCount(0, { timeout: 30_000 });
});

test("DOM and browser storage carry no secrets, tokens or raw Run ids", async ({ page }) => {
  const stamp = Date.now();
  const password = "password12";
  await signup(page, `tc-secrets-${stamp}@rakazo.test`, password, "TC Secrets");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, `summarize the vault ${stamp}`);
  const summary = await settledSummary(page, botId, `summarize the vault ${stamp}`);

  await gotoTaskCenter(page);
  await expect(tcItem(page, `summarize the vault ${stamp}`).first()).toBeVisible({
    timeout: 30_000,
  });

  const html = await page.locator("#root").innerHTML();
  expect(html).not.toContain("data-run-id");
  expect(html).not.toContain(summary.runId);
  expect(html).not.toContain(summary.threadId);
  expect(html).not.toContain(botId);
  expect(html).not.toContain(password);

  const storage = await page.evaluate(() =>
    JSON.stringify({ ...window.localStorage, ...window.sessionStorage }),
  );
  expect(storage).not.toContain(summary.runId);
  expect(storage).not.toContain(summary.threadId);
  expect(storage).not.toContain(password);
  expect(storage).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}/);

  // Returning to the conversation keeps the boundary: the chat DOM shows no
  // raw Run id either, and the only storage that may key on runId is the
  // pre-existing whitelisted expansion record with its four fields.
  await tcItem(page, `summarize the vault ${stamp}`)
    .first()
    .getByRole("button", { name: "View result" })
    .click();
  await page.waitForURL(new RegExp(`/app/${botId}`), { timeout: 15_000 });
  await expect(
    page
      .locator('section[data-testid="execution-shell"]')
      .filter({ hasText: `summarize the vault` }),
  ).toBeVisible({ timeout: 20_000 });
  const chatHtml = await page.locator("#root").innerHTML();
  expect(chatHtml).not.toContain("data-run-id");
  expect(chatHtml).not.toContain(summary.runId);
  const expansions = await page.evaluate(() =>
    window.sessionStorage.getItem("rk:execution-expansion"),
  );
  if (expansions) {
    for (const entry of Object.values(JSON.parse(expansions) as Record<string, object>)) {
      expect(Object.keys(entry).sort()).toEqual(["open", "rev", "runId", "threadId"]);
    }
  }
});

test("390px: no horizontal overflow and a keyboard-only card flow", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `tc-390-${stamp}@rakazo.test`, "password12", "TC Narrow");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, `keep working until i stop you ${stamp}`);
  await appearedSummary(page, botId, `keep working until i stop you ${stamp}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoTaskCenter(page);
  try {
    await expect(tcItem(page, `keep working until i stop you ${stamp}`).first()).toBeVisible({
      timeout: 30_000,
    });
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);

    // The sidebar keeps its existing mobile collapse: the entry exists but is
    // parked off-canvas until the existing swipe opens it.
    const entryBox = await page.getByTestId("task-center-entry").boundingBox();
    expect(entryBox).not.toBeNull();
    expect(entryBox!.x + entryBox!.width).toBeLessThanOrEqual(1);

    // Keyboard-only: Tab reaches the card action, Enter returns to the chat.
    let reached = false;
    for (let step = 0; step < 80 && !reached; step += 1) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() =>
        Boolean(document.activeElement?.classList.contains("exc-entry")),
      );
    }
    expect(reached).toBe(true);
    await page.keyboard.press("Enter");
    await page.waitForURL(new RegExp(`/app/${botId}`), { timeout: 15_000 });
    // Focus lands on the waiting/running card surface after the jump.
    await expect(
      page.locator('section[data-testid="execution-shell"]').filter({ hasText: `keep working` }),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    await stopQuietly(page, botId);
  }
});

test("390px empty state: the keyboard alone can open navigation and reach the entry", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `tc-390-nav-${stamp}@rakazo.test`, "password12", "TC Narrow Nav");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  // The honest empty state: fence out the onboarding intro Run.
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run && !TERMINAL.has(snapshot.run.status) ? snapshot.run.status : "idle";
      },
      { timeout: 60_000 },
    )
    .toBe("idle");
  await rpc(page, "threads/clear", { botId });

  await page.setViewportSize({ width: 390, height: 844 });
  await gotoTaskCenter(page);
  await expect(page.getByTestId("task-center-empty")).toBeVisible({ timeout: 30_000 });

  // The sidebar is parked off-canvas (existing collapse), but the header's
  // Open navigation control makes it reachable without the edge swipe.
  const entryBoxBefore = await page.getByTestId("task-center-entry").boundingBox();
  expect(entryBoxBefore!.x + entryBoxBefore!.width).toBeLessThanOrEqual(1);

  // Keyboard-only: Tab to the navigation control, Enter opens the sidebar.
  let reachedNav = false;
  for (let step = 0; step < 80 && !reachedNav; step += 1) {
    await page.keyboard.press("Tab");
    reachedNav = await page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") === "Open navigation",
    );
  }
  expect(reachedNav).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("task-center-entry")).toBeVisible({ timeout: 10_000 });

  // Continue tabbing: focus reaches the Task Center entry inside the sidebar.
  let reachedEntry = false;
  for (let step = 0; step < 80 && !reachedEntry; step += 1) {
    await page.keyboard.press("Tab");
    reachedEntry = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") === "task-center-entry",
    );
  }
  expect(reachedEntry).toBe(true);
});

test("light and dark captures match the restrained list direction", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `tc-visual-${stamp}@rakazo.test`, "password12", "TC Visual");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const runnerId = await createNamedBot(page, `TC Visual B ${stamp}`);

  try {
    await send(page, `keep working until i stop you ${stamp}`);
    await appearedSummary(page, runnerId, `keep working until i stop you ${stamp}`);
    await page.goto(`/app/${chiefId}`);
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 20_000 });
    await send(page, `summarize the quarter ${stamp}`);
    await settledSummary(page, chiefId, `summarize the quarter ${stamp}`);

    await gotoTaskCenter(page);
    await expect(tcItem(page, `keep working until i stop you ${stamp}`).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(tcItem(page, `summarize the quarter ${stamp}`).first()).toBeVisible({
      timeout: 30_000,
    });

    await captureScreenshot(page, testInfo, "task-center-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(tcItem(page, `keep working until i stop you ${stamp}`).first()).toBeVisible();
    await captureScreenshot(page, testInfo, "task-center-dark");

    // Reduced motion changes no information: the list renders identically.
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    await refreshTaskCenter(page);
    await expect(tcItem(page, `summarize the quarter ${stamp}`).first()).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await stopQuietly(page, chiefId);
    await stopQuietly(page, runnerId);
  }
});
