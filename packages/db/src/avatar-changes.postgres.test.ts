import { randomUUID } from "node:crypto";
import { AvatarCharacterSchema } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeBotAvatar, listBotAvatarChanges, undoBotAvatarChange } from "./avatar-changes.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("avatar change authorization and undo (PostgreSQL)", () => {
  let isolated: IsolatedPostgresDatabase;
  const userId = randomUUID();
  const outsiderId = randomUUID();
  const spaceId = randomUUID();
  const botId = randomUUID();
  const upload = "data:image/png;base64,YWJj";
  const actor = { userId, spaceId };
  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("avatar_changes");
    const db = isolated.db.prisma;
    await db.user.create({ data: { id: userId, name: "Owner", email: `${userId}@example.test` } });
    await db.user.create({
      data: { id: outsiderId, name: "Other", email: `${outsiderId}@example.test` },
    });
    await db.organization.create({
      data: { id: spaceId, name: "Avatar", slug: spaceId, createdAt: new Date() },
    });
    await db.space.create({ data: { id: spaceId, organizationId: spaceId, name: "Avatar" } });
    await db.bot.create({
      data: { id: botId, userId, spaceId, name: "Bot", color: upload, avatarMode: "upload" },
    });
  });
  afterAll(async () => isolated?.drop());

  it("records the exact upload for one-step undo and denies another user", async () => {
    const db = isolated.db.prisma;
    const change = await changeBotAvatar(db, {
      ...actor,
      botId,
      source: "user",
      choice: { avatarMode: "character", avatarCharacter: "wave", avatarBodyColor: "blue" },
    });
    expect(change).toMatchObject({
      source: "user",
      beforeMode: "upload",
      afterCharacter: "wave",
      beforeBodyColor: "ink",
      afterBodyColor: "blue",
    });
    await expect(
      undoBotAvatarChange(db, { userId: outsiderId, spaceId }, change!.id),
    ).rejects.toThrow();
    expect((await listBotAvatarChanges(db, actor, botId))[0]).toMatchObject({
      id: change!.id,
      beforeMode: "upload",
    });
    const undone = await undoBotAvatarChange(db, actor, change!.id);
    expect(undone.undoneAt).not.toBeNull();
    expect(await db.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
      avatarMode: "upload",
      color: upload,
      avatarBodyColor: "ink",
    });
    await expect(undoBotAvatarChange(db, actor, change!.id)).rejects.toThrow();
  });

  it("preserves the prior mode-only legacy transition for an uploaded image", async () => {
    const db = isolated.db.prisma;
    const changed = await changeBotAvatar(db, {
      ...actor,
      botId,
      source: "user",
      choice: { avatarMode: "legacy", color: upload },
    });
    expect(changed?.afterMode).toBe("legacy");
    expect(await db.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
      avatarMode: "legacy",
      color: upload,
    });
    await undoBotAvatarChange(db, actor, changed!.id);
  });

  it("keeps Bot retries idempotent and refuses stale undo after a newer change", async () => {
    const db = isolated.db.prisma;
    const first = await changeBotAvatar(db, {
      ...actor,
      botId,
      source: "bot",
      runId: "run-1",
      operationKey: "call-1",
      choice: { avatarMode: "character", avatarCharacter: "dot" },
    });
    const retried = await changeBotAvatar(db, {
      ...actor,
      botId,
      source: "bot",
      runId: "run-1",
      operationKey: "call-1",
      choice: { avatarMode: "character", avatarCharacter: "dot" },
    });
    expect(retried?.id).toBe(first?.id);
    const second = await changeBotAvatar(db, {
      ...actor,
      botId,
      source: "user",
      choice: { avatarMode: "character", avatarCharacter: "bounce" },
    });
    expect(await db.botAvatarChange.findUniqueOrThrow({ where: { id: first!.id } })).toMatchObject({
      beforeColor: "",
      afterColor: "",
    });
    await expect(undoBotAvatarChange(db, actor, first!.id)).rejects.toThrow();
    expect((await undoBotAvatarChange(db, actor, second!.id)).id).toBe(second!.id);
    expect(await db.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
      avatarMode: "character",
      avatarCharacter: "dot",
    });
  });

  it("retains at most 50 visible records while keeping Bot dedup tombstones", async () => {
    const db = isolated.db.prisma;
    for (let index = 0; index < 52; index++) {
      await changeBotAvatar(db, {
        ...actor,
        botId,
        source: "user",
        choice: { avatarMode: "character", avatarCharacter: index % 2 ? "wave" : "treble" },
      });
    }
    expect(
      await db.botAvatarChange.count({ where: { botId, operationKey: null } }),
    ).toBeLessThanOrEqual(50);
    expect(await listBotAvatarChanges(db, actor, botId)).toHaveLength(50);
  });

  it("keeps a metadata-only Bot operation tombstone after 50 later changes", async () => {
    const db = isolated.db.prisma;
    const current = await db.bot.findUniqueOrThrow({ where: { id: botId } });
    const requested = current.avatarCharacter === "wave" ? "dot" : "wave";
    const first = await changeBotAvatar(db, {
      ...actor,
      botId,
      source: "bot",
      runId: "old-run",
      operationKey: "old-avatar-tool-call",
      choice: { avatarMode: "character", avatarCharacter: requested },
    });
    for (let index = 0; index < 52; index++) {
      await changeBotAvatar(db, {
        ...actor,
        botId,
        source: "user",
        choice: {
          avatarMode: "character",
          avatarCharacter: index % 2 ? "treble" : "bounce",
        },
      });
    }
    const beforeRetry = await db.bot.findUniqueOrThrow({ where: { id: botId } });
    const retried = await changeBotAvatar(db, {
      ...actor,
      botId,
      source: "bot",
      runId: "old-run",
      operationKey: "old-avatar-tool-call",
      choice: { avatarMode: "character", avatarCharacter: requested },
    });
    expect(retried?.id).toBe(first?.id);
    expect(await db.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
      avatarMode: beforeRetry.avatarMode,
      avatarCharacter: beforeRetry.avatarCharacter,
    });
    expect(await db.botAvatarChange.findUniqueOrThrow({ where: { id: first!.id } })).toMatchObject({
      beforeColor: "",
      afterColor: "",
    });
    expect(await listBotAvatarChanges(db, actor, botId)).toHaveLength(50);
  });

  it("keeps a keyed no-op retry from restoring a stale avatar", async () => {
    const db = isolated.db.prisma;
    const current = await db.bot.findUniqueOrThrow({ where: { id: botId } });
    const requested = AvatarCharacterSchema.parse(current.avatarCharacter);
    const historyBefore = await listBotAvatarChanges(db, actor, botId);
    // The Bot requests the avatar it already has: a keyed no-op. Its result is
    // then "lost" (the run never observes it), and the user picks a new avatar.
    const noop = await changeBotAvatar(db, {
      ...actor,
      botId,
      source: "bot",
      runId: "run-noop",
      operationKey: "call-noop",
      choice: { avatarMode: "character", avatarCharacter: requested },
    });
    expect(noop).toBeNull();
    expect(await listBotAvatarChanges(db, actor, botId)).toHaveLength(historyBefore.length);
    const newer = requested === "wave" ? "dot" : "wave";
    const userChange = await changeBotAvatar(db, {
      ...actor,
      botId,
      source: "user",
      choice: { avatarMode: "character", avatarCharacter: newer },
    });
    // The retried no-op must stay a no-op: the user's newer choice wins, and
    // the invisible tombstone never becomes the undoable "latest" entry.
    const retried = await changeBotAvatar(db, {
      ...actor,
      botId,
      source: "bot",
      runId: "run-noop",
      operationKey: "call-noop",
      choice: { avatarMode: "character", avatarCharacter: requested },
    });
    expect(retried).toBeNull();
    expect(await db.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
      avatarMode: "character",
      avatarCharacter: newer,
    });
    expect((await undoBotAvatarChange(db, actor, userChange!.id)).id).toBe(userChange!.id);
    expect(await db.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
      avatarCharacter: requested,
    });
  });

  it("orders history and undo by serialized write order, not transaction-start time", async () => {
    const db = isolated.db.prisma;
    const base = await db.bot.findUniqueOrThrow({ where: { id: botId } });
    const firstCharacter = base.avatarCharacter === "wave" ? "treble" : "wave";
    const secondCharacter = firstCharacter === "treble" ? "dot" : "bounce";
    const older = await changeBotAvatar(db, {
      ...actor,
      botId,
      source: "user",
      choice: { avatarMode: "character", avatarCharacter: firstCharacter },
    });
    const newer = await changeBotAvatar(db, {
      ...actor,
      botId,
      source: "user",
      choice: { avatarMode: "character", avatarCharacter: secondCharacter },
    });
    // Emulate an executor transaction that started earlier but committed last:
    // its write is the true newest one, yet its transaction-start timestamp
    // sorts behind the Studio change that committed before it.
    await db.botAvatarChange.update({
      where: { id: newer!.id },
      data: { createdAt: new Date(Date.now() - 3_600_000) },
    });
    const history = await listBotAvatarChanges(db, actor, botId);
    expect(history[0]!.id).toBe(newer!.id);
    expect(history[1]!.id).toBe(older!.id);
    expect((await undoBotAvatarChange(db, actor, newer!.id)).id).toBe(newer!.id);
    expect(await db.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
      avatarCharacter: firstCharacter,
    });
  });

  it("never exposes another user's change list and deletes audit with the Bot", async () => {
    const db = isolated.db.prisma;
    await expect(
      listBotAvatarChanges(db, { userId: outsiderId, spaceId }, botId),
    ).rejects.toThrow();
    expect(await db.botAvatarChange.count({ where: { botId } })).toBeGreaterThan(0);
    await db.bot.delete({ where: { id: botId } });
    expect(await db.botAvatarChange.count({ where: { botId } })).toBe(0);
  });
});
