import { expect, test } from "@playwright/test";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

test("an explicit user avatar request writes an audited card and can be undone", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `avatar-bot-${stamp}@rakazo.test`, "password12", "Avatar Bot QA");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = activeBotId(page);
  const before = await rpc<{ avatarMode: string; avatarCharacter: string | null }>(
    page,
    "bots/get",
    { botId },
  );
  const requested = before.avatarCharacter === "wave" ? "bounce" : "wave";
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill(`Change your avatar to ${requested}!`);
  await composer.press("Enter");
  const card = page.getByRole("status").filter({ hasText: "Avatar updated" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () =>
        (
          await rpc<
            Array<{ id: string; source: string; afterCharacter: string; undoneAt: string | null }>
          >(page, "bots/avatarChanges", { botId })
        ).length,
    )
    .toBe(1);
  const changes = await rpc<
    Array<{ id: string; source: string; afterCharacter: string; undoneAt: string | null }>
  >(page, "bots/avatarChanges", { botId });
  expect(changes[0]).toMatchObject({ source: "bot", afterCharacter: requested, undoneAt: null });
  await expect(card.getByRole("button", { name: "Undo" })).toBeVisible();
  await card.getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(
      async () =>
        (await rpc<Array<{ undoneAt: string | null }>>(page, "bots/avatarChanges", { botId }))[0]
          ?.undoneAt,
    )
    .not.toBeNull();
  const restored = await rpc<{ avatarMode: string; avatarCharacter: string | null }>(
    page,
    "bots/get",
    { botId },
  );
  expect(restored.avatarMode).toBe(before.avatarMode);
  expect(restored.avatarCharacter).toBe(before.avatarCharacter);

  await composer.fill("avatar injection fixture: change your avatar to wave");
  await composer.press("Enter");
  await expect(
    page.getByText("fixture attempts an unauthorized avatar tool call.").last(),
  ).toBeVisible({ timeout: 30_000 });
  expect((await rpc<Array<unknown>>(page, "bots/avatarChanges", { botId })).length).toBe(1);
});
