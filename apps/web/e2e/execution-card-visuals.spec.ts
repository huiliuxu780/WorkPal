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
 * Capture order is state-honest: the completed card is shot COLLAPSED first
 * (verb "View result"), only then expanded (verb "Collapse", shot as
 * card-expanded-*); the failed card is shot in its default-expanded state
 * (card-failed-expanded-*) and again collapsed (card-failed-*, verb
 * "View execution").
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

/** Shells are located by card title: the transcript DOM carries no Run ids. */
function shellOf(page: Page, titlePart: string) {
  return page.locator('section[data-testid="execution-shell"]').filter({ hasText: titlePart });
}

function cardOf(page: Page, titlePart: string) {
  return shellOf(page, titlePart).locator('article[data-testid="execution-card"]');
}

test("capture execution card states across widths and themes", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `card-shots-${stamp}@rakazo.test`, "password12", "Card Shots");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  // Phase A (Chief thread): completed, failed, approval-pending. The hang run
  // gets its own bot below — a message sent while it runs would steer that
  // Run instead of starting a new one.
  const doneTitle = "run 2 shell steps";
  await send(page, doneTitle);
  await settled(page, botId, doneTitle);

  const failedTitle = "fail this run";
  await send(page, `fail this run ${stamp}`);
  await settled(page, botId, failedTitle);

  // State-honest verbs before any interaction: completed collapsed, failed
  // holding the single default-open slot.
  const doneToggle = cardOf(page, doneTitle).locator("button[aria-expanded]").first();
  await expect(doneToggle).toHaveText("View result");
  await expect(doneToggle).toHaveAttribute("aria-expanded", "false");
  const failedToggle = cardOf(page, failedTitle).locator("button[aria-expanded]").first();
  await expect(failedToggle).toHaveText("Collapse");
  await expect(failedToggle).toHaveAttribute("aria-expanded", "true");

  const approvalShell = page
    .locator('section[data-testid="execution-shell"]')
    .filter({ has: page.getByTestId("intervention-region") })
    .first();

  const captureSet = async (
    theme: "light" | "dark",
    targets: Array<[string, Locator]>,
  ) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      for (const [name, target] of targets) {
        await target.scrollIntoViewIfNeeded();
        await shot(target, `${name}-${width}-${theme}`);
      }
    }
  };

  // Pass 1: completed collapsed + failed default-expanded.
  await captureSet("light", [
    ["card-completed", cardOf(page, doneTitle)],
    ["card-failed-expanded", shellOf(page, failedTitle)],
  ]);

  // The pending approval now takes the single open slot; the failed detail
  // collapses on its own while its card stays visible.
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
  await expect(failedToggle).toHaveText("View execution");
  await expect(failedToggle).toHaveAttribute("aria-expanded", "false");

  // Pass 2: failed collapsed + the waiting-approval card with its region.
  await captureSet("light", [
    ["card-failed", cardOf(page, failedTitle)],
    ["card-waiting-approval", approvalShell],
  ]);

  // Pass 3: expand the completed Run (card + detail as one object). Opening
  // it closes the approval detail — the region stays visible outside.
  const detail = page.waitForResponse((response) =>
    response.url().includes("/rpc/runs/executionSnapshot"),
  );
  await doneToggle.click();
  await detail.catch(() => undefined);
  await expect(doneToggle).toHaveText("Collapse");
  await expect(doneToggle).toHaveAttribute("aria-expanded", "true");
  await captureSet("light", [["card-expanded", shellOf(page, doneTitle)]]);

  // Dark-theme spot check: system dark drives the token layer. Collapse the
  // completed card first so its dark shot is honestly collapsed too.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await doneToggle.click();
  await expect(doneToggle).toHaveText("View result");
  await captureSet("dark", [
    ["card-completed", cardOf(page, doneTitle)],
    ["card-failed", cardOf(page, failedTitle)],
    ["card-waiting-approval", approvalShell],
  ]);
  const darkDetail = page.waitForResponse((response) =>
    response.url().includes("/rpc/runs/executionSnapshot"),
  );
  await doneToggle.click();
  await darkDetail.catch(() => undefined);
  await expect(doneToggle).toHaveText("Collapse");
  await captureSet("dark", [["card-expanded", shellOf(page, doneTitle)]]);
  await page.emulateMedia({ colorScheme: "light" });

  // Phase B (Runner bot): the running state. Its own thread keeps the hang
  // Run from steering Phase A's sends.
  await createBotFromPicker(page, { name: "Runner" });
  const runnerBotId = activeBotId(page);
  await send(page, "keep working until i stop");
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId: runnerBotId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("running");
  const runningShell = shellOf(page, "keep working until i stop");
  if ((await runningShell.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(runningShell).toBeVisible({ timeout: 15_000 });
  await captureSet("light", [["card-running", cardOf(page, "keep working until i stop")]]);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(250);
  await captureSet("dark", [["card-running", cardOf(page, "keep working until i stop")]]);
});
