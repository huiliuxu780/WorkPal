import { randomUUID } from "node:crypto";
import {
  agentPairKey,
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  type PrismaClient,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { teammateDirectoryForThread } from "./executor.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

/**
 * RT-05: a delegated run executing in an agent_pair Thread keeps the Space's
 * teammate directory (B must be able to discover C for B → C), while standard
 * groups keep hiding it. The directory never crosses users, Spaces, archived
 * bots, or bots without a chat.
 */
describePostgres("teammate directory by thread kind (PostgreSQL)", () => {
  const id = randomUUID();
  const foreignUserId = `foreign-${randomUUID()}`;
  const otherSpaceId = `space-${randomUUID()}`;
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let senderId: string;
  let researcherId: string;
  let writerId: string;
  let dmThreadId: string;
  let pairThreadId: string;
  let standardThreadId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("botdir");
    prisma = isolated.db.prisma;
    await prisma.user.create({
      data: { id, name: "Directory owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.user.create({
      data: {
        id: foreignUserId,
        name: "Foreign owner",
        email: `${foreignUserId}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id, name: "Directory org", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Directory space" } });
    await prisma.space.create({
      data: { id: otherSpaceId, organizationId: id, name: "Other space" },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: {
        id,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const makeBot = async (
      name: string,
      extra: Record<string, unknown> = {},
      withThread = true,
    ) => {
      const bot = await prisma.bot.create({
        data: { spaceId: id, userId: id, name, color: "test", ...extra },
      });
      if (withThread) {
        await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
      }
      return bot.id;
    };
    senderId = await makeBot("Sender");
    researcherId = await makeBot("Researcher");
    writerId = await makeBot("Writer");
    // Excluded rosters: archived, foreign user (same Space), other Space, chatless.
    await makeBot("ArchivedPeer", { archivedAt: new Date() });
    const foreignBot = await prisma.bot.create({
      data: { spaceId: id, userId: foreignUserId, name: "ForeignPeer", color: "test" },
    });
    await prisma.thread.create({
      data: { spaceId: id, userId: foreignUserId, botId: foreignBot.id },
    });
    const otherSpaceBot = await prisma.bot.create({
      data: { spaceId: otherSpaceId, userId: id, name: "OtherSpacePeer", color: "test" },
    });
    await prisma.thread.create({
      data: { spaceId: otherSpaceId, userId: id, botId: otherSpaceBot.id },
    });
    await makeBot("Chatless", {}, false);

    dmThreadId = (
      await prisma.thread.findFirstOrThrow({ where: { botId: researcherId } })
    ).id;

    const pairGroup = await prisma.chatGroup.create({
      data: {
        spaceId: id,
        userId: id,
        kind: "agent_pair",
        name: "pair",
        pairKey: agentPairKey(senderId, researcherId),
      },
    });
    await prisma.chatGroupMember.create({ data: { groupId: pairGroup.id, botId: senderId } });
    await prisma.chatGroupMember.create({ data: { groupId: pairGroup.id, botId: researcherId } });
    pairThreadId = (
      await prisma.thread.create({ data: { spaceId: id, userId: id, groupId: pairGroup.id } })
    ).id;

    const standardGroup = await prisma.chatGroup.create({
      data: { spaceId: id, userId: id, kind: "standard", name: "team" },
    });
    for (const botId of [senderId, researcherId, writerId]) {
      await prisma.chatGroupMember.create({ data: { groupId: standardGroup.id, botId } });
    }
    standardThreadId = (
      await prisma.thread.create({
        data: { spaceId: id, userId: id, groupId: standardGroup.id },
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  const threadOf = async (threadId: string) =>
    prisma.thread.findUniqueOrThrow({
      where: { id: threadId },
      include: { group: { select: { kind: true } } },
    });

  it("keeps the directory for a delegated run in its pair Thread", async () => {
    const directory = await teammateDirectoryForThread(prisma, {
      thread: await threadOf(pairThreadId),
      botId: researcherId,
      spaceId: id,
      userId: id,
    });
    expect(directory).toBeDefined();
    // B discovers the requester and the further teammate C — the B → C path.
    expect(directory).toContain("Sender");
    expect(directory).toContain("Writer");
    // Roster scoping holds: no archived, foreign-user, other-Space, or chatless bots.
    expect(directory).not.toContain("ArchivedPeer");
    expect(directory).not.toContain("ForeignPeer");
    expect(directory).not.toContain("OtherSpacePeer");
    expect(directory).not.toContain("Chatless");
  });

  it("keeps the directory in a DM and hides it in standard groups", async () => {
    expect(
      await teammateDirectoryForThread(prisma, {
        thread: await threadOf(dmThreadId),
        botId: researcherId,
        spaceId: id,
        userId: id,
      }),
    ).toContain("Writer");
    expect(
      await teammateDirectoryForThread(prisma, {
        thread: await threadOf(standardThreadId),
        botId: writerId,
        spaceId: id,
        userId: id,
      }),
    ).toBeUndefined();
  });
});
