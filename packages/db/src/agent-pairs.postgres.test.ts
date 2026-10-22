import { randomUUID } from "node:crypto";
import {
  type BotId,
  parseBotId,
  parseSpaceId,
  parseUserId,
  RoundtableFeatureDisabledError,
  type RoundtableFeatureGates,
  type SpaceId,
  type UserId,
} from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_PAIR_GROUP_NAME,
  agentPairKey,
  CHAT_GROUP_KIND_AGENT_PAIR,
  CHAT_GROUP_KIND_STANDARD,
  createAgentPairRepository,
} from "./agent-pairs.js";
import type { PrismaClient } from "./client.js";
import { createGroupRepos } from "./groups.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";
import { IsolationError } from "./scope.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

const OPEN_GATES: RoundtableFeatureGates = Object.freeze({
  private_pair: true,
  public_collaboration: false,
  message_group: false,
  background_helper: false,
});

const CLOSED_GATES: RoundtableFeatureGates = Object.freeze({
  private_pair: false,
  public_collaboration: false,
  message_group: false,
  background_helper: false,
});

describePostgres("agent pair identity (PostgreSQL)", () => {
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let workspaceSeq = 0;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("agent_pairs");
    prisma = isolated.db.prisma;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  type Workspace = { userId: UserId; spaceId: SpaceId; botIds: BotId[] };

  async function newWorkspace(botCount: number): Promise<Workspace> {
    const label = `ap${++workspaceSeq}-${randomUUID().slice(0, 8)}`;
    const userId = parseUserId(`${label}-user`);
    const spaceId = parseSpaceId(`${label}-space`);
    await prisma.user.create({
      data: { id: userId, name: "AP owner", email: `${label}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id: label, name: "AP org", slug: label, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId: label, name: "AP space" } });
    await prisma.member.create({
      data: {
        id: `${label}-m`,
        organizationId: label,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: `${label}-sm`,
        spaceId,
        organizationId: label,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const botIds: BotId[] = [];
    for (let index = 0; index < botCount; index += 1) {
      const bot = await prisma.bot.create({
        data: { spaceId, userId, name: `${label}-bot-${index}`, color: "test" },
      });
      botIds.push(parseBotId(bot.id));
    }
    return { userId, spaceId, botIds };
  }

  function pairRows(spaceId: SpaceId) {
    return prisma.chatGroup.findMany({
      where: { spaceId, kind: CHAT_GROUP_KIND_AGENT_PAIR },
      select: {
        id: true,
        pairKey: true,
        name: true,
        thread: { select: { id: true } },
      },
    });
  }

  it("gives A→B, B→A and concurrent first contact one thread", async () => {
    const { userId, spaceId, botIds } = await newWorkspace(4);
    const [botA, botB, botC, botD] = botIds as [BotId, BotId, BotId, BotId];
    const repo = createAgentPairRepository(prisma, OPEN_GATES);

    const forward = await repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB });
    const reverse = await repo.getOrCreate({ spaceId, userId, botAId: botB, botBId: botA });
    expect(reverse).toEqual(forward);

    const [one, two] = await Promise.all([
      repo.getOrCreate({ spaceId, userId, botAId: botC, botBId: botD }),
      repo.getOrCreate({ spaceId, userId, botAId: botD, botBId: botC }),
    ]);
    expect(two).toEqual(one);

    const rows = await pairRows(spaceId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.pairKey).sort()).toEqual(
      [agentPairKey(botA, botB), agentPairKey(botC, botD)].sort(),
    );
    for (const row of rows) {
      expect(row.thread).not.toBeNull();
      expect(row.name).toBe(AGENT_PAIR_GROUP_NAME);
    }

    const members = await prisma.chatGroupMember.findMany({
      where: { groupId: forward.groupId },
      select: { botId: true },
    });
    expect(members.map((member) => member.botId).sort()).toEqual([botA, botB].sort());
  });

  it("lets the unordered pair index reject a writer that skips the Space lock", async () => {
    const { userId, spaceId, botIds } = await newWorkspace(2);
    const [botA, botB] = botIds as [BotId, BotId];
    const repo = createAgentPairRepository(prisma, OPEN_GATES);
    const created = await repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB });

    await expect(
      prisma.chatGroup.create({
        data: {
          spaceId,
          userId,
          name: "duplicate pair",
          kind: CHAT_GROUP_KIND_AGENT_PAIR,
          pairKey: agentPairKey(botB, botA),
        },
      }),
    ).rejects.toBeDefined();

    const rows = await pairRows(spaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(created.groupId);
  });

  it("leaves standard groups untouched by the pair constraint", async () => {
    const { userId, spaceId } = await newWorkspace(0);

    // `kind` is omitted on purpose: this is what every pre-migration row and
    // every current createGroup call writes.
    const first = await prisma.chatGroup.create({
      data: { spaceId, userId, name: "标准群一" },
      select: { id: true, kind: true, pairKey: true },
    });
    const second = await prisma.chatGroup.create({
      data: { spaceId, userId, name: "标准群二" },
      select: { id: true, kind: true, pairKey: true },
    });

    expect(first).toMatchObject({ kind: CHAT_GROUP_KIND_STANDARD, pairKey: null });
    expect(second).toMatchObject({ kind: CHAT_GROUP_KIND_STANDARD, pairKey: null });
    expect(first.id).not.toBe(second.id);
  });

  it("refuses a keyless pair, a keyed standard group and an unknown kind", async () => {
    const { userId, spaceId } = await newWorkspace(0);

    await expect(
      prisma.chatGroup.create({
        data: { spaceId, userId, name: "no key", kind: CHAT_GROUP_KIND_AGENT_PAIR },
      }),
    ).rejects.toBeDefined();

    await expect(
      prisma.chatGroup.create({
        data: {
          spaceId,
          userId,
          name: "keyed standard",
          kind: CHAT_GROUP_KIND_STANDARD,
          pairKey: agentPairKey("bot-x", "bot-y"),
        },
      }),
    ).rejects.toBeDefined();

    await expect(
      prisma.chatGroup.create({
        data: { spaceId, userId, name: "typo", kind: "agent-par", pairKey: "irrelevant" },
      }),
    ).rejects.toBeDefined();

    expect(await prisma.chatGroup.count({ where: { spaceId } })).toBe(0);
  });

  it("keeps pair identity across a rename, an avatar change and a group rename", async () => {
    const { userId, spaceId, botIds } = await newWorkspace(2);
    const [botA, botB] = botIds as [BotId, BotId];
    const repo = createAgentPairRepository(prisma, OPEN_GATES);
    const before = await repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB });

    await prisma.bot.update({
      where: { id: botA },
      data: {
        name: "改名后的 Joy",
        color: "#ff0000",
        avatarMode: "character",
        avatarCharacter: "dot",
        avatarBodyColor: "orange",
      },
    });
    await prisma.bot.update({ where: { id: botB }, data: { name: "换头像的小蓝" } });
    await prisma.chatGroup.update({
      where: { id: before.groupId },
      data: { name: "用户改过的群名" },
    });

    const after = await repo.getOrCreate({ spaceId, userId, botAId: botB, botBId: botA });

    expect(after).toEqual(before);
    expect(await pairRows(spaceId)).toHaveLength(1);
  });

  it("retains pair history and refuses new delivery once a member is deactivated", async () => {
    const { userId, spaceId, botIds } = await newWorkspace(2);
    const [botA, botB] = botIds as [BotId, BotId];
    const repo = createAgentPairRepository(prisma, OPEN_GATES);
    const created = await repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB });

    await prisma.bot.update({ where: { id: botB }, data: { archivedAt: new Date() } });

    await expect(
      repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB }),
    ).rejects.toBeInstanceOf(IsolationError);

    const rows = await pairRows(spaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(created.groupId);
    expect(rows[0]?.thread?.id).toBe(created.threadId);
    expect(await prisma.thread.count({ where: { id: created.threadId } })).toBe(1);
  });

  it("keeps the pair out of the group list, the group read and the send target", async () => {
    const { userId, spaceId, botIds } = await newWorkspace(2);
    const [botA, botB] = botIds as [BotId, BotId];
    const repo = createAgentPairRepository(prisma, OPEN_GATES);
    const created = await repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB });

    // A real user-managed group that must still be listed next to the hidden pair.
    const standard = await prisma.chatGroup.create({
      data: { spaceId, userId, name: "可见的普通群" },
      select: { id: true },
    });
    await prisma.chatGroupMember.createMany({
      data: [botA, botB].map((memberBotId) => ({ groupId: standard.id, botId: memberBotId })),
    });
    await prisma.thread.create({ data: { spaceId, userId, groupId: standard.id } });

    const groupRepos = createGroupRepos(prisma);
    const actor = { spaceId, userId, email: "ap@example.test", isDeploymentOwner: false };

    const listed = await groupRepos.listGroups(actor);
    expect(listed.map((group) => group.id)).toEqual([standard.id]);

    await expect(groupRepos.getGroup(actor, created.groupId)).rejects.toBeInstanceOf(
      IsolationError,
    );
    await expect(groupRepos.getGroupTarget(actor, created.groupId)).rejects.toBeInstanceOf(
      IsolationError,
    );
  });

  it("creates nothing while the private_pair gate is closed", async () => {
    const { userId, spaceId, botIds } = await newWorkspace(2);
    const [botA, botB] = botIds as [BotId, BotId];
    const repo = createAgentPairRepository(prisma, CLOSED_GATES);

    await expect(
      repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB }),
    ).rejects.toBeInstanceOf(RoundtableFeatureDisabledError);
    expect(await pairRows(spaceId)).toHaveLength(0);
  });
});
