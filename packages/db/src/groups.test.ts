import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_GROUP_KIND_AGENT_PAIR, CHAT_GROUP_KIND_STANDARD } from "./agent-pairs.js";
import type { PrismaClient } from "./client.js";
import { lockOwnedGroup, touchGroupUpdatedAt } from "./group-thread-locks.js";
import { createGroupRepos } from "./groups.js";
import { IsolationError } from "./scope.js";

describe("listSpaceGroupsForSpaces", () => {
  it("loads and maps compact cross-space group fields", async () => {
    const findMany = vi.fn(async (_query: { where: unknown; select: Record<string, unknown> }) => [
      {
        id: "group-1",
        spaceId: "workspace-2",
        name: "Support crew",
        pinned: true,
        sectionId: null,
        updatedAt: new Date("2026-08-20T00:00:00.000Z"),
        thread: {
          unread: true,
          messages: [{ blocks: [{ kind: "text", text: "Escalation pending" }] }],
        },
        members: [
          { bot: { id: "bot-1", name: "Triage", color: "#111", runs: [] } },
          {
            bot: {
              id: "bot-2",
              name: "Responder",
              color: "#222",
              runs: [{ status: "running" }],
            },
          },
        ],
      },
    ]);
    const repos = createGroupRepos({ chatGroup: { findMany } } as unknown as PrismaClient);
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@example.test",
      isDeploymentOwner: false,
    };

    await expect(repos.listSpaceGroupsForSpaces(actor, ["workspace-2"])).resolves.toEqual([
      {
        id: "group-1",
        spaceId: "workspace-2",
        name: "Support crew",
        pinned: true,
        sectionId: null,
        members: [
          { botId: "bot-1", name: "Triage", color: "#111", status: "idle" },
          { botId: "bot-2", name: "Responder", color: "#222", status: "running" },
        ],
        preview: "Escalation pending",
        unread: true,
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    ]);
    const query = findMany.mock.calls[0]![0];
    expect(query.select).not.toHaveProperty("userId");
    expect(query.select).not.toHaveProperty("archivedAt");
    expect(query.select).not.toHaveProperty("createdAt");
  });
});

describe("archiveGroup", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@example.com",
    isDeploymentOwner: true,
  };
  let queryRaw: ReturnType<typeof vi.fn>;
  let findFirst: ReturnType<typeof vi.fn>;
  let findUnique: ReturnType<typeof vi.fn>;
  let findManyRuns: ReturnType<typeof vi.fn>;
  let findManyComputers: ReturnType<typeof vi.fn>;
  let runUpdateMany: ReturnType<typeof vi.fn>;
  let attemptUpdateMany: ReturnType<typeof vi.fn>;
  let taskUpdateMany: ReturnType<typeof vi.fn>;
  let leaseUpdateMany: ReturnType<typeof vi.fn>;
  let leaseFindMany: ReturnType<typeof vi.fn>;
  let computerUpdateMany: ReturnType<typeof vi.fn>;
  let eventDeleteMany: ReturnType<typeof vi.fn>;
  let groupUpdate: ReturnType<typeof vi.fn>;
  let prisma: PrismaClient;

  beforeEach(() => {
    queryRaw = vi.fn().mockResolvedValue([{ id: "group-1" }]);
    findUnique = vi.fn().mockResolvedValue({ thread: { id: "thread-1" } });
    findFirst = vi.fn().mockResolvedValue({ thread: { id: "thread-1" } });
    findManyRuns = vi.fn(async (args?: { where?: { trigger?: string } }) =>
      args?.where?.trigger
        ? []
        : [
            { id: "run-1", taskId: "task-1" },
            { id: "run-legacy", taskId: "task-legacy" },
          ],
    );
    // computer-1 matches production: the lease is ownership, executionRunId stays unset.
    // computer-legacy is the executionRunId fallback for a run with no lease row.
    // computer-2's executionRunId names a reclaimed run; resume must not follow that column.
    const computerRows = [
      {
        id: "computer-1",
        homeKey: "home-1",
        kind: "fake",
        providerRef: "computer-1",
        executionBotId: null,
        executionRunId: null,
      },
      {
        id: "computer-2",
        homeKey: "home-2",
        kind: "fake",
        providerRef: "computer-2",
        executionBotId: "bot-4",
        executionRunId: "run-reclaimed",
      },
      {
        id: "computer-expired",
        homeKey: "home-expired",
        kind: "fake",
        providerRef: "computer-expired",
        executionBotId: null,
        executionRunId: null,
      },
      {
        id: "computer-legacy",
        homeKey: "home-legacy",
        kind: "fake",
        providerRef: "computer-legacy",
        executionBotId: "bot-legacy",
        executionRunId: "run-legacy",
      },
    ];
    type ComputerWhere = {
      id?: { in: string[] };
      executionRunId?: { in: string[] };
      OR?: ComputerWhere[];
    };
    const matches = (row: (typeof computerRows)[number], where: ComputerWhere): boolean =>
      (where.OR?.some((clause) => matches(row, clause)) ?? false) ||
      Boolean(where.id?.in.includes(row.id)) ||
      Boolean(row.executionRunId && where.executionRunId?.in.includes(row.executionRunId));
    findManyComputers = vi.fn(async ({ where }: { where: ComputerWhere }) =>
      computerRows.filter((row) => matches(row, where)),
    );
    runUpdateMany = vi.fn().mockResolvedValue([
      {
        id: "run-1",
        taskId: "task-1",
        threadId: "thread-1",
        spaceId: "workspace-1",
        botId: "bot-1",
      },
      {
        id: "run-legacy",
        taskId: "task-legacy",
        threadId: "thread-1",
        spaceId: "workspace-1",
        botId: "bot-legacy",
      },
    ]);
    attemptUpdateMany = vi.fn();
    taskUpdateMany = vi.fn();
    // computer-1 is a Team computer: bot-2's lease there belongs to a run outside this group.
    // run-1 and run-stale expired without reclaim, so their runId still names the screen.
    // run-reclaimed has no lease row; computer-2's column is not enough to resume.
    const liveUntil = new Date("2099-01-01T00:00:00.000Z");
    // After the cleanup epoch, so a resume still tears this unreclaimed lease down.
    const expiredAt = new Date("2026-09-25T00:00:00.000Z");
    const leaseRows = [
      { computerId: "computer-1", botId: "bot-1", runId: "run-1", fence: 3, expiresAt: liveUntil },
      {
        computerId: "computer-expired",
        botId: "bot-1",
        runId: "run-1",
        fence: 9,
        expiresAt: expiredAt,
      },
      {
        computerId: "computer-1",
        botId: "bot-2",
        runId: "run-other",
        fence: 7,
        expiresAt: liveUntil,
      },
      {
        computerId: "computer-2",
        botId: "bot-3",
        runId: "run-other-group",
        fence: 1,
        expiresAt: liveUntil,
      },
      {
        computerId: "computer-2",
        botId: "bot-4",
        runId: "run-stale",
        fence: 2,
        expiresAt: expiredAt,
      },
    ];
    leaseUpdateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: { runId?: { in: string[] } };
        data: { expiresAt?: Date };
      }) => {
        if (!where.runId || !data.expiresAt) return;
        for (const lease of leaseRows) {
          if (where.runId.in.includes(lease.runId)) lease.expiresAt = data.expiresAt;
        }
      },
    );
    type LeaseWhere = { runId: { in: string[] }; expiresAt?: { gt: Date } };
    leaseFindMany = vi.fn(async ({ where }: { where: LeaseWhere }) =>
      leaseRows.filter((lease) => {
        if (!where.runId.in.includes(lease.runId)) return false;
        return !where.expiresAt || lease.expiresAt > where.expiresAt.gt;
      }),
    );
    computerUpdateMany = vi.fn();
    eventDeleteMany = vi.fn();
    groupUpdate = vi.fn();
    const tx = {
      $queryRaw: queryRaw,
      chatGroup: { findFirst, findUnique, update: groupUpdate },
      run: {
        findMany: findManyRuns,
        updateMany: vi.fn(),
        updateManyAndReturn: runUpdateMany,
        findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }),
      },
      attempt: { updateMany: attemptUpdateMany },
      task: { updateMany: taskUpdateMany },
      steeringMessage: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 1 }) },
      computerExecutionLease: { findMany: leaseFindMany, updateMany: leaseUpdateMany },
      computer: { findMany: findManyComputers, updateMany: computerUpdateMany },
      event: {
        deleteMany: eventDeleteMany,
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      },
    };
    prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      computerExecutionLease: { updateMany: leaseUpdateMany },
      computer: { updateMany: computerUpdateMany },
    } as unknown as PrismaClient;
  });

  it("tears down only this thread's runs, each under its own lease", async () => {
    const repos = createGroupRepos(prisma);

    await expect(repos.archiveGroup(actor, "group-1")).resolves.toEqual({
      cancelledRunIds: ["run-1", "run-legacy"],
      backgroundParentRunIds: [],
      computers: [
        {
          id: "computer-1",
          homeKey: "home-1",
          kind: "fake",
          providerRef: "computer-1",
          botId: "bot-1",
          runId: "run-1",
          fence: 3,
        },
        {
          id: "computer-expired",
          homeKey: "home-expired",
          kind: "fake",
          providerRef: "computer-expired",
          botId: "bot-1",
          runId: "run-1",
          fence: 9,
        },
        {
          id: "computer-legacy",
          homeKey: "home-legacy",
          kind: "fake",
          providerRef: "computer-legacy",
          botId: "bot-legacy",
          runId: "run-legacy",
          fence: 0,
        },
      ],
    });
    expect(leaseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId: { in: ["run-1", "run-legacy"] } },
      }),
    );

    expect(queryRaw).toHaveBeenCalled();
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread-1" }),
      }),
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "group-1",
          spaceId: actor.spaceId,
          userId: actor.userId,
          kind: CHAT_GROUP_KIND_STANDARD,
        },
        select: { archivedAt: true, thread: { select: { id: true } } },
      }),
    );
    // The leases outlive the transaction so the caller's screen release still carries the fence.
    expect(leaseUpdateMany).not.toHaveBeenCalled();
    expect(computerUpdateMany).not.toHaveBeenCalled();
    expect(groupUpdate).toHaveBeenCalledWith({
      where: { id: "group-1" },
      data: expect.objectContaining({ pinned: false, archivedAt: expect.any(Date) }),
    });
  });

  it("expires the archived runs' leases and legacy columns once teardown is done", async () => {
    const expire = vi.fn();
    const clear = vi.fn();
    const repos = createGroupRepos({
      computerExecutionLease: { updateMany: expire },
      computer: { updateMany: clear },
    } as unknown as PrismaClient);

    await repos.releaseArchivedRunLeases([]);
    expect(expire).not.toHaveBeenCalled();
    await repos.releaseArchivedRunLeases(["run-1"]);
    expect(expire).toHaveBeenCalledWith({
      where: { runId: { in: ["run-1"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(clear).toHaveBeenCalledWith({
      where: { executionRunId: { in: ["run-1"] } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
  });

  it("resumes teardown for cancelled runs whose lease row still names them", async () => {
    const archivedAt = new Date("2026-09-26T00:00:00.000Z");
    findFirst.mockResolvedValue({ archivedAt, thread: { id: "thread-1" } });
    findManyRuns.mockResolvedValue([{ id: "run-1" }, { id: "run-stale" }, { id: "run-reclaimed" }]);
    const repos = createGroupRepos(prisma);

    const archived = await repos.archiveGroup(actor, "group-1");
    expect(archived).toEqual({
      cancelledRunIds: ["run-1", "run-stale"],
      backgroundParentRunIds: [],
      computers: [
        {
          id: "computer-1",
          homeKey: "home-1",
          kind: "fake",
          providerRef: "computer-1",
          botId: "bot-1",
          runId: "run-1",
          fence: 3,
        },
        {
          id: "computer-expired",
          homeKey: "home-expired",
          kind: "fake",
          providerRef: "computer-expired",
          botId: "bot-1",
          runId: "run-1",
          fence: 9,
        },
        {
          id: "computer-2",
          homeKey: "home-2",
          kind: "fake",
          providerRef: "computer-2",
          botId: "bot-4",
          runId: "run-stale",
          fence: 2,
        },
      ],
    });

    expect(queryRaw).toHaveBeenCalled();
    expect(findManyRuns).toHaveBeenCalledWith({
      where: { threadId: "thread-1", status: "cancelled" },
      select: { id: true },
    });
    expect(leaseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          runId: { in: ["run-1", "run-stale", "run-reclaimed"] },
          expiresAt: { gt: new Date(0) },
        },
      }),
    );
    expect(groupUpdate).not.toHaveBeenCalled();
    expect(runUpdateMany).not.toHaveBeenCalled();
    expect(leaseUpdateMany).not.toHaveBeenCalled();
    expect(computerUpdateMany).not.toHaveBeenCalled();

    await repos.releaseArchivedRunLeases(archived.cancelledRunIds);
    expect(leaseUpdateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-1", "run-stale"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(computerUpdateMany).toHaveBeenCalledWith({
      where: { executionRunId: { in: ["run-1", "run-stale"] } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });

    await expect(repos.archiveGroup(actor, "group-1")).rejects.toBeInstanceOf(IsolationError);
    expect(groupUpdate).not.toHaveBeenCalled();
  });

  it("rejects an already-archived group when no lease still names a cancelled run", async () => {
    findFirst.mockResolvedValue({
      archivedAt: new Date("2026-09-26T00:00:00.000Z"),
      thread: { id: "thread-1" },
    });
    findManyRuns.mockResolvedValue([{ id: "run-reclaimed" }]);
    const repos = createGroupRepos(prisma);

    await expect(repos.archiveGroup(actor, "group-1")).rejects.toBeInstanceOf(IsolationError);
    expect(queryRaw).toHaveBeenCalled();
    expect(leaseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          runId: { in: ["run-reclaimed"] },
          expiresAt: { gt: new Date(0) },
        },
      }),
    );
    expect(groupUpdate).not.toHaveBeenCalled();
    expect(leaseUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects when the group is missing", async () => {
    findFirst.mockResolvedValue(null);
    const repos = createGroupRepos(prisma);
    await expect(repos.archiveGroup(actor, "group-1")).rejects.toBeInstanceOf(IsolationError);
    expect(groupUpdate).not.toHaveBeenCalled();
  });
});

describe("hidden agent_pair exclusion", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@example.test",
    isDeploymentOwner: false,
  };

  /** Stands in for the row RT-02 lets exist: a hidden pair group with two Bots. */
  const pairRow = {
    id: "group-pair",
    spaceId: "workspace-1",
    userId: "user-1",
    name: "Agent pair",
    kind: CHAT_GROUP_KIND_AGENT_PAIR,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    createdAt: new Date("2026-10-22T00:00:00.000Z"),
    updatedAt: new Date("2026-10-22T00:00:00.000Z"),
    thread: { id: "thread-pair", unread: true, messages: [] },
    members: [
      { bot: { id: "bot-a", name: "Joy", color: "#111", runs: [] } },
      { bot: { id: "bot-b", name: "小蓝", color: "#222", runs: [] } },
    ],
  };

  /** Emulates the database: the pair row is returned unless the caller excluded it. */
  function honourKind(where: { kind?: string }) {
    return where.kind === CHAT_GROUP_KIND_STANDARD ? null : pairRow;
  }

  it("keeps pair groups out of the sidebar list", async () => {
    const findMany = vi.fn(async ({ where }: { where: { kind?: string } }) => {
      const row = honourKind(where);
      return row ? [row] : [];
    });
    const repos = createGroupRepos({ chatGroup: { findMany } } as unknown as PrismaClient);

    await expect(repos.listGroups(actor)).resolves.toEqual([]);
    expect(findMany.mock.calls[0]?.[0].where).toMatchObject({ kind: CHAT_GROUP_KIND_STANDARD });
  });

  it("keeps pair groups out of cross-space navigation and its unread badge", async () => {
    const findMany = vi.fn(async ({ where }: { where: { kind?: string } }) => {
      const row = honourKind(where);
      return row ? [row] : [];
    });
    const repos = createGroupRepos({ chatGroup: { findMany } } as unknown as PrismaClient);

    await expect(repos.listSpaceGroupsForSpaces(actor, ["workspace-1"])).resolves.toEqual([]);
    expect(findMany.mock.calls[0]?.[0].where).toMatchObject({ kind: CHAT_GROUP_KIND_STANDARD });
  });

  it("refuses to load a pair group through the normal group read", async () => {
    const findFirst = vi.fn(async ({ where }: { where: { kind?: string } }) => honourKind(where));
    const repos = createGroupRepos({ chatGroup: { findFirst } } as unknown as PrismaClient);

    await expect(repos.getGroup(actor, "group-pair")).rejects.toBeInstanceOf(IsolationError);
    expect(findFirst.mock.calls[0]?.[0].where).toMatchObject({ kind: CHAT_GROUP_KIND_STANDARD });
  });

  it("refuses to address a pair group as a human send target", async () => {
    const findFirst = vi.fn(async ({ where }: { where: { kind?: string } }) => honourKind(where));
    const repos = createGroupRepos({ chatGroup: { findFirst } } as unknown as PrismaClient);

    await expect(repos.getGroupTarget(actor, "group-pair")).rejects.toBeInstanceOf(IsolationError);
    expect(findFirst.mock.calls[0]?.[0].where).toMatchObject({ kind: CHAT_GROUP_KIND_STANDARD });
  });

  function mutationHarness() {
    const findFirst = vi.fn(async ({ where }: { where: { kind?: string } }) => honourKind(where));
    const groupUpdate = vi.fn();
    const groupDelete = vi.fn();
    const groupUpdateMany = vi.fn(async ({ where }: { where: { id: string; kind?: string } }) => ({
      count: where.kind === CHAT_GROUP_KIND_STANDARD && where.id !== "group-pair" ? 1 : 0,
    }));
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      chatGroup: {
        findUnique: vi.fn(async () => ({ thread: { id: "thread-1" } })),
        findFirst,
        update: groupUpdate,
        updateMany: groupUpdateMany,
        delete: groupDelete,
      },
      thread: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      chatGroup: { updateMany: groupUpdateMany },
    } as unknown as PrismaClient;
    return {
      repos: createGroupRepos(prisma),
      findFirst,
      groupUpdate,
      groupDelete,
      groupUpdateMany,
    };
  }

  it("refuses updateGroup on a known pair id without writing", async () => {
    const harness = mutationHarness();

    await expect(
      harness.repos.updateGroup(actor, { groupId: "group-pair", name: "hijacked" }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(harness.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      id: "group-pair",
      kind: CHAT_GROUP_KIND_STANDARD,
    });
    expect(harness.groupUpdate).not.toHaveBeenCalled();
  });

  it("refuses archiveGroup on a known pair id without writing", async () => {
    const harness = mutationHarness();

    await expect(harness.repos.archiveGroup(actor, "group-pair")).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(harness.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      id: "group-pair",
      kind: CHAT_GROUP_KIND_STANDARD,
    });
    expect(harness.groupUpdate).not.toHaveBeenCalled();
  });

  it("refuses restoreGroup on a known pair id", async () => {
    const harness = mutationHarness();

    await expect(harness.repos.restoreGroup(actor, "group-pair")).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(harness.groupUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "group-pair", kind: CHAT_GROUP_KIND_STANDARD }),
      data: { archivedAt: null },
    });
  });

  it("refuses removeGroup on a known pair id without deleting", async () => {
    const harness = mutationHarness();

    await expect(harness.repos.removeGroup(actor, "group-pair")).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(harness.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      id: "group-pair",
      kind: CHAT_GROUP_KIND_STANDARD,
    });
    expect(harness.groupDelete).not.toHaveBeenCalled();
  });

  it("still restores a standard group", async () => {
    const harness = mutationHarness();

    await expect(harness.repos.restoreGroup(actor, "group-1")).resolves.toBeUndefined();
    expect(harness.groupUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "group-1", kind: CHAT_GROUP_KIND_STANDARD }),
      data: { archivedAt: null },
    });
  });

  it("locks only owned standard groups", async () => {
    let sql = "";
    const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
      sql = strings.join("?");
      return [];
    });

    await expect(
      lockOwnedGroup({ $queryRaw: queryRaw as never }, actor, "group-pair"),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(sql).toContain('"kind" =');
  });

  it("touches only a standard group's updatedAt", async () => {
    const updateMany = vi.fn(async ({ where }: { where: { id: string; kind?: string } }) => ({
      count: where.kind === CHAT_GROUP_KIND_STANDARD && where.id !== "group-pair" ? 1 : 0,
    }));
    const client = { chatGroup: { updateMany } } as never;

    await expect(touchGroupUpdatedAt(client, "group-pair")).rejects.toBeInstanceOf(IsolationError);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "group-pair", kind: CHAT_GROUP_KIND_STANDARD },
      data: { updatedAt: expect.any(Date) },
    });
  });
});
