import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_PAIR_GROUP_NAME,
  type AgentPair,
  agentPairKey,
  CHAT_GROUP_KIND_AGENT_PAIR,
  CHAT_GROUP_KIND_STANDARD,
  createAgentPairRepository,
} from "./agent-pairs.js";
import type { PrismaClient } from "./client.js";
import { clearThread } from "./events.js";
import { createGroupRepos } from "./groups.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";
import { createRepos } from "./repos.js";
import { IsolationError } from "./scope.js";

const PAIR_MIGRATION = "20261022000000_agent_pair_chat_groups";
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prisma/migrations",
);

function migrationNames() {
  return readdirSync(migrationsDir)
    .filter((name) => existsSync(path.join(migrationsDir, name, "migration.sql")))
    .sort();
}

async function applyMigrations(
  client: Client,
  shouldApply: (name: string) => boolean,
): Promise<void> {
  for (const name of migrationNames()) {
    if (!shouldApply(name)) continue;
    await client.query(readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8"));
  }
}

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

  type Workspace = {
    organizationId: string;
    userId: UserId;
    spaceId: SpaceId;
    botIds: BotId[];
  };

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
    return { organizationId: label, userId, spaceId, botIds };
  }

  async function addUserToSpace(workspace: Workspace, label: string) {
    const userId = parseUserId(`${label}-user`);
    await prisma.user.create({
      data: {
        id: userId,
        name: "AP intruder",
        email: `${label}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.member.create({
      data: {
        id: `${label}-m`,
        organizationId: workspace.organizationId,
        userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: `${label}-sm`,
        spaceId: workspace.spaceId,
        organizationId: workspace.organizationId,
        userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    return {
      spaceId: workspace.spaceId,
      userId,
      email: `${label}@example.test`,
      isDeploymentOwner: false,
    };
  }

  function actorFor(workspace: Workspace) {
    return {
      spaceId: workspace.spaceId,
      userId: workspace.userId,
      email: "ap@example.test",
      isDeploymentOwner: false,
    };
  }

  async function newPair() {
    const workspace = await newWorkspace(2);
    const [botAId, botBId] = workspace.botIds as [BotId, BotId];
    const pair = await createAgentPairRepository(prisma, OPEN_GATES).getOrCreate({
      spaceId: workspace.spaceId,
      userId: workspace.userId,
      botAId,
      botBId,
    });
    return { workspace, botAId, botBId, pair };
  }

  async function seedPairHistory(workspace: Workspace, pair: AgentPair, botId: BotId) {
    const message = await prisma.message.create({
      data: {
        threadId: pair.threadId,
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: "pair history" }],
        authorUserId: workspace.userId,
      },
    });
    const task = await prisma.task.create({
      data: {
        spaceId: workspace.spaceId,
        botId,
        threadId: pair.threadId,
        userId: workspace.userId,
        prompt: "pair task",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: workspace.spaceId,
        botId,
        threadId: pair.threadId,
        taskId: task.id,
        userId: workspace.userId,
        status: "completed",
        trigger: "user",
        sourceMessageId: message.id,
      },
    });
    return { message, task, run };
  }

  async function pairSnapshot(groupId: string) {
    return prisma.chatGroup.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        kind: true,
        pairKey: true,
        pinned: true,
        sectionId: true,
        leadBotId: true,
        archivedAt: true,
        updatedAt: true,
        members: {
          orderBy: { botId: "asc" },
          select: {
            id: true,
            createdAt: true,
            botId: true,
            bot: {
              select: {
                name: true,
                color: true,
                avatarMode: true,
                avatarCharacter: true,
                avatarBodyColor: true,
              },
            },
          },
        },
        thread: {
          select: {
            id: true,
            messages: { orderBy: { seq: "asc" }, select: { id: true, seq: true } },
            tasks: { select: { id: true } },
            runs: { select: { id: true } },
          },
        },
      },
    });
  }

  async function failure(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      return {
        name: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    throw new Error("expected the call to fail");
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

  it("lets the database reject duplicate pair rows and duplicate members", async () => {
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
    await expect(
      prisma.chatGroupMember.create({ data: { groupId: created.groupId, botId: botA } }),
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

  it("refuses updateGroup with a known pair id and leaves the pair untouched", async () => {
    const { workspace, pair, botAId } = await newPair();
    await seedPairHistory(workspace, pair, botAId);
    const before = await pairSnapshot(pair.groupId);
    const repos = createGroupRepos(prisma);

    await expect(
      repos.updateGroup(actorFor(workspace), {
        groupId: pair.groupId,
        name: "hijacked",
        botIds: workspace.botIds,
        pinned: true,
        sectionId: null,
      }),
    ).rejects.toBeInstanceOf(IsolationError);

    expect(await pairSnapshot(pair.groupId)).toEqual(before);
  });

  it("refuses archiveGroup with a known pair id and keeps archive, thread and history unchanged", async () => {
    const { workspace, pair, botAId } = await newPair();
    const history = await seedPairHistory(workspace, pair, botAId);
    const before = await pairSnapshot(pair.groupId);
    const repos = createGroupRepos(prisma);

    await expect(repos.archiveGroup(actorFor(workspace), pair.groupId)).rejects.toBeInstanceOf(
      IsolationError,
    );

    const after = await pairSnapshot(pair.groupId);
    expect(after).toEqual(before);
    expect(after?.archivedAt).toBeNull();
    expect(after?.thread?.messages.map((message) => message.id)).toEqual([history.message.id]);
    expect(after?.thread?.tasks.map((task) => task.id)).toEqual([history.task.id]);
    expect(after?.thread?.runs.map((run) => run.id)).toEqual([history.run.id]);
  });

  it("refuses restoreGroup with a known archived pair id", async () => {
    const { workspace, pair } = await newPair();
    const archivedAt = new Date("2026-10-01T00:00:00.000Z");
    await prisma.chatGroup.update({ where: { id: pair.groupId }, data: { archivedAt } });
    const before = await pairSnapshot(pair.groupId);
    const repos = createGroupRepos(prisma);

    await expect(repos.restoreGroup(actorFor(workspace), pair.groupId)).rejects.toBeInstanceOf(
      IsolationError,
    );

    const after = await pairSnapshot(pair.groupId);
    expect(after).toEqual(before);
    expect(after?.archivedAt?.toISOString()).toBe(archivedAt.toISOString());
  });

  it("refuses removeGroup with a known pair id and keeps every pair row", async () => {
    const { workspace, pair, botAId } = await newPair();
    await seedPairHistory(workspace, pair, botAId);
    const before = await pairSnapshot(pair.groupId);
    const repos = createGroupRepos(prisma);

    await expect(repos.removeGroup(actorFor(workspace), pair.groupId)).rejects.toBeInstanceOf(
      IsolationError,
    );

    expect(await pairSnapshot(pair.groupId)).toEqual(before);
  });

  it("keeps update, archive, restore and remove working for standard groups", async () => {
    const workspace = await newWorkspace(2);
    const actor = actorFor(workspace);
    const repos = createGroupRepos(prisma);
    const created = await repos.createGroup(actor, {
      name: "标准群",
      botIds: workspace.botIds,
    });

    expect(
      await prisma.chatGroup.findUnique({
        where: { id: created.id },
        select: { kind: true, pairKey: true },
      }),
    ).toEqual({ kind: CHAT_GROUP_KIND_STANDARD, pairKey: null });

    const updated = await repos.updateGroup(actor, {
      groupId: created.id,
      name: "改名后的标准群",
      pinned: true,
    });
    expect(updated.group).toMatchObject({ name: "改名后的标准群", pinned: true });

    await repos.archiveGroup(actor, created.id);
    expect(
      await prisma.chatGroup.findUnique({
        where: { id: created.id },
        select: { archivedAt: true, pinned: true },
      }),
    ).toMatchObject({ archivedAt: expect.any(Date), pinned: false });

    await repos.restoreGroup(actor, created.id);
    expect(
      await prisma.chatGroup.findUnique({
        where: { id: created.id },
        select: { archivedAt: true },
      }),
    ).toEqual({ archivedAt: null });

    await repos.removeGroup(actor, created.id);
    expect(await prisma.chatGroup.findUnique({ where: { id: created.id } })).toBeNull();
    expect(await prisma.thread.findUnique({ where: { id: created.threadId } })).toBeNull();
  });

  it("does not leak a pair to another user in the same space or to another space", async () => {
    const { workspace, pair } = await newPair();
    const sameSpaceIntruder = await addUserToSpace(
      workspace,
      `ap-intruder-${randomUUID().slice(0, 8)}`,
    );
    const otherSpaceActor = actorFor(await newWorkspace(0));
    const before = await pairSnapshot(pair.groupId);
    const repos = createGroupRepos(prisma);

    for (const actor of [sameSpaceIntruder, otherSpaceActor]) {
      const pairFailure = await failure(
        repos.updateGroup(actor, { groupId: pair.groupId, name: "stolen" }),
      );
      const missingFailure = await failure(
        repos.updateGroup(actor, { groupId: randomUUID(), name: "stolen" }),
      );
      expect(pairFailure).toEqual(missingFailure);
      expect(pairFailure.name).toBe("IsolationError");
    }

    expect(await pairSnapshot(pair.groupId)).toEqual(before);
  });

  it("keeps the other groupId write entries away from a pair", async () => {
    const { workspace, pair, botAId } = await newPair();
    await seedPairHistory(workspace, pair, botAId);
    const before = await pairSnapshot(pair.groupId);
    const actor = actorFor(workspace);

    await expect(
      createRepos(prisma).createBotSection(actor, {
        groupId: pair.groupId,
        name: "pair section",
      }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      clearThread(prisma, {
        spaceId: workspace.spaceId,
        threadId: pair.threadId,
        botId: botAId,
        groupId: pair.groupId,
      }),
    ).rejects.toBeInstanceOf(IsolationError);

    expect(await prisma.botSection.count({ where: { spaceId: workspace.spaceId } })).toBe(0);
    expect(await pairSnapshot(pair.groupId)).toEqual(before);
  });

  it("leaves standard group behaviour unchanged while the pair gate is closed", async () => {
    const workspace = await newWorkspace(2);
    const [botAId, botBId] = workspace.botIds as [BotId, BotId];
    const actor = actorFor(workspace);
    const closedPairs = createAgentPairRepository(prisma, CLOSED_GATES);

    await expect(
      closedPairs.getOrCreate({
        spaceId: workspace.spaceId,
        userId: workspace.userId,
        botAId,
        botBId,
      }),
    ).rejects.toBeInstanceOf(RoundtableFeatureDisabledError);
    expect(await prisma.chatGroup.count({ where: { spaceId: workspace.spaceId } })).toBe(0);

    const repos = createGroupRepos(prisma);
    const created = await repos.createGroup(actor, {
      name: "gate closed standard",
      botIds: workspace.botIds,
    });
    await repos.updateGroup(actor, { groupId: created.id, name: "still editable" });
    await repos.archiveGroup(actor, created.id);
    await repos.restoreGroup(actor, created.id);

    expect(
      await prisma.chatGroup.findUnique({
        where: { id: created.id },
        select: { name: true, archivedAt: true, kind: true },
      }),
    ).toEqual({ name: "still editable", archivedAt: null, kind: CHAT_GROUP_KIND_STANDARD });
  });
});

describePostgres("agent pair migration upgrade (PostgreSQL)", () => {
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let databaseUrl: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("agent_pairs_upgrade", { migrated: false });
    prisma = isolated.db.prisma;
    databaseUrl = isolated.databaseUrl;
    const client = new Client({
      connectionString: databaseUrl,
      application_name: "wp_pre_pair_migrate",
    });
    await client.connect();
    try {
      await applyMigrations(client, (name) => name < PAIR_MIGRATION);
    } finally {
      await client.end();
    }
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  it("preserves legacy standard groups and enforces the pair constraints after upgrade", async () => {
    const label = `mig${randomUUID().slice(0, 8)}`;
    const userId = parseUserId(`${label}-user`);
    const spaceId = parseSpaceId(`${label}-space`);
    const organizationId = label;
    await prisma.user.create({
      data: {
        id: userId,
        name: "Legacy owner",
        email: `${label}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Legacy org", slug: label, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Legacy space" },
    });
    await prisma.member.create({
      data: {
        id: `${label}-m`,
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: `${label}-sm`,
        spaceId,
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const botA = await prisma.bot.create({
      data: { spaceId, userId, name: `${label}-bot-a`, color: "test" },
    });
    const botB = await prisma.bot.create({
      data: { spaceId, userId, name: `${label}-bot-b`, color: "test" },
    });

    const groupId = `${label}-group`;
    const archivedGroupId = `${label}-archived`;
    const threadId = `${label}-thread`;
    const messageId = `${label}-message`;
    const taskId = `${label}-task`;
    const runId = `${label}-run`;
    const createdAt = new Date("2026-09-20T08:00:00.000Z");
    const updatedAt = new Date("2026-09-21T09:30:00.000Z");
    const archivedAt = new Date("2026-09-22T10:00:00.000Z");

    const client = new Client({
      connectionString: databaseUrl,
      application_name: "wp_pair_upgrade",
    });
    await client.connect();
    let legacyTimestamps: { updatedAt: string };
    let archivedTimestamps: { archivedAt: string | null };
    try {
      await client.query(
        `INSERT INTO "chat_groups"
           ("id", "spaceId", "userId", "name", "pinned", "leadBotId", "archivedAt", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [groupId, spaceId, userId, "迁移前标准群", true, botA.id, null, createdAt, updatedAt],
      );
      await client.query(
        `INSERT INTO "chat_groups"
           ("id", "spaceId", "userId", "name", "pinned", "leadBotId", "archivedAt", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          archivedGroupId,
          spaceId,
          userId,
          "迁移前归档群",
          false,
          botB.id,
          archivedAt,
          createdAt,
          updatedAt,
        ],
      );
      await client.query(
        `INSERT INTO "chat_group_members" ("id", "groupId", "botId", "createdAt")
         VALUES ($1, $2, $3, $4), ($5, $2, $6, $4)`,
        [`${label}-member-a`, groupId, botA.id, createdAt, `${label}-member-b`, botB.id],
      );
      await client.query(
        `INSERT INTO "chat_group_members" ("id", "groupId", "botId", "createdAt")
         VALUES ($1, $2, $3, $4)`,
        [`${label}-member-c`, archivedGroupId, botA.id, createdAt],
      );
      await client.query(
        `INSERT INTO "threads" ("id", "spaceId", "groupId", "userId", "createdAt")
         VALUES ($1, $2, $3, $4, $5)`,
        [threadId, spaceId, groupId, userId, createdAt],
      );
      await client.query(
        `INSERT INTO "messages" ("id", "threadId", "seq", "role", "blocks", "authorUserId", "createdAt")
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [
          messageId,
          threadId,
          1,
          "user",
          JSON.stringify([{ kind: "text", text: "迁移前的历史消息" }]),
          userId,
          createdAt,
        ],
      );
      await client.query(
        `INSERT INTO "tasks"
           ("id", "spaceId", "botId", "threadId", "userId", "prompt", "status", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          taskId,
          spaceId,
          botA.id,
          threadId,
          userId,
          "legacy prompt",
          "completed",
          createdAt,
          updatedAt,
        ],
      );
      await client.query(
        `INSERT INTO "runs"
           ("id", "spaceId", "botId", "threadId", "taskId", "userId", "status", "trigger", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          runId,
          spaceId,
          botA.id,
          threadId,
          taskId,
          userId,
          "completed",
          "user",
          createdAt,
          updatedAt,
        ],
      );

      legacyTimestamps = (
        await client.query<{ updatedAt: string }>(
          `SELECT "updatedAt"::text AS "updatedAt" FROM "chat_groups" WHERE id = $1`,
          [groupId],
        )
      ).rows[0]!;
      archivedTimestamps = (
        await client.query<{ archivedAt: string | null }>(
          `SELECT "archivedAt"::text AS "archivedAt" FROM "chat_groups" WHERE id = $1`,
          [archivedGroupId],
        )
      ).rows[0]!;

      // Apply the pair migration and anything after it so the schema matches
      // the generated Prisma client even when main has advanced.
      await applyMigrations(client, (name) => name >= PAIR_MIGRATION);
    } finally {
      await client.end();
    }

    const legacy = await prisma.chatGroup.findUniqueOrThrow({
      where: { id: groupId },
      select: {
        kind: true,
        pairKey: true,
        name: true,
        pinned: true,
        archivedAt: true,
        updatedAt: true,
        thread: {
          select: {
            id: true,
            messages: { select: { id: true } },
            tasks: { select: { id: true } },
            runs: { select: { id: true } },
          },
        },
      },
    });
    expect(legacy).toMatchObject({
      kind: CHAT_GROUP_KIND_STANDARD,
      pairKey: null,
      name: "迁移前标准群",
      pinned: true,
      archivedAt: null,
    });
    // Compare the stored timestamp text, not a JS Date: these columns are
    // timestamp(3) without time zone and Prisma/pg can disagree on the zone.
    const [legacyRaw] = await prisma.$queryRaw<Array<{ updatedAt: string }>>`
      SELECT "updatedAt"::text AS "updatedAt" FROM "chat_groups" WHERE id = ${groupId}
    `;
    expect(legacyRaw?.updatedAt).toBe(legacyTimestamps.updatedAt);
    expect(legacy.thread).toMatchObject({
      id: threadId,
      messages: [{ id: messageId }],
      tasks: [{ id: taskId }],
      runs: [{ id: runId }],
    });
    const archived = await prisma.chatGroup.findUniqueOrThrow({
      where: { id: archivedGroupId },
      select: { kind: true, pairKey: true, archivedAt: true },
    });
    expect(archived.kind).toBe(CHAT_GROUP_KIND_STANDARD);
    expect(archived.pairKey).toBeNull();
    const [archivedRaw] = await prisma.$queryRaw<Array<{ archivedAt: string | null }>>`
      SELECT "archivedAt"::text AS "archivedAt" FROM "chat_groups" WHERE id = ${archivedGroupId}
    `;
    expect(archivedRaw?.archivedAt).toBe(archivedTimestamps.archivedAt);

    const renamed = await prisma.chatGroup.update({
      where: { id: groupId },
      data: { name: "迁移后改名" },
    });
    expect(renamed).toMatchObject({ kind: CHAT_GROUP_KIND_STANDARD, pairKey: null });

    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'chat_groups_spaceId_pairKey_agent_pair'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toMatch(/UNIQUE INDEX/);
    expect(indexes[0]?.indexdef).toMatch(/WHERE .*kind.*agent_pair/);
    const checks = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = '"chat_groups"'::regclass AND contype = 'c'
    `;
    expect(checks.map((check) => check.conname).sort()).toEqual(
      expect.arrayContaining(["chat_groups_kind_chk", "chat_groups_pair_key_chk"]),
    );

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
          pairKey: "legacy-key",
        },
      }),
    ).rejects.toBeDefined();
    await expect(
      prisma.chatGroup.create({
        data: { spaceId, userId, name: "typo kind", kind: "agent-par", pairKey: "legacy-key" },
      }),
    ).rejects.toBeDefined();

    await prisma.chatGroup.create({
      data: {
        spaceId,
        userId,
        name: "pair",
        kind: CHAT_GROUP_KIND_AGENT_PAIR,
        pairKey: "upgrade-pair-key",
      },
    });
    await expect(
      prisma.chatGroup.create({
        data: {
          spaceId,
          userId,
          name: "pair duplicate",
          kind: CHAT_GROUP_KIND_AGENT_PAIR,
          pairKey: "upgrade-pair-key",
        },
      }),
    ).rejects.toBeDefined();
    await prisma.chatGroup.create({ data: { spaceId, userId, name: "标准群一" } });
    await prisma.chatGroup.create({ data: { spaceId, userId, name: "标准群二" } });
    expect(
      await prisma.chatGroup.count({ where: { spaceId, kind: CHAT_GROUP_KIND_STANDARD } }),
    ).toBe(4);
  });
});
