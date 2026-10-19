import { expect, type Page, test } from "@playwright/test";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

type Summary = {
  runId: string;
  threadId: string;
  title: string;
  status: string;
  rev: number;
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

test("Task Center retries a cancelled Run that has no chat Execution shell", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `mr-tc-${stamp}@rakazo.test`, "password12", "MR TaskCenter");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await send(page, `keep working until i stop you ${stamp}`);
  await expect
    .poll(
      async () => {
        const rows = await executionsOf(page, botId);
        return rows.some((row) => row.title.includes(`${stamp}`)) ? 1 : 0;
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe(1);
  await rpc(page, "threads/stop", { botId });
  const cancelled = await settledSummary(page, botId, `${stamp}`);
  expect(cancelled.status).toBe("cancelled");

  await page.goto("/app/tasks");
  await expect(page.getByTestId("task-center")).toBeVisible({ timeout: 20_000 });
  const item = page.locator('[data-testid="task-center-item"]').filter({ hasText: `${stamp}` });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await expect(item.getByTestId("execution-retry")).toBeVisible();
  await item.getByTestId("execution-retry").click();
  await page.waitForURL(new RegExp(`/app/${botId}`), { timeout: 20_000 });

  await expect
    .poll(
      async () => {
        const rows = await executionsOf(page, botId);
        return rows.some((row) => row.retryOfRunId === cancelled.runId) ? 1 : 0;
      },
      { timeout: 90_000, intervals: [250, 500, 1_000] },
    )
    .toBe(1);

  await rpc(page, "threads/stop", { botId }).catch(() => undefined);
});
