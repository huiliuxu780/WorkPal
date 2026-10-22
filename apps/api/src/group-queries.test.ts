import type { Actor } from "@rakazo/contracts";
import { parseGroupMembersSummary, parseGroupQuery, parseGroupRoutineSummary } from "@rakazo/core";
import { IsolationError, type PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createGroupPanelQueries } from "./group-queries.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.com",
  isDeploymentOwner: false,
};

function groupQuery(groupId = "group-1") {
  return parseGroupQuery({
    actor: { kind: "user", userId: actor.userId, spaceId: actor.spaceId },
    groupId,
  });
}

function groupTarget(
  overrides: {
    id?: string;
    threadId?: string | null;
    members?: Array<{
      id: string;
      name: string;
      color: string;
      avatarMode: string;
      avatarCharacter: string | null;
      avatarBodyColor: string;
      runs: Array<{ status: string }>;
    }>;
  } = {},
) {
  const members = overrides.members ?? [
    {
      id: "bot-1",
      name: "Alpha",
      color: "#111111",
      avatarMode: "character",
      avatarCharacter: "wave",
      avatarBodyColor: "blue",
      runs: [{ status: "working" }],
    },
    {
      id: "bot-2",
      name: "Beta",
      color: "#222222",
      avatarMode: "legacy",
      avatarCharacter: null,
      avatarBodyColor: "ink",
      runs: [],
    },
  ];
  return {
    id: overrides.id ?? "group-1",
    thread: overrides.threadId === null ? null : { id: overrides.threadId ?? "thread-1" },
    members: members.map((bot) => ({ bot })),
  };
}

function routineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "routine-1",
    botId: "bot-1",
    threadId: "thread-1",
    name: "Morning digest",
    prompt: "Summarize the day",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    lastRunAt: new Date("2026-10-20T09:00:00.000Z"),
    nextRunAt: new Date("2026-10-23T09:00:00.000Z"),
    createdAt: new Date("2026-10-19T00:00:00.000Z"),
    ...overrides,
  };
}

function queryDeps(input: { group: unknown; routines?: unknown[]; user?: unknown }) {
  const chatGroupFindFirst = vi.fn().mockResolvedValue(input.group);
  const routineFindMany = vi.fn().mockResolvedValue(input.routines ?? []);
  const userFindFirst = vi.fn().mockResolvedValue(input.user ?? null);
  return {
    chatGroupFindFirst,
    routineFindMany,
    userFindFirst,
    deps: {
      prisma: {
        chatGroup: { findFirst: chatGroupFindFirst },
        routine: { findMany: routineFindMany },
        user: { findFirst: userFindFirst },
      } as unknown as PrismaClient,
    },
  };
}

const currentUser = {
  id: "user-1",
  name: "Rivers",
  image: null,
  avatarStyle: "organic",
};

describe("GroupQueries.listRoutines", () => {
  it("binds routines to the group thread and keeps each executing Bot", async () => {
    const { deps, chatGroupFindFirst, routineFindMany } = queryDeps({
      group: groupTarget(),
      routines: [
        routineRow({ id: "routine-a", botId: "bot-1" }),
        routineRow({ id: "routine-b", botId: "bot-2" }),
      ],
    });

    const result = await createGroupPanelQueries(deps).listRoutines(groupQuery());

    expect(chatGroupFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "group-1",
          spaceId: actor.spaceId,
          userId: actor.userId,
          archivedAt: null,
        },
      }),
    );
    expect(routineFindMany).toHaveBeenCalledWith({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        threadId: "thread-1",
        botId: { in: ["bot-1", "bot-2"] },
        bot: { archivedAt: null },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(result.map((routine) => routine.id)).toEqual(["routine-a", "routine-b"]);
    expect(result[0]).toMatchObject({
      id: "routine-a",
      botId: "bot-1",
      threadId: "thread-1",
      nextRunAt: "2026-10-23T09:00:00.000Z",
      executorBot: {
        kind: "agent",
        botId: "bot-1",
        name: "Alpha",
        color: "#111111",
        avatarMode: "character",
        avatarCharacter: "wave",
        avatarBodyColor: "blue",
      },
    });
    expect(result[1]?.executorBot).toMatchObject({
      kind: "agent",
      botId: "bot-2",
      name: "Beta",
      avatarMode: "legacy",
      avatarCharacter: null,
      avatarBodyColor: "ink",
    });
    expect(result.every((routine) => routine.threadId === "thread-1")).toBe(true);
    for (const routine of result) expect(parseGroupRoutineSummary(routine)).toEqual(routine);
  });

  it("returns no routines for a group without active members", async () => {
    const { deps, routineFindMany } = queryDeps({
      group: groupTarget({ members: [] }),
      routines: [routineRow()],
    });

    await expect(createGroupPanelQueries(deps).listRoutines(groupQuery())).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(routineFindMany).not.toHaveBeenCalled();
  });

  it("rejects a group owned by another space or user before reading routines", async () => {
    const { deps, routineFindMany } = queryDeps({ group: null });

    await expect(createGroupPanelQueries(deps).listRoutines(groupQuery())).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(routineFindMany).not.toHaveBeenCalled();
  });

  it("rejects cross-space and cross-user access to an existing group", async () => {
    const chatGroupFindFirst = vi.fn(
      async ({ where }: { where: { spaceId: string; userId: string } }) =>
        where.spaceId === actor.spaceId && where.userId === actor.userId ? groupTarget() : null,
    );
    const routineFindMany = vi.fn();
    const deps = {
      prisma: {
        chatGroup: { findFirst: chatGroupFindFirst },
        routine: { findMany: routineFindMany },
        user: { findFirst: vi.fn() },
      } as unknown as PrismaClient,
    };

    await expect(
      createGroupPanelQueries(deps).listRoutines(
        parseGroupQuery({
          actor: { kind: "user", userId: actor.userId, spaceId: "space-2" },
          groupId: "group-1",
        }),
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      createGroupPanelQueries(deps).listRoutines(
        parseGroupQuery({
          actor: { kind: "user", userId: "user-2", spaceId: actor.spaceId },
          groupId: "group-1",
        }),
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(routineFindMany).not.toHaveBeenCalled();
  });

  it("rejects a group whose thread disappeared", async () => {
    const { deps, routineFindMany } = queryDeps({ group: groupTarget({ threadId: null }) });

    await expect(createGroupPanelQueries(deps).listRoutines(groupQuery())).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(routineFindMany).not.toHaveBeenCalled();
  });

  it("never returns a routine without the Bot that executes it", async () => {
    // The query constrains botId to group members, so a row naming a removed
    // Bot cannot be mapped into a group summary.
    const { deps } = queryDeps({
      group: groupTarget(),
      routines: [routineRow({ id: "routine-a", botId: "bot-removed" })],
    });

    await expect(createGroupPanelQueries(deps).listRoutines(groupQuery())).rejects.toBeInstanceOf(
      IsolationError,
    );
  });
});

describe("GroupQueries.listMembers", () => {
  it("returns the current user separately from the Agents and excludes them from agentCount", async () => {
    const { deps, userFindFirst } = queryDeps({
      group: groupTarget(),
      user: currentUser,
    });

    const result = await createGroupPanelQueries(deps).listMembers(groupQuery());

    expect(userFindFirst).toHaveBeenCalledWith({
      where: { id: actor.userId },
      select: { id: true, name: true, image: true },
    });
    expect(result).toEqual({
      groupId: "group-1",
      threadId: "thread-1",
      currentUser: {
        kind: "user",
        userId: "user-1",
        name: "Rivers",
        image: null,
        avatarStyle: "bloub",
      },
      agents: [
        {
          kind: "agent",
          botId: "bot-1",
          name: "Alpha",
          color: "#111111",
          avatarMode: "character",
          avatarCharacter: "wave",
          avatarBodyColor: "blue",
          status: "working",
        },
        {
          kind: "agent",
          botId: "bot-2",
          name: "Beta",
          color: "#222222",
          avatarMode: "legacy",
          avatarCharacter: null,
          avatarBodyColor: "ink",
          status: "idle",
        },
      ],
      agentCount: 2,
      memberCount: 3,
    });
    expect(result.agentCount).toBe(result.agents.length);
    expect(result.memberCount).toBe(result.agentCount + 1);
    expect(parseGroupMembersSummary(result)).toEqual(result);
  });

  it("resolves malformed stored avatar characters without dropping the Agent", async () => {
    const { deps } = queryDeps({
      group: groupTarget({
        members: [
          {
            id: "bot-1",
            name: "Alpha",
            color: "#111111",
            avatarMode: "character",
            avatarCharacter: "unknown",
            avatarBodyColor: "blue",
            runs: [],
          },
          {
            id: "bot-2",
            name: "Beta",
            color: "#222222",
            avatarMode: "legacy",
            avatarCharacter: null,
            avatarBodyColor: "ink",
            runs: [],
          },
        ],
      }),
      user: currentUser,
    });

    const result = await createGroupPanelQueries(deps).listMembers(groupQuery());

    expect(result.agents[0]?.avatarCharacter).toBe("dot");
    expect(result.agentCount).toBe(2);
    expect(result.memberCount).toBe(3);
  });

  it("rejects an unauthorized group without reading the user profile", async () => {
    const { deps, userFindFirst } = queryDeps({ group: null, user: currentUser });

    await expect(createGroupPanelQueries(deps).listMembers(groupQuery())).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a group whose thread disappeared", async () => {
    const { deps, userFindFirst } = queryDeps({
      group: groupTarget({ threadId: null }),
      user: currentUser,
    });

    await expect(createGroupPanelQueries(deps).listMembers(groupQuery())).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it("rejects an actor whose user row is gone", async () => {
    const { deps } = queryDeps({ group: groupTarget(), user: null });

    await expect(createGroupPanelQueries(deps).listMembers(groupQuery())).rejects.toBeInstanceOf(
      IsolationError,
    );
  });
});
