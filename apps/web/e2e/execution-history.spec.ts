import { expect, type Page, test } from "@playwright/test";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

type Summary = {
  runId: string;
  title: string;
  status: string;
  rev: number;
  entry: string;
  anchorMessageId?: string;
  outcome?: string;
  artifacts?: Array<{ id: string; name: string }>;
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

/**
 * Poll one Run's summary by id until it is terminal. Free-text answers rewrite
 * the Task prompt, so the title is not a stable handle after an answer.
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

/** Poll until a summary whose title contains `titlePart` reaches a terminal state. */
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

function shellOf(page: Page, runId: string) {
  return page.locator(`section[data-testid="execution-shell"][data-run-id="${runId}"]`);
}

async function expandShell(page: Page, runId: string) {
  const header = shellOf(page, runId).locator("button[aria-expanded]").first();
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true", { timeout: 15_000 });
}

async function collapseShell(page: Page, runId: string) {
  const header = shellOf(page, runId).locator("button[aria-expanded]").first();
  if ((await header.getAttribute("aria-expanded")) === "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false", { timeout: 15_000 });
}

/**
 * A Run whose anchor message paged out only renders once its history page is
 * loaded; page back until its shell appears.
 */
async function revealShell(page: Page, runId: string) {
  await expect
    .poll(
      async () => {
        if ((await shellOf(page, runId).count()) > 0) return 1;
        const more = page.getByRole("button", { name: "Load earlier messages" });
        if ((await more.count()) === 0 || !(await more.isEnabled())) return 0;
        await more.click();
        await expect(more)
          .toBeEnabled({ timeout: 15_000 })
          .catch(() => undefined);
        return (await shellOf(page, runId).count()) > 0 ? 1 : 0;
      },
      { timeout: 60_000, intervals: [300, 700] },
    )
    .toBe(1);
  await expect(shellOf(page, runId)).toBeVisible({ timeout: 15_000 });
}

async function floodHistory(page: Page, botId: string, stamp: number, count = 105) {
  const history = await rpc<{ messages: Array<{ id: string }> }>(page, "threads/messages", {
    botId,
  });
  const parent = history.messages[0]?.id;
  if (!parent) throw new Error("no message to react to");
  for (let index = 0; index < count; index++) {
    await rpc(page, "threads/react", {
      botId,
      messageId: parent,
      reaction: "👍",
      clientNonce: `hist-${stamp}-${index}`,
    });
  }
}

async function answerTextAsk(page: Page, value: string) {
  const region = page.getByRole("region", { name: "需要你处理" });
  await region.getByRole("button", { name: "Edit first", exact: true }).click();
  await region.getByRole("textbox", { name: "Answer" }).fill(value);
  await region.getByRole("button", { name: "Send answer", exact: true }).click();
}

test("refresh restores a completed execution with the same rev and content", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `exec-refresh-${stamp}@rakazo.test`, "password12", "Exec Refresh");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await send(page, `write a file named quarter-${stamp}.txt saying quarter numbers`);
  const summary = await settledSummary(page, botId, "write a file named");
  expect(summary.entry).toBe("execution");
  expect(summary.rev).toBeGreaterThan(0);
  expect(summary.anchorMessageId).toBeTruthy();
  expect(summary.outcome).toContain("writing that into my home");

  const detail = await rpc<{
    summary: { rev: number };
    result?: { messageId: string; blocks: Array<{ kind: string; text?: string }> };
  }>(page, "runs/executionSnapshot", { botId, runId: summary.runId });
  expect(detail.summary.rev).toBe(summary.rev);
  const resultText = (detail.result?.blocks ?? [])
    .filter((block) => block.kind === "text")
    .map((block) => block.text ?? "")
    .join(" ");
  expect(resultText).toContain("writing that into my home");

  await expect(shellOf(page, summary.runId)).toBeVisible();
  // The result is a chat bubble on the page.
  await expect(page.getByText("writing that into my home").first()).toBeVisible({
    timeout: 15_000,
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  const restored = (await executionsOf(page, botId)).find((item) => item.runId === summary.runId);
  expect(restored?.rev).toBe(summary.rev);
  expect(restored?.anchorMessageId).toBe(summary.anchorMessageId);
  await revealShell(page, summary.runId);
  await expandShell(page, summary.runId);
  await expect(page.getByText("writing that into my home").first()).toBeVisible({
    timeout: 15_000,
  });
});

test("executions restore when their messages are pushed off the page", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `exec-paged-${stamp}@rakazo.test`, "password12", "Exec Paged");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, "ask me which city to use");
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
  const pending = await summaryByTitle(page, botId, "ask me which city");
  expect(pending.status).toBe("waiting_input");
  await answerTextAsk(page, "Paris");
  const summary = await settledSummaryById(page, botId, pending.runId);

  await floodHistory(page, botId, stamp);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  // Still projected (recent-window summary) even though its message is off page one.
  expect((await executionsOf(page, botId)).some((item) => item.runId === summary.runId)).toBe(true);

  // Page back until the anchor message and its shell return.
  await revealShell(page, summary.runId);
  await expandShell(page, summary.runId);
  // The answer echo text needs the ask message itself; keep paging until it
  // (or its shell) is on screen.
  const answeredText = shellOf(page, summary.runId)
    .getByText("Answered: Paris", { exact: true })
    .first();
  for (let guard = 0; guard < 12 && (await answeredText.count()) === 0; guard++) {
    const more = page.getByRole("button", { name: "Load earlier messages" });
    if ((await more.count()) === 0 || !(await more.isEnabled().catch(() => false))) break;
    await more.click();
    await page.waitForTimeout(300);
  }
  const detail = await rpc<{
    interventions: Array<{ status: string; input?: { mode: string } }>;
    result?: { blocks: Array<{ kind: string; text?: string }> };
  }>(page, "runs/executionSnapshot", { botId, runId: summary.runId });
  expect(
    detail.interventions.some((view) => view.input?.mode === "text" && view.status === "answered"),
  ).toBe(true);
  const resultText = (detail.result?.blocks ?? [])
    .filter((block) => block.kind === "text")
    .map((block) => block.text ?? "")
    .join(" ");
  expect(resultText).toContain("handled: Paris");
  await expect(
    shellOf(page, summary.runId).getByText("Answered: Paris", { exact: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
});

test("long Activity paginates without repeats or gaps", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `exec-activity-${stamp}@rakazo.test`, "password12", "Exec Activity");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await send(page, "run 120 shell steps");
  const summary = await settledSummary(page, botId, "run 120 shell steps");

  const detail = await rpc<{ activityPage: { olderCursor: string | null } }>(
    page,
    "runs/executionSnapshot",
    { botId, runId: summary.runId },
  );
  expect(detail.activityPage.olderCursor, "120 steps must paginate").toBeTruthy();

  // Walk every page at the API: distinct tool ids never repeat, and together
  // they cover the whole timeline (no gap). The seeded run status line repeats
  // by design on every page and is deduped client-side, so it is excluded.
  const toolIds = new Set<string>();
  const occurrences = new Map<string, string>();
  let cursor: string | null | undefined;
  for (let guard = 0; guard < 12; guard++) {
    const page1 = await rpc<{
      items: Array<{ id: string; count?: number }>;
      olderCursor: string | null;
    }>(page, "runs/executionActivityPage", {
      botId,
      runId: summary.runId,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page1.items) {
      if (item.id.startsWith("run:")) continue;
      const previous = occurrences.get(item.id);
      // A pair split across the boundary legitimately appears on both pages
      // (reconciled completed on the newer, raw running on the older); the
      // client keeps the newer status. Anything else must never repeat.
      expect(
        previous === undefined || (previous !== item.status && item.status === "running"),
        `bad repeat: ${item.id}`,
      ).toBe(true);
      occurrences.set(item.id, item.status);
      toolIds.add(item.id);
    }
    cursor = page1.olderCursor;
    if (!cursor) break;
  }
  expect(cursor).toBeNull();
  expect(toolIds.size).toBeGreaterThanOrEqual(60);

  await revealShell(page, summary.runId);
  await expandShell(page, summary.runId);
  const loadMore = page.getByTestId(`execution-activity-more-${summary.runId}`);
  await expect(loadMore).toBeVisible({ timeout: 15_000 });
  const readIds = () =>
    shellOf(page, summary.runId)
      .locator("[data-activity-id]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-activity-id")));
  const idsBefore = await readIds();
  expect(idsBefore.length).toBeGreaterThan(0);
  const hiddenCount = async () => {
    const text = await shellOf(page, summary.runId)
      .locator('[data-slot="activity"]')
      .first()
      .evaluate((node) => node.textContent ?? "");
    return Number(/Earlier activities are not shown:\s*(\d+)/.exec(text)?.[1] ?? "0");
  };
  const hiddenBefore = await hiddenCount();
  await loadMore.click();
  // The merged window grows: older pages add rows beyond the visible cap.
  await expect.poll(hiddenCount, { timeout: 15_000 }).toBeGreaterThan(hiddenBefore);
  // Rendered rows never repeat an id: the Web merge dedupes with the newer
  // status winning.
  const idsAfter = await readIds();
  expect(new Set(idsAfter).size).toBe(idsAfter.length);
  await expect(shellOf(page, summary.runId).locator('[data-slot="activity"]')).toHaveCount(1);
});

test("multiple terminal Runs restore independently and only one detail is open", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `exec-multi-${stamp}@rakazo.test`, "password12", "Exec Multi");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, `write a file named alpha-${stamp}.txt saying alpha marker`);
  const alpha = await settledSummary(page, botId, "write a file named alpha");
  await send(page, "run the shell command echo beta-marker");
  const beta = await settledSummary(page, botId, "echo beta-marker");
  await send(page, `attach to the thread with path notes/gamma-${stamp}.txt says gamma marker`);
  const gamma = await settledSummary(page, botId, "attach to the thread");

  const details = await Promise.all(
    [alpha, beta, gamma].map((item) =>
      rpc<{
        summary: { runId: string; artifacts: Array<{ name: string }> };
        result?: { blocks: Array<{ kind: string; text?: string }> };
      }>(page, "runs/executionSnapshot", { botId, runId: item.runId }),
    ),
  );
  const textOf = (index: number) =>
    (details[index].result?.blocks ?? [])
      .filter((block) => block.kind === "text")
      .map((block) => block.text ?? "")
      .join(" ");
  // No run leaks another run's result or artifacts.
  expect(textOf(0)).not.toContain("gamma");
  expect(textOf(1)).not.toContain("gamma");
  expect(details[2].summary.artifacts.map((artifact) => artifact.name).join()).toContain("gamma");
  expect(details[0].summary.artifacts).toHaveLength(0);
  expect(new Set(details.map((detail) => detail.summary.runId)).size).toBe(3);

  // Single expansion: opening the second shell closes the first.
  await revealShell(page, alpha.runId);
  await expandShell(page, alpha.runId);
  await revealShell(page, beta.runId);
  await expandShell(page, beta.runId);
  await expect(shellOf(page, alpha.runId).locator("button[aria-expanded]").first()).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(shellOf(page, beta.runId).locator("button[aria-expanded]").first()).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  for (const item of [alpha, beta, gamma]) {
    await revealShell(page, item.runId);
  }
});

test("secrets stay out of snapshots, storage, and the DOM after history reload", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `exec-secret-${stamp}@rakazo.test`, "password12", "Exec Secret");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await send(page, "show a secret card for a masked api key");
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
  const secretValue = `sk-history-${stamp}`;
  const card = page.getByTestId("secret-ask-card");
  await card.getByLabel("API key").fill(secretValue);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByText("Saved", { exact: true })).toBeVisible({ timeout: 30_000 });
  const summary = await settledSummary(page, botId, "show a secret card");

  await floodHistory(page, botId, stamp);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  await revealShell(page, summary.runId);
  await expandShell(page, summary.runId);
  await expect(
    shellOf(page, summary.runId).getByText("Saved", { exact: true }).first(),
  ).toBeVisible({ timeout: 15_000 });

  // Secret absent from every surface.
  await expect(page.getByText(secretValue)).toHaveCount(0);
  const snapshotText = JSON.stringify(await rpc(page, "threads/get", { botId }));
  expect(snapshotText).not.toContain(secretValue);
  const olderPage = JSON.stringify(await rpc(page, "threads/messages", { botId, before: 999999 }));
  expect(olderPage).not.toContain(secretValue);
  const detailText = JSON.stringify(
    await rpc(page, "runs/executionSnapshot", { botId, runId: summary.runId }),
  );
  expect(detailText).not.toContain(secretValue);
  const clientState = await page.evaluate(() =>
    JSON.stringify({ ...window.localStorage, ...window.sessionStorage }),
  );
  expect(clientState).not.toContain(secretValue);
});

test("a cleared Run stays hidden when its artifact is deleted afterwards", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `exec-cleared-${stamp}@rakazo.test`, "password12", "Exec Cleared");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, `attach to the thread with path notes/stale-${stamp}.txt says stale marker`);
  const summary = await settledSummary(page, botId, "attach to the thread");
  let artifactId: string | undefined;
  await expect
    .poll(
      async () => {
        artifactId = (await executionsOf(page, botId)).find((item) => item.runId === summary.runId)
          ?.artifacts?.[0]?.id;
        return artifactId ? 1 : 0;
      },
      { timeout: 30_000 },
    )
    .toBe(1);

  await rpc(page, "threads/clear", { botId });
  await expect
    .poll(
      async () =>
        (await executionsOf(page, botId)).some((item) => item.runId === summary.runId) ? 1 : 0,
      { timeout: 30_000 },
    )
    .toBe(0);

  // Deleting the stale Run's artifact is legal thread maintenance: it lands a
  // fresh thread.artifact event naming a pre-clear Run.
  await rpc(page, "artifacts/remove", { artifactId });

  // That event must not revive the Run into the cleared generation — neither
  // in the window (after a real reload) nor in the single-Run detail read.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  expect((await executionsOf(page, botId)).some((item) => item.runId === summary.runId)).toBe(
    false,
  );
  await expect(shellOf(page, summary.runId)).toHaveCount(0);
  const detail = await rpc<{
    summary: { incompleteSections?: string[] };
    result?: unknown;
  }>(page, "runs/executionSnapshot", { botId, runId: summary.runId });
  expect(detail.result).toBeUndefined();
  expect(detail.summary.incompleteSections ?? []).toEqual(
    expect.arrayContaining(["result", "activity"]),
  );
});

test("a late stale detail response never mixes into the newer version's paging", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `exec-order-${stamp}@rakazo.test`, "password12", "Exec Order");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, "run 60 shell steps then ask");
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 90_000 },
    )
    .toBe("waiting_input");
  const pending = await summaryByTitle(page, botId, "run 60 shell steps then ask");
  const rev1 = pending.rev;

  // Hold the first detail response until the SECOND one has been delivered:
  // the stale response then lands out of order, exactly the race the single
  // rev guard on detail+cursor+older-pages must survive.
  let requests = 0;
  let releaseStale: (() => void) | null = null;
  const staleGate = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  await page.route("**/rpc/runs.executionSnapshot", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    requests += 1;
    if (requests === 1) {
      await staleGate;
      await route.fulfill({ response, body });
    } else {
      await route.fulfill({ response, body });
      releaseStale!();
    }
  });

  await revealShell(page, pending.runId);
  await expandShell(page, pending.runId); // fetch #1 (rev1) — held in the gate

  // Answering appends real events: rev moves and the Run completes. The rev
  // bump drops the stored expansion decision, collapsing the shell.
  await answerTextAsk(page, "Paris");
  const settled = await settledSummaryById(page, botId, pending.runId);
  expect(settled.rev).toBeGreaterThan(rev1);

  await collapseShell(page, pending.runId); // no-op when the rev bump already collapsed it
  await expandShell(page, pending.runId); // fetch #2 (rev2) — lands, releases #1
  const loadMore = page.getByTestId(`execution-activity-more-${pending.runId}`);
  await expect(loadMore).toBeVisible({ timeout: 30_000 });

  const hiddenCount = async () => {
    const text = await shellOf(page, pending.runId)
      .locator('[data-slot="activity"]')
      .first()
      .evaluate((node) => node.textContent ?? "");
    return Number(/Earlier activities are not shown:\s*(\d+)/.exec(text)?.[1] ?? "0");
  };
  const readIds = () =>
    shellOf(page, pending.runId)
      .locator("[data-activity-id]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-activity-id")));

  const h0 = await hiddenCount();
  await loadMore.click();
  await expect.poll(hiddenCount, { timeout: 20_000 }).toBeGreaterThan(h0);
  const h1 = await hiddenCount();
  const idsLoaded = await readIds();

  // The stale rev1 response has now been released and delivered. It must not
  // wipe the loaded older pages, roll the cursor back, or resurrect the
  // pending ask card: detail, cursor and older pages are one versioned unit.
  await page.waitForTimeout(1_500);
  expect(await hiddenCount()).toBeGreaterThanOrEqual(h1);
  const idsAfter = await readIds();
  expect(new Set(idsAfter).size).toBe(idsAfter.length);
  expect(new Set([...idsLoaded, ...idsAfter]).size).toBeGreaterThan(0);
  for (const id of idsLoaded) expect(idsAfter).toContain(id);
  await expect(
    shellOf(page, pending.runId).getByRole("button", { name: "Send answer", exact: true }),
  ).toHaveCount(0);

  // The cursor kept the newer version's position: paging again still moves
  // forward without duplicate ids.
  if (await loadMore.isVisible().catch(() => false)) {
    await loadMore.click();
    await page.waitForTimeout(800);
    const idsMore = await readIds();
    expect(new Set(idsMore).size).toBe(idsMore.length);
    expect(await hiddenCount()).toBeGreaterThanOrEqual(h1);
  }
});
