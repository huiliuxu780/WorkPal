import { expect, test } from "@playwright/test";
import { createDb } from "../../../packages/db/src/index.js";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

const pageHtml = `<!doctype html><html><body><main><h1>Board</h1><p>marker-share</p><p>Total $12,345 paid to card 4242</p></main></body></html>`;

// The main flow is required as a recording, not only stills.
test.use({ video: "on" });

async function setAppearance(page: import("@playwright/test").Page, value: "light" | "dark") {
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId(`ui-appearance-${value}`).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", value);
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
}

async function openShare(page: import("@playwright/test").Page) {
  await page.getByTestId("page-share-trigger").first().click();
  const sheet = page.getByTestId("share-sheet");
  await expect(sheet).toBeVisible();
  return sheet;
}

test("shares a page inside the Space and through a revocable expiring public link", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await signup(page, `share-${Date.now()}@rakazo.test`, "password12", "Share E2E");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(`write path board.html and attach it to the thread says ${pageHtml}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("page-share-trigger")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("artifact-page-card")).toBeVisible();
  await captureScreenshot(page, testInfo, "SH-F01-1440-light-entry");

  // The detail shell exposes the same sheet.
  await page.getByTestId("artifact-page-card").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTestId("page-detail-share").click();
  const detailSheet = page.getByTestId("share-sheet");
  await expect(detailSheet).toBeVisible();
  await expect(detailSheet.getByTestId("share-space-link")).toContainText("/app/shared/", {
    timeout: 30_000,
  });
  await page.keyboard.press("Escape");
  await expect(detailSheet).toBeHidden();

  // Space step: login-scoped link first, public off by default.
  const sheet = await openShare(page);
  await expect(sheet.getByText("分享页面", { exact: true })).toBeVisible();
  const spaceLink = sheet.getByTestId("share-space-link");
  await expect(spaceLink).toContainText("/app/shared/", { timeout: 30_000 });
  await expect(sheet.getByRole("checkbox")).toHaveCount(0);
  await expect(sheet).not.toContainText("marker-share");
  await expect(sheet).not.toContainText("12,345");
  await captureScreenshot(page, testInfo, "SH-F02-sheet");
  await captureScreenshot(page, testInfo, "SH-F03-space-default");
  await captureScreenshot(page, testInfo, "SH-F14-desense");
  await captureScreenshot(page, testInfo, "SH-F18-no-task-center");

  await sheet.getByTestId("share-copy-space").click();
  await expect(sheet.getByTestId("share-copy-space")).toContainText("已复制");
  const spaceUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(spaceUrl).toMatch(/\/app\/shared\/[^/]+\/[^/]+$/);

  // Independent confirmation, then the expiry presets.
  await sheet.getByTestId("share-public-entry").click();
  await expect(sheet.getByText("确认公开分享", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("checkbox")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "SH-F05-to-confirm");
  await sheet.getByTestId("share-confirm-cancel").click();
  await expect(sheet.getByText("分享页面", { exact: true })).toBeVisible();
  await sheet.getByTestId("share-public-entry").click();
  await captureScreenshot(page, testInfo, "SH-F06-confirm");
  await sheet.getByTestId("share-confirm").click();
  await expect(sheet.getByTestId("share-expiry-chips")).toBeVisible();
  for (const name of ["24 小时", "7 天", "30 天", "自定义"]) {
    await expect(sheet.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(sheet.getByRole("button", { name: "永不过期" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "SH-F07-chips");

  // Custom 120 is refused; the button only comes back inside 1–90.
  await sheet.getByRole("button", { name: "自定义", exact: true }).click();
  const customDays = sheet.getByTestId("share-custom-days");
  await customDays.fill("120");
  await expect(sheet.getByTestId("share-expiry-note")).toContainText("自定义上限为 90 天");
  await expect(sheet.getByTestId("share-generate")).toBeDisabled();
  await captureScreenshot(page, testInfo, "SH-F08-custom-cap");
  await customDays.fill("14");
  await expect(sheet.getByTestId("share-generate")).toBeEnabled();

  // Generate a 7-day link and copy it.
  await sheet.getByRole("button", { name: "7 天", exact: true }).click();
  await sheet.getByTestId("share-generate").click();
  await expect(sheet.getByText("公开链接已生成", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const publicLink = sheet.getByTestId("share-public-link");
  await expect(publicLink).toContainText("/p/");
  const publicUrl = (await publicLink.textContent())?.trim() ?? "";
  expect(publicUrl).toMatch(/\/p\/[A-Za-z0-9_-]{20,}$/);
  await sheet.getByTestId("share-copy-public").click();
  await expect(sheet.getByTestId("share-copy-public")).toContainText("已复制");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(publicUrl);
  await captureScreenshot(page, testInfo, "SH-F09-generated");

  // Managing an existing link from the Space step.
  await sheet.getByRole("button", { name: "完成", exact: true }).click();
  await expect(sheet.getByTestId("share-existing")).toBeVisible();
  await expect(sheet.getByTestId("share-existing")).toContainText("已有公开链");
  await captureScreenshot(page, testInfo, "SH-F12-manage");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // Anonymous read-only visit.
  const anon = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const anonPage = await anon.newPage();
  await anonPage.goto(publicUrl);
  await expect(anonPage.getByTestId("public-share-view")).toHaveAttribute("data-state", "ok");
  await expect(anonPage.getByText("只读", { exact: true })).toBeVisible();
  await expect(
    anonPage
      .frameLocator("iframe")
      .frameLocator("#preview")
      .getByRole("heading", { name: "Board" }),
  ).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(anonPage, testInfo, "SH-F13-readonly");

  // Revoke: the old URL dies immediately, with only the desensitized card.
  const sheetAgain = await openShare(page);
  await sheetAgain.getByTestId("share-manage").click();
  await expect(sheetAgain.getByText("公开链接已生成", { exact: true })).toBeVisible();
  await sheetAgain.getByTestId("share-revoke").click();
  await expect(sheetAgain.getByText("分享页面", { exact: true })).toBeVisible();
  await expect(sheetAgain.getByTestId("share-existing")).toHaveCount(0);
  await anonPage.goto(publicUrl);
  await expect(anonPage.getByTestId("public-share-view")).toHaveAttribute("data-state", "revoked");
  await expect(anonPage.getByText("链接已失效", { exact: true })).toBeVisible();
  await expect(anonPage.getByTestId("public-share-dead-card")).toContainText("board.html");
  await expect(anonPage.getByText("marker-share")).toHaveCount(0);
  await captureScreenshot(anonPage, testInfo, "SH-F10-revoked");
  await page.keyboard.press("Escape");
  await expect(sheetAgain).toBeHidden();

  // Expiry is enforced by the server, not the dead-page copy.
  const db = createDb(process.env.DATABASE_URL!);
  try {
    const artifact = await db.prisma.artifact.findFirstOrThrow({
      where: { botId, mimeType: "text/html" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const expiring = await rpc<{ token: string }>(page, "share/createPublic", {
      botId,
      artifactId: artifact.id,
      expiry: { preset: "custom", customDays: 1 },
    });
    await db.prisma.shareLink.update({
      where: { token: expiring.token },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await anonPage.goto(`${new URL(publicUrl).origin}/p/${expiring.token}`);
  } finally {
    await db.prisma.$disconnect().catch(() => undefined);
    await db.pool.end().catch(() => undefined);
  }
  await expect(anonPage.getByTestId("public-share-view")).toHaveAttribute("data-state", "expired");
  await expect(anonPage.getByText("链接已过期", { exact: true })).toBeVisible();
  await expect(anonPage.getByText("marker-share")).toHaveCount(0);
  await captureScreenshot(anonPage, testInfo, "SH-F11-expired");
  await anon.close();

  // Dark appearance.
  await setAppearance(page, "dark");
  const darkSheet = await openShare(page);
  await expect(darkSheet.getByTestId("share-space-link")).toContainText("/app/shared/");
  await captureScreenshot(page, testInfo, "SH-F17-dark-space");
  await page.keyboard.press("Escape");
  await expect(darkSheet).toBeHidden();

  // Narrow viewports: bottom sheet, no horizontal overflow.
  for (const width of [390, 375] as const) {
    await page.setViewportSize({ width, height: 844 });
    const narrowSheet = await openShare(page);
    await expect(narrowSheet.getByTestId("share-space-link")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(1);
    await expect
      .poll(async () => {
        const box = await narrowSheet.boundingBox();
        return box ? Math.round(box.y + box.height) : 0;
      })
      .toBeGreaterThanOrEqual(844 - 2);
    await captureScreenshot(page, testInfo, `SH-F16-${width}`);
    await page.keyboard.press("Escape");
    await expect(narrowSheet).toBeHidden();
  }

  // Sharing never opens the attention queue or a task list.
  await expect(page.getByTestId("attention-queue")).toHaveCount(0);

  // The login-scoped link opens as a read-only page for the owner...
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(spaceUrl);
  await expect(page.getByTestId("space-share-view")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.frameLocator("iframe").frameLocator("#preview").getByRole("heading", { name: "Board" }),
  ).toBeVisible({ timeout: 20_000 });

  // ...and for another member of the same Space, not just the artifact owner.
  // Signup gives the second human their own Personal Space; add a real
  // membership in the sharer's Space, which is what an invited teammate has.
  const spaceId = new URL(spaceUrl).pathname.split("/").at(-2)!;
  const memberEmail = `share-member-${Date.now()}@rakazo.test`;
  const memberContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const memberPage = await memberContext.newPage();
  await signup(memberPage, memberEmail, "password12", "Share Member");
  await completeOnboarding(memberPage);
  const membershipDb = createDb(process.env.DATABASE_URL!);
  try {
    const space = await membershipDb.prisma.space.findUniqueOrThrow({
      where: { id: spaceId },
      select: { organizationId: true },
    });
    const memberUser = await membershipDb.prisma.user.findUniqueOrThrow({
      where: { email: memberEmail },
      select: { id: true },
    });
    const created = new Date();
    await membershipDb.prisma.member.upsert({
      where: {
        organizationId_userId: { organizationId: space.organizationId, userId: memberUser.id },
      },
      update: {},
      create: {
        id: `share-member-${memberUser.id}`,
        organizationId: space.organizationId,
        userId: memberUser.id,
        role: "member",
        createdAt: created,
      },
    });
    await membershipDb.prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId, userId: memberUser.id } },
      update: {},
      create: {
        id: `share-space-member-${memberUser.id}`,
        spaceId,
        organizationId: space.organizationId,
        userId: memberUser.id,
        role: "member",
        createdAt: created,
      },
    });
  } finally {
    await membershipDb.prisma.$disconnect().catch(() => undefined);
    await membershipDb.pool.end().catch(() => undefined);
  }
  await memberPage.goto(spaceUrl);
  await expect(memberPage.getByTestId("space-share-view")).toBeVisible({ timeout: 30_000 });
  await expect(
    memberPage
      .frameLocator("iframe")
      .frameLocator("#preview")
      .getByRole("heading", { name: "Board" }),
  ).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(memberPage, testInfo, "SH-F04-same-space-member");
  await memberContext.close();

  // The Space link still requires a session.
  const anonymousContext = await browser.newContext();
  const anonymousPage = await anonymousContext.newPage();
  await anonymousPage.goto(spaceUrl);
  await expect(anonymousPage).toHaveURL(/\/sign-in/);
  await anonymousContext.close();
});
