import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("legacy avatar conversion (PostgreSQL)", () => {
  let isolated: IsolatedPostgresDatabase;
  const ids = [randomUUID(), randomUUID()];
  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("avatar_conversion");
  });
  afterAll(async () => isolated?.drop());

  it("converts non-image rows deterministically and leaves uploads and colors intact", async () => {
    const db = isolated.db.prisma;
    const userId = randomUUID();
    const spaceId = randomUUID();
    await db.user.create({ data: { id: userId, name: "Avatar", email: `${userId}@example.test` } });
    await db.organization.create({
      data: { id: spaceId, name: "Avatar", slug: spaceId, createdAt: new Date() },
    });
    await db.space.create({ data: { id: spaceId, organizationId: spaceId, name: "Avatar" } });
    await db.bot.create({
      data: {
        id: ids[0],
        userId,
        spaceId,
        name: "Legacy",
        color: "#0a0a0c::bloub::nuage::joie",
        avatarMode: "legacy",
      },
    });
    await db.bot.create({
      data: {
        id: ids[1],
        userId,
        spaceId,
        name: "Upload",
        color: "data:image/png;base64,abc",
        avatarMode: "legacy",
      },
    });
    const sql = readFileSync(
      new URL(
        "../prisma/migrations/20261017020000_convert_legacy_bot_avatars/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.$executeRawUnsafe(sql);
    const first = await db.bot.findUniqueOrThrow({ where: { id: ids[0] } });
    const second = await db.bot.findUniqueOrThrow({ where: { id: ids[1] } });
    expect(first.avatarMode).toBe("character");
    expect(["dot", "treble", "wave", "bounce"]).toContain(first.avatarCharacter);
    expect(first.color).toBe("#0a0a0c::bloub::nuage::joie");
    expect(second).toMatchObject({
      avatarMode: "upload",
      avatarCharacter: null,
      color: "data:image/png;base64,abc",
    });
    await db.$executeRawUnsafe(sql);
    expect(await db.bot.findUniqueOrThrow({ where: { id: ids[0] } })).toMatchObject({
      avatarMode: first.avatarMode,
      avatarCharacter: first.avatarCharacter,
    });
  });
  it("backfills populated pre-v0.7 rows as ink and preserves later colors on replay", async () => {
    const db = isolated.db.prisma;
    await db.$executeRawUnsafe('ALTER TABLE "bots" DROP COLUMN "avatarBodyColor"');
    await db.$executeRawUnsafe(
      'ALTER TABLE "bot_avatar_changes" DROP COLUMN "beforeBodyColor", DROP COLUMN "afterBodyColor"',
    );
    const sql = readFileSync(
      new URL(
        "../prisma/migrations/20261019120000_avatar_body_color/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const apply = async () => {
      for (const statement of sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await db.$executeRawUnsafe(statement);
    };
    await apply();
    expect((await db.bot.findUniqueOrThrow({ where: { id: ids[0] } })).avatarBodyColor).toBe("ink");
    await db.bot.update({ where: { id: ids[0] }, data: { avatarBodyColor: "pink" } });
    await apply();
    expect((await db.bot.findUniqueOrThrow({ where: { id: ids[0] } })).avatarBodyColor).toBe(
      "pink",
    );
  });
});
