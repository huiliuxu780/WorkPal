import { expect, test } from "@playwright/test";
import { createDb } from "../../../packages/db/src/index.js";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

const APPROVE_GROUP = "Open approval room";
const DENY_GROUP = "Decline approval room";
const FAIL_GROUP = "Unreachable approval room";
const SOURCE_PROMPT = (groupName: string) =>
  `Take the performance risk review to the group named "${groupName}".`;
const GROUP_PROMPT = "Check the launch performance risk and report back.";
const RETURN_SUMMARY = "I brought the result back: Friday can still ship behind a 10% rollout.";

/**
 * RT-12 at the production boundary: a Bot that is not in the target group asks
 * for a scoped "join and continue" decision, then joins once, delivers once,
 * and reports back in the source direct chat. The no-permission branch is the
 * separate X-GROUP-FAIL card, never a pending approval.
 */
test.describe("group membership approval (X-GROUP)", () => {
  test.skip(
    process.env.ROUNDTABLE_MESSAGE_GROUP_ENABLED !== "true" ||
      process.env.CARDS_UNIFIED_V2_ENABLED !== "true",
    "Run with ROUNDTABLE_MESSAGE_GROUP_ENABLED=true and CARDS_UNIFIED_V2_ENABLED=true",
  );

  test("joins once, delivers once, and returns the result", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const stamp = Date.now();
    await signup(page, `group-membership-${stamp}@rakazo.test`, "password12", "Membership E2E");
    await completeOnboarding(page);
    await page.goto("/app");
    await page.waitForURL(/\/app\/[^/]+$/);

    const joy = await createBot(page, "Joy");
    const blue = await createBot(page, "Blue");
    const extra = await createBot(page, "Scarlet");
    const group = await rpc<{ id: string }>(page, "groups/create", {
      name: APPROVE_GROUP,
      botIds: [blue.id, extra.id],
    });

    await page.goto(`/app/${joy.id}`);
    await page.waitForURL(new RegExp(`/app/${joy.id}$`));
    const composer = page.getByTestId("composer-bar").getByRole("combobox");
    await expect(composer).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    await composer.fill(SOURCE_PROMPT(APPROVE_GROUP));
    await composer.press("Enter");

    const card = page.getByTestId("group-membership-approval");
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toContainText(`Add Joy to “${APPROVE_GROUP}”?`);
    await expect(card).toContainText("Join and continue");
    await expect(card).toContainText("Not now");
    for (const term of ["Intervention", "revision", "Run", "Task", "Thread"]) {
      await expect(card).not.toContainText(term);
    }
    // No target work exists before the decision.
    expect(await groupTexts(page, group.id)).toEqual([]);
    await captureScreenshot(page, testInfo, "X-GROUP-APPROVE-1440");

    await page.setViewportSize({ width: 430, height: 900 });
    await expect(card).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await captureScreenshot(page, testInfo, "X-GROUP-APPROVE-430");
    await page.setViewportSize({ width: 1440, height: 900 });

    // A reload restores the same pending card from the server.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("Join and continue");

    await card.getByTestId("group-membership-approve").click();
    await expect(card).toContainText("Joined");

    await expect
      .poll(
        async () => (await groupTexts(page, group.id)).some((text) => text.includes(GROUP_PROMPT)),
        {
          timeout: 90_000,
          intervals: [500, 1_000, 2_000],
        },
      )
      .toBe(true);
    await expect
      .poll(
        async () => (await sourceTexts(page, joy.id)).some((text) => text.includes(RETURN_SUMMARY)),
        { timeout: 120_000, intervals: [1_000, 2_000, 3_000] },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await groupTexts(page, group.id)).filter((text) => text.includes(GROUP_PROMPT)).length,
        {
          timeout: 30_000,
          intervals: [500, 1_000],
        },
      )
      .toBe(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("group-membership-approval")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("group-membership-approval")).toContainText("Joined");
    await expect(page.getByText(RETURN_SUMMARY, { exact: false })).toBeVisible({ timeout: 30_000 });
    await captureScreenshot(page, testInfo, "X-GROUP-APPROVE-terminal-1440");

    await page.setViewportSize({ width: 430, height: 900 });
    await captureScreenshot(page, testInfo, "X-GROUP-APPROVE-terminal-430");
  });

  test("declining joins nothing and starts no target work", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    await signup(
      page,
      `group-membership-deny-${stamp}@rakazo.test`,
      "password12",
      "Membership E2E",
    );
    await completeOnboarding(page);
    await page.goto("/app");
    await page.waitForURL(/\/app\/[^/]+$/);

    const joy = await createBot(page, "Joy");
    const blue = await createBot(page, "Blue");
    const extra = await createBot(page, "Scarlet");
    const group = await rpc<{ id: string }>(page, "groups/create", {
      name: DENY_GROUP,
      botIds: [blue.id, extra.id],
    });

    await page.goto(`/app/${joy.id}`);
    await page.waitForURL(new RegExp(`/app/${joy.id}$`));
    const composer = page.getByTestId("composer-bar").getByRole("combobox");
    await expect(composer).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await composer.fill(SOURCE_PROMPT(DENY_GROUP));
    await composer.press("Enter");

    const card = page.getByTestId("group-membership-approval");
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.getByTestId("group-membership-deny").click();
    await expect(card).toContainText("Not joined");
    expect(await groupTexts(page, group.id)).toEqual([]);
  });

  test("losing member permission shows only the X-GROUP-FAIL card", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    await signup(
      page,
      `group-membership-fail-${stamp}@rakazo.test`,
      "password12",
      "Membership E2E",
    );
    await completeOnboarding(page);
    await page.goto("/app");
    await page.waitForURL(/\/app\/[^/]+$/);

    const joy = await createBot(page, "Joy");
    const blue = await createBot(page, "Blue");
    const extra = await createBot(page, "Scarlet");
    const group = await rpc<{ id: string }>(page, "groups/create", {
      name: FAIL_GROUP,
      botIds: [blue.id, extra.id],
    });

    await page.goto(`/app/${joy.id}`);
    await page.waitForURL(new RegExp(`/app/${joy.id}$`));
    const composer = page.getByTestId("composer-bar").getByRole("combobox");
    await expect(composer).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await composer.fill(SOURCE_PROMPT(FAIL_GROUP));
    await composer.press("Enter");

    const card = page.getByTestId("group-membership-approval");
    await expect(card).toBeVisible({ timeout: 60_000 });

    // Simulate the only way a readable group becomes unmanageable in this
    // model: its owner changed after the card was shown. The approval must
    // revalidate and stop instead of joining or sending anything.
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const groupThreadId = (
      await prisma.chatGroup.findUniqueOrThrow({
        where: { id: group.id },
        select: { thread: { select: { id: true } } },
      })
    ).thread?.id;
    if (!groupThreadId) throw new Error("group thread missing");
    try {
      await prisma.chatGroup.update({
        where: { id: group.id },
        data: { userId: `former-owner-${stamp}` },
      });
      await card.getByTestId("group-membership-approve").click();
      const failure = page.getByTestId("group-membership-failure");
      await expect(failure).toBeVisible({ timeout: 30_000 });
      await expect(failure).toContainText(`Could not add Joy to “${FAIL_GROUP}”`);
      await expect(failure).toContainText("No member permission");
      await expect(page.getByTestId("group-membership-approval")).toHaveCount(0);
      expect(await prisma.message.count({ where: { threadId: groupThreadId } })).toBe(0);
      await captureScreenshot(page, testInfo, "X-GROUP-FAIL-1440");

      await page.setViewportSize({ width: 430, height: 900 });
      await expect(failure).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      await captureScreenshot(page, testInfo, "X-GROUP-FAIL-430");

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("group-membership-failure")).toBeVisible({ timeout: 30_000 });
    } finally {
      await pool.end();
    }
  });
});

async function createBot(page: Parameters<typeof rpc>[0], name: string) {
  return rpc<{ id: string; name: string }>(page, "bots/create", {
    name,
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
}

async function groupTexts(page: Parameters<typeof rpc>[0], groupId: string) {
  const snapshot = await rpc<{
    messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
  }>(page, "threads/get", { groupId });
  return snapshot.messages.flatMap((message) =>
    message.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.text ?? "")
      .filter(Boolean),
  );
}

async function sourceTexts(page: Parameters<typeof rpc>[0], botId: string) {
  const snapshot = await rpc<{
    messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
  }>(page, "threads/get", { botId });
  return snapshot.messages.flatMap((message) =>
    message.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.text ?? "")
      .filter(Boolean),
  );
}
