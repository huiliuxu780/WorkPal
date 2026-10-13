import { expect, type Locator, type Page, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { activeBotId, completeOnboarding, createBotFromPicker, rpc, signup } from "./helpers";

/**
 * Opt-in visual acceptance captures for the Execution Card (Task 4 §11.4).
 * Runs only with WORKPAL_CARD_SHOTS=1; writes PNGs to WORKPAL_CARD_SHOTS_DIR
 * (default .zcode/tmp/execution-card-shots under the repo root). These are
 * review artifacts compared against the Task 15.1 v2 design, not CI gates —
 * the repo has no toHaveScreenshot baselines and this spec adds none.
 *
 * Note on "background": production has no trusted root-Run background signal
 * yet (docs/execution-shell-progress.md remaining gate), so a background card
 * cannot be honestly produced end-to-end; its presentation path is covered by
 * the ExecutionCard unit tests instead.
 */

const enabled = process.env.WORKPAL_CARD_SHOTS === "1";
const outDir =
  process.env.WORKPAL_CARD_SHOTS_DIR ??
  join(__dirname, "..", "..", "..", ".zcode", "tmp", "execution-card-shots");

test.skip(!enabled, "set WORKPAL_CARD_SHOTS=1 to capture Execution Card visuals");
test.describe.configure({ mode: "serial" });

const WIDTHS = [390, 768, 1440] as const;

async function send(page: Page, text: string) {
  const composer = page.getByPlaceholder(/Message/);
  await expect(composer).toBeEnabled({ timeout: 60_000 });
  await composer.fill(text);
  await page.keyboard.press("Enter");
}

type Summary = { runId: string; title: string; status: string };
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

async function settled(page: Page, botId: string, titlePart: string): Promise<Summary> {
  let found: Summary | undefined;
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ executions?: Summary[] }>(page, "threads/get", { botId });
        found = (snapshot.executions ?? []).find(
          (item) => item.title.includes(titlePart) && TERMINAL.has(item.status),
        );
        return found ? 1 : 0;
      },
      { timeout: 90_000, intervals: [250, 500, 1_000] },
    )
    .toBe(1);
  return found!;
}

async function shot(locator: Locator, name: string) {
  mkdirSync(outDir, { recursive: true });
  await locator.screenshot({ animations: "disabled", path: join(outDir, `${name}.png`) });
}

async function waitRunning(page: Page, botId: string) {
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
}

test("capture execution card states across widths and themes", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `card-shots-${stamp}@rakazo.test`, "password12", "Card Shots");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  // Phase A (Chief thread): completed, failed, approval-pending. The hang run
  // gets its own bot below — a message sent while it runs would steer that
  // Run instead of starting a new one.
  await send(page, "run 2 shell steps");
  const done = await settled(page, botId, "run 2 shell steps");

  await send(page, `fail this run ${stamp}`);
  const failed = await settled(page, botId, "fail this run");

  await rpc(page, "approvalRules/set", {
    effect: "require_approval",
    matchKind: "connector",
    matchValue: "destination.write",
  });
  await send(page, "write this to the destination crm as a note");
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
  if ((await page.getByTestId("intervention-region").count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.getByTestId("intervention-region")).toBeVisible({ timeout: 15_000 });

  const shell = (runId: string) =>
    page.locator(`section[data-testid="execution-shell"][data-run-id="${runId}"]`);
  const states: Array<[string, string]> = [
    ["completed", done.runId],
    ["failed", failed.runId],
  ];

  // Expanded-details state: open the completed Run's detail.
  const expandButton = shell(done.runId).locator("button[aria-expanded]").first();
  if ((await expandButton.getAttribute("aria-expanded")) !== "true") {
    const detail = page.waitForResponse((response) =>
      response.url().includes("/rpc/runs/executionSnapshot"),
    );
    await expandButton.click();
    await detail.catch(() => undefined);
  }
  await expect(expandButton).toHaveAttribute("aria-expanded", "true", { timeout: 15_000 });

  const captureWidths = async (theme: "light" | "dark") => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      for (const [name, runId] of states) {
        const target = shell(runId);
        await target.scrollIntoViewIfNeeded();
        await shot(
          target.locator('article[data-testid="execution-card"]'),
          `card-${name}-${width}-${theme}`,
        );
      }
      // The waiting-approval card together with its Intervention region.
      const approvalShell = page
        .locator('section[data-testid="execution-shell"]')
        .filter({ has: page.getByTestId("intervention-region") })
        .first();
      await approvalShell.scrollIntoViewIfNeeded();
      await shot(approvalShell, `card-waiting-approval-${width}-${theme}`);
      // Expanded details (card + detail as one continuous object).
      const expandedShell = shell(done.runId);
      await expandedShell.scrollIntoViewIfNeeded();
      await shot(expandedShell, `card-expanded-${width}-${theme}`);
    }
  };

  await captureWidths("light");
  // Dark-theme spot check: system dark drives the token layer.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await captureWidths("dark");
  await page.emulateMedia({ colorScheme: "light" });

  // Phase B (Runner bot): the running state. Its own thread keeps the hang
  // Run from steering Phase A's sends.
  await createBotFromPicker(page, { name: "Runner" });
  const runnerBotId = activeBotId(page);
  await send(page, "keep working until i stop");
  await waitRunning(page, runnerBotId);
  const runningShell = page.locator('section[data-testid="execution-shell"]').first();
  if ((await runningShell.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(runningShell).toBeVisible({ timeout: 15_000 });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(250);
    await runningShell.scrollIntoViewIfNeeded();
    await shot(runningShell.locator('article[data-testid="execution-card"]'), `card-running-${width}-light`);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(250);
  await page.setViewportSize({ width: 1440, height: 900 });
  await runningShell.scrollIntoViewIfNeeded();
  await shot(runningShell.locator('article[data-testid="execution-card"]'), "card-running-1440-dark");
});
