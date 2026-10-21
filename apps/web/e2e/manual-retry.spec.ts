import { expect, type Page, test } from "@playwright/test";
import { activeBotId, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

type Summary = {
  runId: string;
  threadId: string;
  title: string;
  status: string;
  rev: number;
  counts?: { steps?: number };
  retryOfRunId?: string;
  retrySuccessorRunId?: string;
  manualRetry?: { allowed: boolean; reason?: string };
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

function shellOf(page: Page, titlePart: string) {
  return page.locator('section[data-testid="execution-shell"]').filter({ hasText: titlePart });
}

function ancestorShell(page: Page, titlePart: string) {
  return shellOf(page, titlePart).filter({
    has: page.getByTestId("execution-already-retried"),
  });
}

function successorShell(page: Page, titlePart: string) {
  return shellOf(page, titlePart).filter({
    hasNot: page.getByTestId("execution-already-retried"),
  });
}

function cardOf(page: Page, titlePart: string) {
  return shellOf(page, titlePart).locator('article[data-testid="execution-card"]');
}

test("a failed chat card retries into a new Run on the same Task and keeps the old record", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `mr-card-${stamp}@rakazo.test`, "password12", "MR Card");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, `fail this tracked run ${stamp}`);
  const failed = await settledSummary(page, botId, "fail this tracked run");
  expect(failed.status).toBe("failed");
  expect(failed.manualRetry?.allowed).toBe(true);

  if ((await cardOf(page, "fail this tracked run").count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  const card = cardOf(page, "fail this tracked run");
  await expect(card.getByTestId("execution-retry")).toBeVisible({ timeout: 15_000 });
  await card.getByTestId("execution-retry").click();

  let successorId: string | undefined;
  await expect
    .poll(
      async () => {
        const rows = await executionsOf(page, botId);
        const ancestor = rows.find((row) => row.runId === failed.runId);
        successorId = ancestor?.retrySuccessorRunId;
        return ancestor?.status === "failed" &&
          successorId &&
          rows.some((row) => row.runId === successorId)
          ? 1
          : 0;
      },
      { timeout: 90_000, intervals: [250, 500, 1_000] },
    )
    .toBe(1);

  const ancestor = ancestorShell(page, "fail this tracked run");
  await expect(ancestor.getByTestId("execution-already-retried")).toHaveText("Already retried");
  await ancestor.getByTestId("execution-view-retry").click();
  await expect(successorShell(page, "fail this tracked run")).toBeVisible();
  const rows = await executionsOf(page, botId);
  expect(rows.find((row) => row.runId === failed.runId)?.retrySuccessorRunId).toBe(successorId);
  expect(rows.some((row) => row.runId === successorId)).toBe(true);
});

test("a cancelled Run retries from the execution card in its source conversation", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `mr-cancel-${stamp}@rakazo.test`, "password12", "MR Cancel");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  // The tracked-steps hang publishes a real semantic Step first, so the Run
  // keeps an execution surface (UX-01B rule 1) and its card stays in this
  // conversation — where MR-01 retry lives after the CAP-01 convergence.
  await send(page, `keep working with tracked steps until i stop you ${stamp}`);
  // The cancel must not race the Step publish: a run cancelled before its
  // step lands keeps no execution surface (UX-01B rule 1) and therefore no
  // card to retry from. Wait until the server summary counts the persisted
  // step — the same fact the surface eligibility derivation reads.
  await expect
    .poll(
      async () => {
        const rows = await executionsOf(page, botId);
        const run = rows.find((row) => row.title.includes(`${stamp}`));
        return run && (run.counts?.steps ?? 0) > 0 ? 1 : 0;
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe(1);
  await rpc(page, "threads/stop", { botId });
  const cancelled = await settledSummary(page, botId, `${stamp}`);
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.manualRetry?.allowed).toBe(true);

  // Refresh the source conversation so the card restores from the persisted
  // summary, then page back to its anchor if it sits outside the first
  // window — through the real "Load earlier messages" control only.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  const card = cardOf(page, `${stamp}`);
  await expect
    .poll(
      async () => {
        if ((await card.count()) > 0) return 1;
        const more = page.getByRole("button", { name: "Load earlier messages" });
        if ((await more.count()) === 0 || !(await more.isEnabled())) return 0;
        await more.click();
        await expect(more)
          .toBeEnabled({ timeout: 15_000 })
          .catch(() => undefined);
        return (await card.count()) > 0 ? 1 : 0;
      },
      { timeout: 60_000, intervals: [300, 700] },
    )
    .toBe(1);

  await expect(card).toHaveAttribute("data-status", "cancelled", { timeout: 15_000 });
  await expect(card.getByTestId("execution-retry")).toBeVisible({ timeout: 15_000 });
  await card.getByTestId("execution-retry").click();

  await expect
    .poll(
      async () => {
        const rows = await executionsOf(page, botId);
        return rows.some((row) => row.retryOfRunId === cancelled.runId) ? 1 : 0;
      },
      { timeout: 90_000, intervals: [250, 500, 1_000] },
    )
    .toBe(1);

  // The successor re-runs the same hanging prompt; leave nothing running.
  await rpc(page, "threads/stop", { botId }).catch(() => undefined);
});

test("a cancelled cardless Run retries from its triggering message (PD-01)", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `msg-retry-${stamp}@rakazo.test`, "password12", "Message Retry");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  // The plain hang fixture publishes no Plan/Step/Intervention, so the
  // cancelled Run keeps NO execution surface (UX-01B rule 1, pinned by
  // execution-card.spec) and the card-borne MR-01 entry does not exist.
  await send(page, `keep working until i stop you ${stamp}`);
  await expect
    .poll(
      async () => {
        const rows = await executionsOf(page, botId);
        return rows.find((row) => row.title.includes(`${stamp}`))?.status ?? "none";
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe("running");
  await rpc(page, "threads/stop", { botId });
  const cancelled = await settledSummary(page, botId, `${stamp}`);
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.manualRetry?.allowed).toBe(true);
  expect(cancelled.counts?.steps).toBeUndefined();
  await expect(page.locator('section[data-testid="execution-shell"]')).toHaveCount(0);

  // The entry rides the triggering message's hover rail and restores from the
  // same projection after a reload (D3/D6) — still without any card (D1).
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  const userRow = page
    .locator("[data-message-id]")
    .filter({ hasText: `keep working until i stop you ${stamp}` })
    .first();
  await expect(userRow).toBeVisible({ timeout: 20_000 });
  await userRow.hover();
  const retry = userRow.getByTestId("message-retry");
  await expect(retry).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('section[data-testid="execution-shell"]')).toHaveCount(0);
  await retry.click();

  // Exactly one successor through the existing runs/retry path (D5/D8); the
  // projection flip removes the entry, so a second click is impossible.
  await expect
    .poll(
      async () => {
        const rows = await executionsOf(page, botId);
        return rows.filter((row) => row.retryOfRunId === cancelled.runId).length;
      },
      { timeout: 90_000, intervals: [250, 500, 1_000] },
    )
    .toBe(1);
  await expect(userRow.getByTestId("message-retry")).toHaveCount(0);

  // The successor re-runs the same hanging prompt; leave nothing running.
  await rpc(page, "threads/stop", { botId }).catch(() => undefined);
});

test("a group message's secondary-bot cancelled Run restores its entry after pagination (PD-01 D10)", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `group-retry-${stamp}@rakazo.test`, "password12", "Group Retry");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const writerId = await createNamedBot(page, "Writer");

  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: `Retry team ${stamp}`,
    botIds: [chiefId, writerId],
  });
  await page.goto(`/app/g/${group.id}`);
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });

  // Deterministic setup: one group message mentioning both bots creates one
  // hanging Run each — the "all weigh in" marker is required: multiple
  // explicit mentions WITHOUT a separate-answers request route to a single
  // owner by product policy (response-owner.ts). The message links only the
  // FIRST Run via message.runId, so the secondary bot's Run is reachable
  // only through the summary's sourceMessageId projection (D9).
  const ask = `keep working until i stop you, all weigh in ${stamp}`;
  await rpc(page, "threads/send", {
    groupId: group.id,
    text: ask,
    mentions: [chiefId, writerId],
    clientNonce: `gr-send-${stamp}`,
  });
  const groupExecutions = async () => {
    const snapshot = await rpc<{ executions?: Summary[] }>(page, "threads/get", {
      groupId: group.id,
    });
    return snapshot.executions ?? [];
  };
  await expect
    .poll(
      async () => (await groupExecutions()).filter((row) => row.status === "running").length,
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe(2);
  await rpc(page, "threads/stop", { groupId: group.id });
  await expect
    .poll(
      async () =>
        (await groupExecutions()).filter(
          (row) => row.status === "cancelled" && row.manualRetry?.allowed,
        ).length,
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe(2);

  // Push the triggering message off the first history page, then page back
  // through the real control only. Each filler echoes, so 60 sends put ~120
  // messages behind the trigger (page window is 100) — enough to evict it
  // with margin while keeping the paging budget CI-realistic.
  for (let i = 0; i < 60; i++) {
    await rpc(page, "threads/send", {
      groupId: group.id,
      text: `group-filler-${stamp}-${i}`,
      clientNonce: `gf-${stamp}-${i}`,
    });
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  const userRow = page
    .locator("[data-message-id]")
    .filter({ hasText: `all weigh in ${stamp}` })
    .first();
  await expect
    .poll(
      async () => {
        if ((await userRow.count()) > 0) return 1;
        const more = page.getByRole("button", { name: "Load earlier messages" });
        if ((await more.count()) === 0 || !(await more.isEnabled())) return 0;
        await more.click();
        await expect(more)
          .toBeEnabled({ timeout: 15_000 })
          .catch(() => undefined);
        return (await userRow.count()) > 0 ? 1 : 0;
      },
      { timeout: 120_000, intervals: [300, 700] },
    )
    .toBe(1);

  // BOTH cancelled Runs restore their entry on the one triggering message —
  // including the secondary bot's, which message.runId cannot reference —
  // and the two entries are distinguishable by bot name.
  await userRow.hover();
  const retries = userRow.getByTestId("message-retry");
  await expect(retries).toHaveCount(2, { timeout: 15_000 });
  await expect(retries.nth(0)).toHaveAccessibleName(/Retry .+/);
  await expect(retries.nth(1)).toHaveAccessibleName(/Retry .+/);

  await rpc(page, "threads/stop", { groupId: group.id }).catch(() => undefined);
});
