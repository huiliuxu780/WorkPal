import { expect, type Page, test } from "@playwright/test";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

const REGION = "需要你处理";

async function waitForWaitingRun(page: Page, botId: string) {
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

async function waitForRunIdle(page: Page, botId: string) {
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
    .toBeNull();
}

async function requireApprovalForDestinationWrites(page: Page) {
  await rpc(page, "approvalRules/set", {
    effect: "require_approval",
    matchKind: "connector",
    matchValue: "destination.write",
  });
}

async function send(page: Page, text: string) {
  const composer = page.getByPlaceholder(/Message/);
  await expect(composer).toBeEnabled({ timeout: 60_000 });
  await composer.fill(text);
  await page.keyboard.press("Enter");
}

// The page window holds the latest 100 messages. A pending non-text ask
// blocks new sends ("Answer the pending ask first"), so the filler messages
// come from threads/react, which only appends messages — never a run.
async function floodOffPage(page: Page, botId: string, stamp: number) {
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
      clientNonce: `region-filler-${stamp}-${index}`,
    });
  }
}

async function repaintRegionIfCardsLate(page: Page) {
  // threads/get can observe waiting_input before the realtime feed paints the card.
  if ((await page.getByTestId("intervention-region").count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
}

test("a denied plain Run leaves no surface, stale card or operable ask after refresh", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `approval-refresh-${stamp}@rakazo.test`, "password12", "Approval Refresh");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await requireApprovalForDestinationWrites(page);
  await send(page, "write this to the destination crm as a note");
  await waitForWaitingRun(page, botId);
  await repaintRegionIfCardsLate(page);

  const region = page.getByRole("region", { name: REGION });
  const deny = region.getByRole("button", { name: "Deny", exact: true });
  await expect(deny).toBeVisible({ timeout: 15_000 });
  await deny.click();

  // UX-01B: the settled receipt renders only while the Run still owns an
  // execution surface; a denied plain Run then loses the surface entirely.
  // Decision/effect separation while the region lives is covered by
  // InterventionRegion.test.tsx.
  await waitForRunIdle(page, botId);
  await expect(page.getByTestId("intervention-region")).toHaveCount(0, { timeout: 30_000 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  // Acceptance 1 after refresh: no surface, no stale card, and the
  // never-settled bubble ask stays suppressed — nothing operable remains.
  await expect(page.getByTestId("intervention-region")).toHaveCount(0);
  await expect(page.locator("[data-intervention-id]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
});

test("pending cards off the latest page keep question, safe preview, and submit", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `long-history-${stamp}@rakazo.test`, "password12", "Long History");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  // Each type in turn: a send is blocked while an ask waits, so the three
  // pending scenarios run sequentially, each flooded past the 100-message page.
  const cases = [
    {
      name: "approval",
      prompt: "write this to the destination crm as a note",
      approval: true,
      question: (region: ReturnType<Page["getByRole"]>) =>
        expect(region.getByRole("button", { name: "Allow once", exact: true })).toBeVisible({
          timeout: 15_000,
        }),
      submit: async (region: ReturnType<Page["getByRole"]>) => {
        await region.getByRole("button", { name: "Deny", exact: true }).click();
        // UX-01B: the settled receipt is transient for a plain Run; the
        // deterministic end state is no operable control anywhere.
        await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0, {
          timeout: 30_000,
        });
      },
    },
    {
      name: "choice",
      prompt: "pick from these cities",
      approval: false,
      question: (region: ReturnType<Page["getByRole"]>) => {
        expect(region.getByText("Which city should I use?", { exact: true })).toBeVisible({
          timeout: 15_000,
        });
        expect(region.getByText("Tap one option.", { exact: true })).toBeVisible();
      },
      submit: async (region: ReturnType<Page["getByRole"]>) => {
        await region.getByRole("button", { name: "Seoul", exact: true }).click();
        // The answered plain Run loses its surface; with the ask message
        // off-page no echo remains — the choice buttons must all be gone.
        await expect(page.getByRole("button", { name: "Seoul", exact: true })).toHaveCount(0, {
          timeout: 30_000,
        });
      },
    },
    {
      name: "secret",
      prompt: "show a secret card for a masked api key",
      approval: false,
      question: (region: ReturnType<Page["getByRole"]>) => {
        expect(region.getByTestId("secret-ask-card")).toBeVisible({ timeout: 15_000 });
        expect(region.getByText("https://api.example.test", { exact: true })).toBeVisible();
      },
      submit: async (region: ReturnType<Page["getByRole"]>) => {
        const secretValue = `sk-long-history-${stamp}`;
        await region.getByLabel("API key").fill(secretValue);
        await region.getByRole("button", { name: "Save", exact: true }).click();
        // The saved secret never renders, and the settled receipt survives
        // the surface hand-off: region while the Run owns one, then the
        // bubble's own answered card (UX-01B). No operable Save remains.
        await expect(page.getByText(secretValue)).toHaveCount(0);
        await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
      },
    },
  ];

  let approvalRuleSet = false;
  for (const testCase of cases) {
    test.info().annotations.push({ type: "scenario", description: `pending-${testCase.name}` });
    if (testCase.approval && !approvalRuleSet) {
      await requireApprovalForDestinationWrites(page);
      approvalRuleSet = true;
    }
    await send(page, testCase.prompt);
    await waitForWaitingRun(page, botId);

    // Flood 105 messages so the ask message leaves the latest-page window.
    await floodOffPage(page, botId, stamp);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });

    // Earlier settled cards keep their own regions; the section itself carries
    // the role and the testid, so assert on page-level locators.
    await expect(page.getByTestId("intervention-region").first()).toBeVisible({ timeout: 15_000 });
    const region = page.getByRole("region", { name: REGION });
    await testCase.question(region);

    // The server projection carries the complete question without the message.
    const snapshot = await rpc<{
      interventions?: Array<{
        id: string;
        kind: string;
        status: string;
        presentation?: { text?: string };
      }>;
    }>(page, "threads/get", { botId });
    const pending = (snapshot.interventions ?? []).filter((view) => view.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((view) => view.presentation?.text?.length)).toBe(true);

    await testCase.submit(region);
    await waitForRunIdle(page, botId);
  }
});

test("already_handled focuses the authoritative status and refresh keeps it terminal", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `already-handled-${stamp}@rakazo.test`, "password12", "Already Handled");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await send(page, "ask me which city to use");
  await waitForWaitingRun(page, botId);
  await repaintRegionIfCardsLate(page);

  const region = page.getByRole("region", { name: REGION });
  await expect(region.getByRole("button", { name: "Send it", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  const interventionId = await region
    .locator("[data-intervention-id]")
    .first()
    .getAttribute("data-intervention-id");
  expect(interventionId).toBeTruthy();

  // Freeze this client's realtime feed, then answer from a second client. The
  // stale card must come back as already_handled from the real server CAS path
  // (page.request is not affected by page.route). The reload re-opens the page
  // so the only live subscription attempt hits the held route.
  await page.route("**/rpc/threads/subscribe", () => new Promise(() => undefined));
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  const staleRegion = page.getByRole("region", { name: REGION });
  const staleSendIt = staleRegion.getByRole("button", { name: "Send it", exact: true });
  await expect(staleSendIt).toBeVisible({ timeout: 15_000 });
  const other = await rpc<{ outcome: string }>(page, "threads/resolveIntervention", {
    botId,
    interventionId,
    clientSubmissionId: `other-client-${stamp}-submission`,
    answer: "Paris",
  });
  expect(other.outcome).toBe("accepted");

  await staleSendIt.click();
  const authority = staleRegion.getByTestId("intervention-authority");
  await expect(authority).toBeVisible({ timeout: 30_000 });
  await expect(authority).toHaveText("Answered");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid")))
    .toBe("intervention-authority");
  // preventScroll: the focus handoff must not move the page viewport.
  const viewportTop = await page.evaluate(() => window.scrollY);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(viewportTop);

  await page.unroute("**/rpc/threads/subscribe");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  // UX-01B: the answered plain Run keeps no surface. Its ask message is on
  // the latest page, so the settled echo lives in the bubble — exactly one
  // presentation, nothing operable.
  await expect(page.getByTestId("intervention-region")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText("Answered: Paris", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Send it" })).toHaveCount(0);
});
