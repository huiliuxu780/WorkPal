import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";
import { createRepos } from "./repos.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("Bot character assignment (PostgreSQL)", () => {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const spaceA = randomUUID();
  const spaceB = randomUUID();
  let isolated: IsolatedPostgresDatabase;

  const actor = (id: string, spaceId: string): Actor => ({
    userId: id,
    spaceId,
    email: `${id}@example.test`,
    isDeploymentOwner: false,
  });
  const profile = (name: string) => ({
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("avatar_assignment");
    const db = isolated.db.prisma;
    for (const id of [userId, otherUserId]) {
      await db.user.create({ data: { id, name: "Avatar test", email: `${id}@example.test` } });
    }
    await db.organization.create({
      data: {
        id: organizationId,
        name: "Avatar test",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    for (const spaceId of [spaceA, spaceB]) {
      await db.space.create({ data: { id: spaceId, organizationId, name: "Avatar test" } });
    }
    for (const id of [userId, otherUserId]) {
      await db.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: id,
          role: "member",
          createdAt: new Date(),
        },
      });
      for (const spaceId of [spaceA, spaceB]) {
        await db.spaceMember.create({
          data: { id: randomUUID(), spaceId, organizationId, userId: id, createdAt: new Date() },
        });
      }
    }
  });

  afterAll(async () => {
    await isolated?.drop();
  });

  it("assigns four distinct characters across Spaces, including concurrent creates", async () => {
    const repos = createRepos(isolated.db.prisma);
    const first = await repos.createBot(actor(userId, spaceA), profile("First"));
    const second = await repos.createBot(actor(userId, spaceB), profile("Second"));
    const [third, fourth] = await Promise.all([
      repos.createBot(actor(userId, spaceA), profile("Third")),
      repos.createBot(actor(userId, spaceB), profile("Fourth")),
    ]);
    await isolated.db.prisma.bot.update({
      where: { id: first.id },
      data: { archivedAt: new Date() },
    });
    const fifth = await repos.createBot(actor(userId, spaceA), profile("Fifth"));
    const sixth = await repos.createBot(actor(userId, spaceB), profile("Sixth"));
    expect(
      new Set([first, second, third, fourth, fifth, sixth].map((bot) => bot.avatarBodyColor)).size,
    ).toBe(6);
    const bots = [first, second, third, fourth];
    expect(new Set(bots.map((bot) => bot.avatarCharacter)).size).toBe(4);
    expect(bots.every((bot) => bot.avatarMode === "character")).toBe(true);
    expect(new Set(bots.map((bot) => bot.id)).size).toBe(4);

    // Another user has an independent four-character allocation pool.
    const other = await repos.createBot(actor(otherUserId, spaceA), profile("Other user's first"));
    expect(other.avatarMode).toBe("character");
    const otherRows = await isolated.db.prisma.bot.findMany({ where: { userId: otherUserId } });
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0]?.avatarCharacter).toBe(other.avatarCharacter);
  });

  it("retains old color/image rows and preserves explicit upload and character choices", async () => {
    const db = isolated.db.prisma;
    const legacyImage = "data:image/png;base64,abc";
    const old = await db.bot.create({
      data: { spaceId: spaceA, userId, name: "Old upload", color: legacyImage },
    });
    expect(old).toMatchObject({
      avatarMode: "legacy",
      avatarCharacter: null,
      color: legacyImage,
    });
    const repos = createRepos(db);
    const upload = await repos.createBot(actor(userId, spaceA), {
      ...profile("New upload"),
      color: legacyImage,
    });
    expect(upload).toMatchObject({
      avatarMode: "upload",
      avatarCharacter: null,
      color: legacyImage,
    });
    const chosen = await repos.createBot(actor(userId, spaceA), {
      ...profile("Chosen wave"),
      avatarMode: "character",
      avatarCharacter: "wave",
    });
    expect(chosen).toMatchObject({ avatarMode: "character", avatarCharacter: "wave" });
    const stored = await db.bot.findUniqueOrThrow({ where: { id: chosen.id } });
    expect(stored.avatarCharacter).toBe("wave");
    const duplicate = await repos.createBot(actor(userId, spaceA), {
      ...profile("Duplicate wave"),
      color: chosen.color,
      avatarMode: chosen.avatarMode,
      avatarCharacter: chosen.avatarCharacter,
    });
    expect(duplicate).toMatchObject({
      avatarMode: "character",
      avatarCharacter: "wave",
      color: chosen.color,
    });
  });

  it("counts archived character Bots when assigning a new one", async () => {
    const db = isolated.db.prisma;
    const repos = createRepos(db);
    const archived = await repos.createBot(actor(otherUserId, spaceB), {
      ...profile("Archived dot"),
      avatarMode: "character",
      avatarCharacter: "dot",
    });
    await db.bot.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    const next = await repos.createBot(actor(otherUserId, spaceB), profile("After archive"));
    expect(next.avatarCharacter).not.toBe("dot");
  });
});
