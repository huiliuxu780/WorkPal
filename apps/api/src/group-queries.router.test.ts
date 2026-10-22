import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import {
  parseArtifactSummary,
  parseGroupMembersSummary,
  parseGroupPageQuery,
  parseGroupQuery,
  parseGroupRoutineSummary,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createGroupQueries } from "./group-queries.js";
import { createRouter, type RouterDeps } from "./router.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.com",
  isDeploymentOwner: false,
};

function groupTarget(id = "group-1") {
  return {
    id,
    thread: { id: "thread-1" },
    members: [
      {
        bot: {
          id: "bot-1",
          name: "Alpha",
          color: "#111111",
          avatarMode: "character",
          avatarCharacter: "wave",
          avatarBodyColor: "blue",
          runs: [{ status: "working" }],
        },
      },
      {
        bot: {
          id: "bot-2",
          name: "Beta",
          color: "#222222",
          avatarMode: "legacy",
          avatarCharacter: null,
          avatarBodyColor: "ink",
          runs: [],
        },
      },
    ],
  };
}

function groupArtifactRow() {
  return {
    id: "version-a",
    familyId: "family-a",
    botId: "bot-1",
    groupId: "group-1",
    runId: null,
    name: "Notes",
    description: null,
    mimeType: "text/markdown",
    size: 12,
    version: 2,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    versionCount: 2,
  };
}

function groupRoutineRow() {
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
    lastRunAt: null,
    nextRunAt: new Date("2026-10-23T09:00:00.000Z"),
    createdAt: new Date("2026-10-19T00:00:00.000Z"),
  };
}

const groupUser = { id: "user-1", name: "Rivers", image: null, avatarStyle: "organic" };

function fixture(
  overrides: { group?: unknown; queryRaw?: unknown[]; routines?: unknown[]; user?: unknown } = {},
) {
  const chatGroupFindFirst = vi.fn().mockResolvedValue(overrides.group ?? null);
  const routineFindMany = vi.fn().mockResolvedValue(overrides.routines ?? []);
  const userFindFirst = vi.fn().mockResolvedValue(overrides.user ?? null);
  const queryRaw = vi.fn().mockResolvedValue(overrides.queryRaw ?? []);
  const deps = {
    prisma: {
      chatGroup: { findFirst: chatGroupFindFirst },
      routine: { findMany: routineFindMany },
      user: { findFirst: userFindFirst },
      $queryRaw: queryRaw,
    } as unknown as PrismaClient,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-group-queries-test",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(path: string, json: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { response, body: await response.json() };
  }
  return { call, deps, chatGroupFindFirst, routineFindMany, userFindFirst, queryRaw };
}

function groupCursor(groupId: string, id = "version-b") {
  return `v1.${Buffer.from(
    JSON.stringify({
      createdAt: "2026-09-01T00:00:00.000Z",
      id,
      botId: null,
      groupId,
      asOf: "2026-09-20T00:00:00.000Z",
    }),
    "utf8",
  ).toString("base64url")}`;
}

describe("group-scoped query RPC contract", () => {
  it("returns a paginated artifact page for the authorized group", async () => {
    const { call } = fixture({
      group: groupTarget(),
      queryRaw: [groupArtifactRow()],
    });

    const { response, body } = await call("groups/artifacts/list", {
      groupId: "group-1",
      limit: 2,
    });

    expect(response.status).toBe(200);
    expect(body).toEqual({
      json: {
        items: [
          {
            id: "family-a",
            botId: null,
            groupId: "group-1",
            runId: null,
            name: "Notes",
            description: null,
            mimeType: "text/markdown",
            size: 12,
            version: 2,
            versionCount: 2,
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      },
    });
  });

  it("rejects an invalid cursor with BAD_REQUEST", async () => {
    const { call, queryRaw } = fixture({ group: groupTarget() });

    const { response, body } = await call("groups/artifacts/list", {
      groupId: "group-1",
      cursor: "v1.not-json",
    });

    expect(response.status).toBe(400);
    expect(body).toEqual({
      json: expect.objectContaining({ code: "BAD_REQUEST", message: "Invalid artifact cursor" }),
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("rejects a cursor from another group with BAD_REQUEST", async () => {
    const { call, queryRaw } = fixture({ group: groupTarget() });

    const { response, body } = await call("groups/artifacts/list", {
      groupId: "group-1",
      cursor: groupCursor("group-2"),
    });

    expect(response.status).toBe(400);
    expect(body).toEqual({
      json: expect.objectContaining({ code: "BAD_REQUEST", message: "Invalid artifact cursor" }),
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("hides unauthorized, archived, and cross-space groups behind NOT_FOUND", async () => {
    const { call, routineFindMany, userFindFirst, queryRaw } = fixture({ group: null });

    for (const path of ["groups/artifacts/list", "groups/routines/list", "groups/members/list"]) {
      const { response, body } = await call(path, { groupId: "group-1" });
      expect(response.status).toBe(404);
      expect(body).toEqual({ json: expect.objectContaining({ code: "NOT_FOUND" }) });
    }
    expect(queryRaw).not.toHaveBeenCalled();
    expect(routineFindMany).not.toHaveBeenCalled();
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it("returns group routines with the executing Bot identity", async () => {
    const { call, routineFindMany } = fixture({
      group: groupTarget(),
      routines: [groupRoutineRow()],
    });

    const { response, body } = await call("groups/routines/list", { groupId: "group-1" });

    expect(response.status).toBe(200);
    expect(routineFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread-1", botId: { in: ["bot-1", "bot-2"] } }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    expect(body).toEqual({
      json: [
        {
          id: "routine-1",
          botId: "bot-1",
          name: "Morning digest",
          prompt: "Summarize the day",
          crons: ["0 9 * * *"],
          timezone: "UTC",
          active: true,
          notify: true,
          webhookEnabled: false,
          githubEnabled: false,
          messageProvider: null,
          lastRunAt: null,
          nextRunAt: "2026-10-23T09:00:00.000Z",
          createdAt: "2026-10-19T00:00:00.000Z",
          threadId: "thread-1",
          executorBot: {
            kind: "agent",
            botId: "bot-1",
            name: "Alpha",
            color: "#111111",
            avatarMode: "character",
            avatarCharacter: "wave",
            avatarBodyColor: "blue",
          },
        },
      ],
    });
  });

  it("returns the current user and Agents with counts", async () => {
    const { call } = fixture({
      group: groupTarget(),
      user: groupUser,
    });

    const { response, body } = await call("groups/members/list", { groupId: "group-1" });

    expect(response.status).toBe(200);
    expect(body).toEqual({
      json: {
        groupId: "group-1",
        threadId: "thread-1",
        currentUser: {
          kind: "user",
          userId: "user-1",
          name: "Rivers",
          image: null,
          avatarStyle: "organic",
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
      },
    });
  });
});

describe("core GroupQueries port to RPC mapping", () => {
  function panelQuery(groupId = "group-1") {
    return parseGroupQuery({
      actor: { kind: "user", userId: actor.userId, spaceId: actor.spaceId },
      groupId,
    });
  }

  it("maps artifact pages without losing or inventing core fields", async () => {
    const { call, deps } = fixture({ group: groupTarget(), queryRaw: [groupArtifactRow()] });
    const query = parseGroupPageQuery({
      actor: { kind: "user", userId: actor.userId, spaceId: actor.spaceId },
      groupId: "group-1",
      limit: 30,
    });
    const port = await createGroupQueries(deps).listArtifacts(query);
    const { body } = await call("groups/artifacts/list", { groupId: "group-1", limit: 30 });
    const wire = body as {
      json: { items: Array<Record<string, unknown>>; nextCursor: string | null };
    };

    expect(wire.json.nextCursor).toBe(port.nextCursor);
    expect(wire.json.items).toHaveLength(port.items.length);
    wire.json.items.forEach((item, index) => {
      const core = port.items[index]!;
      expect(item).toEqual({ ...core, botId: null, groupId: "group-1", runId: null });
      expect(parseArtifactSummary(item)).toEqual(core);
    });
  });

  it("maps routines one-to-one between the port and the RPC", async () => {
    const { call, deps } = fixture({ group: groupTarget(), routines: [groupRoutineRow()] });
    const port = await createGroupQueries(deps).listRoutines(panelQuery());
    const { body } = await call("groups/routines/list", { groupId: "group-1" });

    expect((body as { json: unknown }).json).toEqual(port);
    for (const routine of (body as { json: unknown[] }).json) {
      expect(parseGroupRoutineSummary(routine)).toEqual(routine);
    }
  });

  it("maps the member summary one-to-one between the port and the RPC", async () => {
    const { call, deps } = fixture({ group: groupTarget(), user: groupUser });
    const port = await createGroupQueries(deps).listMembers(panelQuery());
    const { body } = await call("groups/members/list", { groupId: "group-1" });

    expect((body as { json: unknown }).json).toEqual(port);
    expect(parseGroupMembersSummary((body as { json: unknown }).json)).toEqual(port);
  });
});
