import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

// The connect / remove / uninstall journey is required as a recording.
test.use({ video: "on" });

async function openIntegrations(page: import("@playwright/test").Page) {
  await page.getByTestId("integrations-entry").click();
  await expect(page.getByTestId("integrations-filter-all")).toBeVisible({ timeout: 30_000 });
}

/** Empty and failed catalogs intentionally hide the search/chip toolbar. */
async function openDialog(page: import("@playwright/test").Page) {
  await page.getByTestId("integrations-entry").click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
}

test("connections catalog IA, chips, detail, MCP entry, empty/error and zh", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signup(page, `connections-${Date.now()}@rakazo.test`, "password12", "Connections E2E");
  await completeOnboarding(page);

  // AC-CN01 / CN-14: the dialog is 1080×760 and starts with no connected apps.
  await page.getByTestId("integrations-entry").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The dialog zooms in over ~100ms; poll until the box settles.
  await expect.poll(async () => Math.round((await dialog.boundingBox())?.width ?? 0)).toBe(1080);
  await expect.poll(async () => Math.round((await dialog.boundingBox())?.height ?? 0)).toBe(760);
  await captureScreenshot(page, testInfo, "CN-01-shell-open");
  await expect(page.getByTestId("integrations-filter-all")).toBeVisible();
  await expect(page.getByTestId("integrations-filter-connected")).toContainText("0");
  await expect(page.getByTestId("integrations-connected-section")).toHaveCount(0);
  await expect(page.getByTestId("integrations-all-apps")).toBeVisible();

  // AC-CN03 / CN-06: connect Gmail; it moves into the Connected section with a
  // status pill and the recommended section drops it. The mock catalog has no
  // description, so no description slot is rendered.
  const featured = page.getByTestId("featured-connectors");
  await expect(featured.getByText("Gmail", { exact: true })).toBeVisible();
  const gmailRow = featured
    .getByText("Gmail", { exact: true })
    .locator("xpath=ancestor::*[.//button][1]");
  await gmailRow.getByRole("button", { name: "Add", exact: true }).click();
  const gmailTile = page.getByTestId("connection-tile-gmail");
  await expect(gmailTile).toBeVisible();
  const connectedSection = page.getByTestId("integrations-connected-section");
  await expect(connectedSection).toBeVisible();
  await expect(connectedSection).toContainText("Connected · 1 account");
  await expect(featured.getByText("Gmail", { exact: true })).toHaveCount(0);
  await expect(gmailTile.getByTestId("connection-tile-description")).toHaveCount(0);
  const connectedY = (await connectedSection.boundingBox())?.y ?? 0;
  const featuredY = (await featured.boundingBox())?.y ?? 0;
  const mcpY = (await page.getByTestId("integrations-mcp-entry").boundingBox())?.y ?? 0;
  const allY = (await page.getByTestId("integrations-all-apps").boundingBox())?.y ?? 0;
  expect(connectedY).toBeLessThan(featuredY);
  expect(featuredY).toBeLessThan(mcpY);
  expect(mcpY).toBeLessThan(allY);
  await captureScreenshot(page, testInfo, "CN-03-ia-segments");
  await captureScreenshot(page, testInfo, "CN-06-no-desc");

  // AC-CN04: the connected chip narrows to active apps; a miss shows the hint.
  await page.getByTestId("integrations-filter-connected").click();
  await expect(page.getByTestId("connection-tile-gmail")).toBeVisible();
  await expect(page.getByText("GitHub", { exact: true })).toHaveCount(0);
  await page.getByPlaceholder("Search apps").fill("zzzz");
  await expect(page.getByText("No apps match your search.")).toBeVisible();
  await captureScreenshot(page, testInfo, "CN-04-chips-search");
  await page.getByPlaceholder("Search apps").fill("");
  await page.getByTestId("integrations-filter-all").click();

  // AC-CN08 / CN-09: detail status, accounts, tools, rename, and a remove with
  // no confirmation dialog.
  await page.getByTestId("connection-tile-gmail").click();
  const detail = page.getByTestId("connection-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Connected");
  await expect(page.getByTestId("connection-accounts")).toContainText("Accounts");
  await expect(page.getByTestId("connection-tools")).toBeVisible();
  await detail.getByRole("button", { name: "Add another", exact: true }).click();
  await expect(detail.getByLabel("Account label")).toHaveCount(2);
  await detail.getByLabel("Account label").nth(1).fill("Work");
  await detail.getByLabel("Account label").nth(1).blur();
  await expect(detail.getByLabel("Account label").nth(1)).toHaveValue("Work");
  await detail.getByRole("button", { name: "Remove", exact: true }).last().click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(detail.getByLabel("Account label")).toHaveCount(1);
  await captureScreenshot(page, testInfo, "CN-08-detail");

  // Uninstall also has no confirmation; it returns to the catalog.
  await detail.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByTestId("connection-detail")).toHaveCount(0);
  await expect(
    page.getByTestId("featured-connectors").getByText("Gmail", { exact: true }),
  ).toBeVisible();

  // AC-CN07: the MCP entry card opens the existing setup form.
  await page.getByTestId("integrations-mcp-entry").click();
  await expect(page.getByRole("heading", { name: "Add MCP server" })).toBeVisible({
    timeout: 20_000,
  });
  await captureScreenshot(page, testInfo, "CN-07-mcp-entry");

  // AC-CN10: Advanced still reaches the MCP management overlay unchanged.
  await page.keyboard.press("Escape");
  await openIntegrations(page);
  await page.getByTestId("integrations-advanced").evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  await page.getByRole("button", { name: "Manage MCP servers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "MCP servers" })).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, testInfo, "CN-10-advanced-mcp");
  await page.getByRole("button", { name: "Close MCP servers" }).click();
  await expect(page.getByRole("heading", { name: "MCP servers" })).toBeHidden();

  // AC-CN11: zh-CN copy for the catalog and detail.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("integrations-filter-all")).toBeHidden();
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("ui-locale-select").click();
  await page.getByRole("option", { name: "简体中文" }).click();
  await settings.getByRole("button", { name: "关闭用户设置" }).click();
  await expect(settings).toBeHidden();
  await page.getByTestId("integrations-entry").click();
  await expect(page.getByTestId("integrations-filter-all")).toBeVisible();
  await expect(page.getByTestId("integrations-mcp-entry")).toContainText("浏览 MCP 服务器");
  await expect(page.getByText("推荐", { exact: true })).toBeVisible();
  const zhGmailRow = page
    .getByTestId("featured-connectors")
    .getByText("Gmail", { exact: true })
    .locator("xpath=ancestor::*[.//button][1]");
  await zhGmailRow.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByTestId("connection-tile-gmail")).toBeVisible();
  await page.getByTestId("connection-tile-gmail").click();
  const zhDetail = page.getByTestId("connection-detail");
  await expect(zhDetail).toContainText("账户");
  await expect(zhDetail).toContainText("工具");
  await expect(zhDetail.getByRole("button", { name: "卸载", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "CN-11-i18n-zh");

  // AC-CN12 regression + CN-14: uninstall leaves no connected apps; the
  // Connected chip shows the empty hint.
  await zhDetail.getByRole("button", { name: "卸载", exact: true }).click();
  await expect(page.getByTestId("connection-detail")).toHaveCount(0);
  await expect(page.getByTestId("integrations-connected-section")).toHaveCount(0);
  await page.getByTestId("integrations-filter-connected").click();
  await expect(page.getByText("还没有已连接的应用。")).toBeVisible();
  await captureScreenshot(page, testInfo, "CN-14-zero-connected");
  await page.getByTestId("integrations-filter-all").click();
  await page.keyboard.press("Escape");

  // AC-CN02: an empty catalog renders the four-layer EmptyHero, not a grey line.
  await page.route("**/rpc/connections/catalog", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: [] }),
    }),
  );
  await openDialog(page);
  await expect(page.getByTestId("integrations-empty-hero")).toBeVisible();
  await expect(page.getByTestId("integrations-empty-hero")).toContainText("连接你的第一个应用");
  await expect(page.getByTestId("integrations-mcp-entry")).toBeVisible();
  await expect(page.getByTestId("integrations-empty-hero")).toContainText("此部署未配置插件目录");
  await captureScreenshot(page, testInfo, "CN-02-empty-hero");
  await page.unroute("**/rpc/connections/catalog");
  await page.keyboard.press("Escape");

  // AC-CN13: a catalog failure is a retryable error, and it never flashes the
  // empty hero.
  await page.route("**/rpc/connections/catalog", (route) => route.abort());
  await openDialog(page);
  await expect(page.getByTestId("integrations-load-error")).toBeVisible();
  await expect(page.getByTestId("integrations-empty-hero")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "CN-13-load-error");
  await page.unroute("**/rpc/connections/catalog");
  await page.getByTestId("integrations-load-error").getByRole("button", { name: "重试" }).click();
  await expect(page.getByTestId("integrations-filter-all")).toBeVisible();

  // AC-CN01 close: Esc returns to the shell.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("integrations-filter-all")).toBeHidden();
  await expect(page.getByTestId("integrations-entry")).toBeVisible();
});
