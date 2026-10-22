import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  IsolationError,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactListCursorError, listGroupArtifacts } from "./artifacts.js";
import { listGroupMembers, listGroupRoutines } from "./group-queries.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

type Owner = {
  organizationId: string;
  userId: string;
  spaceId: string;
  actor: Actor;
};

describePostgres("group-scoped queries (PostgreSQL)", () => {
  let isolated: IsolatedPostgresDatabase;
  let prisma: IsolatedPostgresDatabase["db"]["prisma"];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("group_queries");
    prisma = isolated.db.prisma;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  async function createOwner(label: string): Promise<Owner> {
    const id = `gq-${label}-${randomUUID().slice(0, 8)}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    await prisma.user.create({
      data: { id: userId, name: "Owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Group queries", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId: id, name: "Group queries" } });
    await prisma.member.create({
      data: {
        id: `${id}-member`,
        organizationId: id,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: `${id}-sm`,
        spaceId,
        organizationId: id,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    return {
      organizationId: id,
      userId,
      spaceId,
      actor: { userId, spaceId, email: `${id}@example.test`, isDeploymentOwner: false },
    };
  }

  async function addUser(owner: Owner, label: string) {
    const id = `gq-${label}-${randomUUID().slice(0, 8)}`;
    const userId = `${id}-user`;
    await prisma.user.create({
      data: { id: userId, name: "Other user", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.member.create({
      data: {
        id: `${id}-member`,
        organizationId: owner.organizationId,
        userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    return userId;
  }

  async function createGroup(owner: Owner, label: string) {
    const botA = await prisma.bot.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: `${label} Alpha`,
        color: "#111111",
        avatarMode: "character",
        avatarCharacter: "wave",
        avatarBodyColor: "blue",
      },
    });
    const botB = await prisma.bot.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: `${label} Beta`,
        color: "#222222",
        avatarMode: "legacy",
        avatarCharacter: null,
        avatarBodyColor: "ink",
      },
    });
    const group = await prisma.chatGroup.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, name: label, leadBotId: botA.id },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, groupId: group.id },
    });
    // Distinct timestamps keep the member order deterministic: getGroupTarget
    // sorts by createdAt before botId.
    await prisma.chatGroupMember.create({
      data: {
        groupId: group.id,
        botId: botA.id,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    await prisma.chatGroupMember.create({
      data: {
        groupId: group.id,
        botId: botB.id,
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      },
    });
    return { group, thread, botA, botB };
  }

  async function createArtifact(input: {
    owner: Owner;
    botId: string | null;
    groupId: string | null;
    name: string;
    createdAt: Date;
    rootArtifactId?: string;
    version?: number;
  }) {
    return prisma.artifact.create({
      data: {
        spaceId: input.owner.spaceId,
        userId: input.owner.userId,
        botId: input.botId,
        groupId: input.groupId,
        name: input.name,
        mimeType: "text/plain",
        size: 1,
        hash: `hash-${randomUUID()}`,
        storageKey: `key-${randomUUID()}`,
        createdAt: input.createdAt,
        rootArtifactId: input.rootArtifactId,
        version: input.version ?? 1,
      },
    });
  }

  async function createRoutine(input: {
    owner: Owner;
    botId: string;
    threadId: string | null;
    name: string;
    createdAt?: Date;
  }) {
    return prisma.routine.create({
      data: {
        spaceId: input.owner.spaceId,
        userId: input.owner.userId,
        botId: input.botId,
        threadId: input.threadId,
        name: input.name,
        prompt: `Prompt for ${input.name}`,
        crons: ["0 9 * * *"],
        timezone: "UTC",
        active: true,
        createdAt: input.createdAt,
      },
    });
  }

  it("pages only artifacts stamped with the requested group", async () => {
    const owner = await createOwner("artifacts");
    const group = await createGroup(owner, "Artifact group");
    const other = await createGroup(owner, "Other group");
    const root = await createArtifact({
      owner,
      botId: group.botA.id,
      groupId: group.group.id,
      name: "First family",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    await createArtifact({
      owner,
      botId: group.botA.id,
      groupId: group.group.id,
      name: "First family v2",
      createdAt: new Date("2026-09-03T00:00:00.000Z"),
      rootArtifactId: root.id,
      version: 2,
    });
    await createArtifact({
      owner,
      botId: group.botB.id,
      groupId: group.group.id,
      name: "Second family",
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
    });
    await createArtifact({
      owner,
      botId: group.botA.id,
      groupId: other.group.id,
      name: "Other group file",
      createdAt: new Date("2026-09-04T00:00:00.000Z"),
    });
    await createArtifact({
      owner,
      botId: group.botA.id,
      groupId: null,
      name: "Private Bot file",
      createdAt: new Date("2026-09-05T00:00:00.000Z"),
    });

    const first = await listGroupArtifacts({ prisma }, owner.actor, {
      groupId: group.group.id,
      limit: 1,
    });

    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      id: root.id,
      name: "First family v2",
      version: 2,
      versionCount: 2,
      groupId: group.group.id,
    });
    expect(first.nextCursor).not.toBeNull();

    const second = await listGroupArtifacts({ prisma }, owner.actor, {
      groupId: group.group.id,
      cursor: first.nextCursor ?? undefined,
      limit: 1,
    });
    expect(second.items.map((item) => item.name)).toEqual(["Second family"]);
    expect(second.nextCursor).toBeNull();

    const all = await listGroupArtifacts({ prisma }, owner.actor, { groupId: group.group.id });
    expect(all.items.map((item) => item.name)).toEqual(["First family v2", "Second family"]);
    expect(all.items.some((item) => item.name === "Other group file")).toBe(false);
    expect(all.items.some((item) => item.name === "Private Bot file")).toBe(false);

    await expect(
      listGroupArtifacts({ prisma }, owner.actor, {
        groupId: other.group.id,
        cursor: first.nextCursor ?? undefined,
      }),
    ).rejects.toBeInstanceOf(ArtifactListCursorError);
  });

  it("returns only routines bound to the group thread and names the executing Bot", async () => {
    const owner = await createOwner("routines");
    const group = await createGroup(owner, "Routine group");
    const stranger = await prisma.bot.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, name: "Stranger", color: "#333333" },
    });
    const privateThread = await prisma.thread.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, botId: group.botA.id },
    });
    const older = await createRoutine({
      owner,
      botId: group.botB.id,
      threadId: group.thread.id,
      name: "Older group routine",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    const newer = await createRoutine({
      owner,
      botId: group.botA.id,
      threadId: group.thread.id,
      name: "Newer group routine",
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
    });
    await createRoutine({
      owner,
      botId: stranger.id,
      threadId: group.thread.id,
      name: "Removed Bot routine",
    });
    await createRoutine({
      owner,
      botId: group.botA.id,
      threadId: privateThread.id,
      name: "Private thread routine",
    });
    await createRoutine({
      owner,
      botId: group.botA.id,
      threadId: null,
      name: "Unbound routine",
    });

    const routines = await listGroupRoutines({ prisma }, owner.actor, group.group.id);

    expect(routines.map((routine) => routine.name)).toEqual([
      "Newer group routine",
      "Older group routine",
    ]);
    expect(routines.map((routine) => routine.id)).toEqual([newer.id, older.id]);
    expect(routines[0]).toMatchObject({
      botId: group.botA.id,
      threadId: group.thread.id,
      executorBot: {
        kind: "agent",
        botId: group.botA.id,
        avatarMode: "character",
        avatarCharacter: "wave",
        avatarBodyColor: "blue",
      },
    });
    expect(routines[1]?.executorBot).toMatchObject({
      kind: "agent",
      botId: group.botB.id,
      avatarMode: "legacy",
    });
  });

  it("separates the current user from the Agents and never counts the user as an Agent", async () => {
    const owner = await createOwner("members");
    const group = await createGroup(owner, "Member group");
    await prisma.user.update({
      where: { id: owner.userId },
      data: { name: "Rivers", avatarStyle: "organic" },
    });

    const members = await listGroupMembers({ prisma }, owner.actor, group.group.id);

    expect(members.currentUser).toEqual({
      kind: "user",
      userId: owner.userId,
      name: "Rivers",
      image: null,
      avatarStyle: "organic",
    });
    expect(members.agents.map((agent) => agent.botId)).toEqual([group.botA.id, group.botB.id]);
    expect(members.agentCount).toBe(2);
    expect(members.memberCount).toBe(3);
    expect(members.agents.every((agent) => agent.kind === "agent")).toBe(true);
  });

  it("rejects cross-space, cross-user, archived, and threadless groups", async () => {
    const owner = await createOwner("authorization");
    const group = await createGroup(owner, "Authorized group");
    const otherSpace = await createOwner("other-space");
    const otherUser = await addUser(owner, "same-space");

    for (const actor of [otherSpace.actor, { ...owner.actor, userId: otherUser }]) {
      await expect(
        listGroupArtifacts({ prisma }, actor, { groupId: group.group.id }),
      ).rejects.toBeInstanceOf(IsolationError);
      await expect(listGroupRoutines({ prisma }, actor, group.group.id)).rejects.toBeInstanceOf(
        IsolationError,
      );
      await expect(listGroupMembers({ prisma }, actor, group.group.id)).rejects.toBeInstanceOf(
        IsolationError,
      );
    }

    await prisma.chatGroup.update({
      where: { id: group.group.id },
      data: { archivedAt: new Date() },
    });
    await expect(listGroupMembers({ prisma }, owner.actor, group.group.id)).rejects.toBeInstanceOf(
      IsolationError,
    );

    await prisma.chatGroup.update({
      where: { id: group.group.id },
      data: { archivedAt: null },
    });
    // A group without its Thread is unreachable; keep the group row but drop
    // its thread (the threads_owner_chk constraint forbids a bare ownerless thread).
    await prisma.thread.delete({ where: { id: group.thread.id } });
    await expect(
      listGroupArtifacts({ prisma }, owner.actor, { groupId: group.group.id }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(listGroupRoutines({ prisma }, owner.actor, group.group.id)).rejects.toBeInstanceOf(
      IsolationError,
    );
    await expect(listGroupMembers({ prisma }, owner.actor, group.group.id)).rejects.toBeInstanceOf(
      IsolationError,
    );
  });
});
