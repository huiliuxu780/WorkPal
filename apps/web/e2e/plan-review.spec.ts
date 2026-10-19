import { expect, type Page, test } from "@playwright/test";
import {
  activeBotId,
  completeOnboarding,
  findPendingPlanReview,
  resolvePlanReview,
  rpc,
  signup,
} from "./helpers";

/**
 * UX-02 unified plan review, end to end on the real stack (API + Worker +
 * PostgreSQL + Web): one external review card per submission, the three fixed
 * actions, same-Run resume, content-version re-review, plan_rejected
 * cancellation, and idempotent/stale decision handling.
 */

type Summary = { runId: string; title: string; status: string; rev: number };
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

async function summaryByTitle(page: Page, botId: string, titlePart: string): Promise<Summary> {
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

async function setupBot(page: Page, label: string): Promise<string> {
  const stamp = Date.now();
  await signup(page, `${label}-${stamp}@rakazo.test`, "password12", "Plan Reviewer");
  await completeOnboarding(page);
  return activeBotId(page);
}

test("submitting a plan pauses on one external card and approval resumes the same run", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const botId = await setupBot(page, "plan-approve");
  const stamp = Date.now();
  await send(page, `publish a tracked plan named alpha-${stamp}`);

  // Exactly one review card, in the Intervention Region — outside the
  // collapsible detail body, so collapsing can never hide it.
  const pendingCard = page.locator('[data-testid="plan-review-card"][data-status="pending"]');
  await expect(pendingCard).toHaveCount(1, { timeout: 45_000 });
  await expect(
    page.locator('[data-testid="intervention-region"] [data-testid="plan-review-card"]'),
  ).toHaveCount(1);
  await expect(pendingCard).toHaveAttribute("data-content-version", "1");
  await expect(pendingCard).toContainText(`Deliver alpha-${stamp}`);
  await expect(pendingCard).toContainText("Collect input");
  const cardText = await pendingCard.innerText();
  expect(cardText).not.toMatch(/always allow/i);

  // The run waits on the review; it did not fail or finish, and the sidebar
  // avatar carries the decision-wait state (badge only, no status text).
  const waiting = await summaryByTitle(page, botId, `alpha-${stamp}`);
  expect(waiting.status).toBe("waiting_input");
  const row = page.locator(`[data-roster-bot-id="${botId}"]`);
  await expect
    .poll(
      async () =>
        row
          .locator(".rakazo-agent-avatar, .rakazo-upload-avatar")
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("data-state")).join(","),
          ),
      { timeout: 30_000, intervals: [500, 1_000] },
    )
    .toBe("approval");

  // Approve through the real card control.
  await pendingCard.getByTestId("plan-review-approve").click();
  await expect(page.locator('[data-testid="plan-review-authority"]')).toContainText("Approved", {
    timeout: 30_000,
  });

  // The scripted revision changes plan CONTENT (two new stages): the same run
  // must open a v2 review instead of executing an unapproved revision.
  const v2 = page.locator('[data-testid="plan-review-card"][data-status="pending"]');
  await expect(v2).toHaveCount(1, { timeout: 45_000 });
  await expect(v2).toHaveAttribute("data-content-version", "2");
  await v2.getByTestId("plan-review-approve").click();

  // Same Task/Run resumes to completion; the result bubble appears once.
  const done = await settledSummary(page, botId, `alpha-${stamp}`);
  expect(done.status).toBe("completed");
  expect(done.runId).toBe(waiting.runId);
  await expect(
    page
      .getByTestId("transcript")
      .getByText(`done. i handled: publish a tracked plan named alpha-${stamp}`),
  ).toBeVisible({ timeout: 30_000 });
});

test("request changes records feedback, shows it on the old card, and re-reviews the next version", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const botId = await setupBot(page, "plan-changes");
  const stamp = Date.now();
  await send(page, `publish a tracked plan named beta-${stamp}`);

  const pendingCard = page.locator('[data-testid="plan-review-card"][data-status="pending"]');
  await expect(pendingCard).toHaveCount(1, { timeout: 45_000 });
  await pendingCard.getByTestId("plan-review-request-changes").click();
  // Feedback is required: sending stays disabled until it is concrete.
  const sendFeedback = pendingCard.getByTestId("plan-review-send-feedback");
  await expect(sendFeedback).toBeDisabled();
  await pendingCard.getByTestId("plan-review-feedback").fill("Split the analysis per region");
  await expect(sendFeedback).toBeEnabled();
  await sendFeedback.click();

  // The old card shows the typed outcome and the reviewer's feedback.
  await expect(page.locator('[data-testid="plan-review-authority"]')).toContainText(
    "Changes requested",
    { timeout: 30_000 },
  );
  await expect(page.locator('[data-testid="plan-review-authority"]')).toContainText(
    "Split the analysis per region",
  );

  // The same run revises and submits content version 2 for a fresh review.
  const v2 = page.locator('[data-testid="plan-review-card"][data-status="pending"]');
  await expect(v2).toHaveCount(1, { timeout: 60_000 });
  await expect(v2).toHaveAttribute("data-content-version", "2");
  await resolvePlanReview(page, { botId }, "approve", { expectedContentVersion: 2 });

  const done = await settledSummary(page, botId, `beta-${stamp}`);
  expect(done.status).toBe("completed");
});

test("reject cancels the run with plan_rejected, keeps the audit, and frees the bot", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const botId = await setupBot(page, "plan-reject");
  const stamp = Date.now();
  await send(page, `publish a tracked plan named gamma-${stamp}`);

  const pendingCard = page.locator('[data-testid="plan-review-card"][data-status="pending"]');
  await expect(pendingCard).toHaveCount(1, { timeout: 45_000 });
  await pendingCard.getByTestId("plan-review-reject").click();
  // The reason is optional: confirm rejects without filling anything.
  await pendingCard.getByTestId("plan-review-confirm-reject").click();
  await expect(page.locator('[data-testid="plan-review-authority"]')).toContainText(
    "Plan rejected",
    { timeout: 30_000 },
  );

  const cancelled = await settledSummary(page, botId, `gamma-${stamp}`);
  expect(cancelled.status).toBe("cancelled");
  // No further tool sends produced a result message.
  await expect(
    page.getByTestId("transcript").getByText(`done. i handled: publish a tracked plan`),
  ).toHaveCount(0);
  // Nothing stays pending for this thread, and the sidebar avatar reflects the
  // bot's real (freed) state instead of a pinned wait.
  expect(await findPendingPlanReview(page, { botId })).toBeUndefined();
  const row = page.locator(`[data-roster-bot-id="${botId}"]`);
  await expect
    .poll(
      async () =>
        row
          .locator(".rakazo-agent-avatar, .rakazo-upload-avatar")
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("data-state")).join(","),
          ),
      { timeout: 30_000, intervals: [500, 1_000] },
    )
    .toBe("idle");
});

test("repeated and raced decisions are idempotent business outcomes", async ({ page }) => {
  test.setTimeout(180_000);
  const botId = await setupBot(page, "plan-idem");
  const stamp = Date.now();
  await send(page, `publish a tracked plan named delta-${stamp}`);

  await expect
    .poll(async () => (await findPendingPlanReview(page, { botId }))?.id ?? "", {
      timeout: 45_000,
      intervals: [250, 500, 1_000],
    })
    .not.toBe("");
  const view = (await findPendingPlanReview(page, { botId }))!;
  const submissionId = `plan-review-fixed-${stamp}`;
  const first = await rpc<{ outcome: string }>(page, "threads/resolveIntervention", {
    botId,
    interventionId: view.id,
    clientSubmissionId: submissionId,
    answer: "approve",
  });
  expect(first.outcome).toBe("accepted");
  // Same submission id replays as accepted; a different client is told
  // already_handled — neither re-decides nor re-queues.
  const replay = await rpc<{ outcome: string }>(page, "threads/resolveIntervention", {
    botId,
    interventionId: view.id,
    clientSubmissionId: submissionId,
    answer: "approve",
  });
  expect(replay.outcome).toBe("accepted");
  const raced = await rpc<{ outcome: string }>(page, "threads/resolveIntervention", {
    botId,
    interventionId: view.id,
    clientSubmissionId: `other-${stamp}`,
    answer: "reject",
  });
  expect(raced.outcome).toBe("already_handled");

  // The paced v2 review still arrives and decides normally.
  await resolvePlanReview(page, { botId }, "approve", { expectedContentVersion: 2 });
  const done = await settledSummary(page, botId, `delta-${stamp}`);
  expect(done.status).toBe("completed");
});
