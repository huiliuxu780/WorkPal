import {
  type BotId,
  parseBotId,
  parseSpaceId,
  parseUserId,
  RoundtableFeatureDisabledError,
  type RoundtableFeatureGates,
} from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PAIR_GROUP_NAME,
  agentPairKey,
  CHAT_GROUP_KIND_AGENT_PAIR,
  createAgentPairRepository,
} from "./agent-pairs.js";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

const spaceId = parseSpaceId("space-1");
const userId = parseUserId("user-1");
const botA = parseBotId("bot-a");
const botB = parseBotId("bot-b");
const botC = parseBotId("bot-c");

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

type PairRow = { id: string; name: string; pairKey: string; thread: { id: string } | null };

type CreateArgs = { data: { spaceId: string; pairKey: string; name: string; kind: string } };
type FindFirstArgs = { where: { spaceId: string; pairKey: string; kind: string } };

type Fixture = {
  prisma: PrismaClient;
  chatGroupCreate: ReturnType<typeof vi.fn>;
  chatGroupFindFirst: ReturnType<typeof vi.fn>;
  memberCreateMany: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  botFindMany: ReturnType<typeof vi.fn>;
  /** Committed pair groups, keyed the way the unique index keys them. */
  committed: Map<string, PairRow>;
  activeBots: Set<BotId>;
  botNames: Map<BotId, string>;
  /** Errors `$transaction` throws, consumed in order. */
  transactionFailures: unknown[];
  /** Error `chatGroup.create` throws once, without committing a row. */
  createFailure: unknown;
};

const rowKey = (space: string, pairKey: string) => `${space}\u0000${pairKey}`;

function createFixture(): Fixture {
  const fixture: Fixture = {
    prisma: undefined as unknown as PrismaClient,
    chatGroupCreate: vi.fn(),
    chatGroupFindFirst: vi.fn(),
    memberCreateMany: vi.fn(),
    transaction: vi.fn(),
    botFindMany: vi.fn(),
    committed: new Map(),
    activeBots: new Set([botA, botB]),
    botNames: new Map([
      [botA, "Joy"],
      [botB, "小蓝"],
    ]),
    transactionFailures: [],
    createFailure: undefined,
  };

  let sequence = 0;
  let pendingThreadId: string | undefined;

  fixture.botFindMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in
      .filter((id) => fixture.activeBots.has(id as BotId))
      .map((id) => ({ id, name: fixture.botNames.get(id as BotId) ?? id })),
  );

  fixture.chatGroupFindFirst.mockImplementation(async (args: FindFirstArgs) => {
    if (args.where.kind !== CHAT_GROUP_KIND_AGENT_PAIR) return null;
    const row = fixture.committed.get(rowKey(args.where.spaceId, args.where.pairKey));
    return row ? { id: row.id, thread: row.thread } : null;
  });

  fixture.memberCreateMany.mockResolvedValue({ count: 2 });

  fixture.chatGroupCreate.mockImplementation(async (args: CreateArgs) => {
    if (fixture.createFailure) {
      const failure = fixture.createFailure;
      fixture.createFailure = undefined;
      throw failure;
    }
    sequence += 1;
    const id = `group-${sequence}`;
    pendingThreadId = `thread-${id}`;
    fixture.committed.set(rowKey(args.data.spaceId, args.data.pairKey), {
      id,
      name: args.data.name,
      pairKey: args.data.pairKey,
      thread: { id: pendingThreadId },
    });
    return { id };
  });

  fixture.transaction.mockImplementation(async (operation: (tx: unknown) => Promise<unknown>) => {
    const failure = fixture.transactionFailures.shift();
    if (failure) throw failure;
    return operation({
      $queryRaw: async () => [{ lock: "1" }],
      spaceMember: {
        findUnique: async () => ({ organizationId: "org-1", space: { deletingAt: null } }),
      },
      chatGroup: { findFirst: fixture.chatGroupFindFirst, create: fixture.chatGroupCreate },
      chatGroupMember: { createMany: fixture.memberCreateMany },
      thread: { create: async () => ({ id: pendingThreadId }) },
    });
  });

  fixture.prisma = {
    bot: { findMany: fixture.botFindMany },
    chatGroup: { findFirst: fixture.chatGroupFindFirst },
    $transaction: fixture.transaction,
  } as unknown as PrismaClient;

  return fixture;
}

const uniqueViolation = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

describe("agentPairKey", () => {
  it("collapses both contact directions onto one key", () => {
    expect(agentPairKey(botA, botB)).toBe(agentPairKey(botB, botA));
  });

  it("separates different pairs and stays fixed width", () => {
    const key = agentPairKey(botA, botB);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(agentPairKey(botA, botC));
    expect(key).not.toBe(agentPairKey(botB, botC));
  });

  it("stays injective when an id contains the other pair's boundary", () => {
    expect(agentPairKey("bot-a\u0000x", "bot-b")).not.toBe(agentPairKey("bot-a", "x\u0000bot-b"));
    expect(agentPairKey("bot-a5:bot-b", "bot-c")).not.toBe(agentPairKey("bot-a", "5:bot-bbot-c"));
  });
});

describe("createAgentPairRepository.getOrCreate", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  it("refuses while the private_pair gate is closed", async () => {
    const repo = createAgentPairRepository(fixture.prisma, CLOSED_GATES);

    const failure = await repo
      .getOrCreate({ spaceId, userId, botAId: botA, botBId: botB })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RoundtableFeatureDisabledError);
    expect(failure).toMatchObject({
      code: "ROUNDTABLE_FEATURE_DISABLED",
      feature: "private_pair",
      retryable: false,
    });
    expect(fixture.botFindMany).not.toHaveBeenCalled();
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it("refuses to pair a Bot with itself", async () => {
    const repo = createAgentPairRepository(fixture.prisma, OPEN_GATES);

    await expect(
      repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botA }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(fixture.botFindMany).not.toHaveBeenCalled();
  });

  it("refuses when either Bot is archived or owned by someone else", async () => {
    fixture.activeBots.delete(botB);
    const repo = createAgentPairRepository(fixture.prisma, OPEN_GATES);

    await expect(
      repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it("creates one agent_pair group, both members and one thread", async () => {
    const repo = createAgentPairRepository(fixture.prisma, OPEN_GATES);

    const pair = await repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB });

    expect(pair).toEqual({
      groupId: "group-1",
      threadId: "thread-group-1",
      botAId: botA,
      botBId: botB,
    });
    expect(fixture.chatGroupCreate).toHaveBeenCalledWith({
      data: {
        spaceId,
        userId,
        name: AGENT_PAIR_GROUP_NAME,
        kind: CHAT_GROUP_KIND_AGENT_PAIR,
        pairKey: agentPairKey(botA, botB),
        leadBotId: botA,
      },
      select: { id: true },
    });
    expect(fixture.memberCreateMany).toHaveBeenCalledWith({
      data: [
        { groupId: "group-1", botId: botA },
        { groupId: "group-1", botId: botB },
      ],
    });
  });

  it("returns the same thread for A→B and B→A", async () => {
    const repo = createAgentPairRepository(fixture.prisma, OPEN_GATES);

    const forward = await repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB });
    const reverse = await repo.getOrCreate({ spaceId, userId, botAId: botB, botBId: botA });

    expect(reverse).toEqual(forward);
    expect(fixture.chatGroupCreate).toHaveBeenCalledTimes(1);
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
  });

  it("keeps pair identity across a Bot rename and a group rename", async () => {
    const repo = createAgentPairRepository(fixture.prisma, OPEN_GATES);
    const before = await repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB });

    fixture.botNames.set(botA, "Joy 二代");
    fixture.botNames.set(botB, "小蓝（新头像）");
    const stored = fixture.committed.get(rowKey(spaceId, agentPairKey(botA, botB)));
    if (stored) stored.name = "改名后的群";

    const after = await repo.getOrCreate({ spaceId, userId, botAId: botB, botBId: botA });

    expect(after).toEqual(before);
    expect(fixture.chatGroupCreate).toHaveBeenCalledTimes(1);
  });

  it("re-reads the winner instead of failing on a unique conflict", async () => {
    fixture.createFailure = uniqueViolation;
    const winner: PairRow = {
      id: "group-winner",
      name: AGENT_PAIR_GROUP_NAME,
      pairKey: agentPairKey(botA, botB),
      thread: { id: "thread-winner" },
    };
    // Fast path and in-transaction re-check both miss; only the post-conflict
    // re-read sees the row the winning writer committed.
    fixture.chatGroupFindFirst
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: winner.id, thread: winner.thread });
    const repo = createAgentPairRepository(fixture.prisma, OPEN_GATES);

    const pair = await repo.getOrCreate({ spaceId, userId, botAId: botB, botBId: botA });

    expect(pair).toEqual({
      groupId: "group-winner",
      threadId: "thread-winner",
      botAId: botA,
      botBId: botB,
    });
  });

  it("accepts the driver-adapter shape of the same conflict", async () => {
    fixture.createFailure = {
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "23505" } } },
    };
    fixture.chatGroupFindFirst
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "group-winner", thread: { id: "thread-winner" } });
    const repo = createAgentPairRepository(fixture.prisma, OPEN_GATES);

    await expect(
      repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB }),
    ).resolves.toMatchObject({ groupId: "group-winner", threadId: "thread-winner" });
  });

  it("rethrows a unique conflict that leaves no winner to read", async () => {
    fixture.createFailure = uniqueViolation;
    fixture.chatGroupFindFirst.mockReset().mockResolvedValue(null);
    const repo = createAgentPairRepository(fixture.prisma, OPEN_GATES);

    await expect(
      repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("rethrows a non-unique failure without reading again", async () => {
    fixture.transactionFailures.push(new Error("connection lost"));
    const repo = createAgentPairRepository(fixture.prisma, OPEN_GATES);

    await expect(repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB })).rejects.toThrow(
      "connection lost",
    );
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
  });

  it("retries a write conflict and still returns one thread", async () => {
    fixture.transactionFailures.push({ code: "P2034" });
    const repo = createAgentPairRepository(fixture.prisma, OPEN_GATES);

    const pair = await repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB });

    expect(pair).toMatchObject({ groupId: "group-1", threadId: "thread-group-1" });
    expect(fixture.transaction).toHaveBeenCalledTimes(2);
    expect(fixture.chatGroupCreate).toHaveBeenCalledTimes(1);
  });

  it("retries a serialization failure surfaced by the pg driver", async () => {
    // Prisma always sets a top-level code, and the shared retry guard only
    // inspects the driver-adapter cause when one is present.
    fixture.transactionFailures.push({
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "40001" } } },
    });
    const repo = createAgentPairRepository(fixture.prisma, OPEN_GATES);

    await expect(
      repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB }),
    ).resolves.toMatchObject({ groupId: "group-1" });
    expect(fixture.transaction).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget is exhausted", async () => {
    fixture.transactionFailures.push({ code: "P2034" }, { code: "P2034" }, { code: "P2034" });
    const repo = createAgentPairRepository(fixture.prisma, OPEN_GATES);

    await expect(
      repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB }),
    ).rejects.toMatchObject({ code: "P2034" });
    expect(fixture.transaction).toHaveBeenCalledTimes(3);
  });

  it("keys the pair by Space so the same two Bots cannot collide across Spaces", async () => {
    const repo = createAgentPairRepository(fixture.prisma, OPEN_GATES);
    const first = await repo.getOrCreate({ spaceId, userId, botAId: botA, botBId: botB });
    const other = await repo.getOrCreate({
      spaceId: parseSpaceId("space-2"),
      userId,
      botAId: botA,
      botBId: botB,
    });

    expect(other.groupId).not.toBe(first.groupId);
    expect(fixture.chatGroupFindFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ spaceId: "space-2", kind: CHAT_GROUP_KIND_AGENT_PAIR }),
      }),
    );
  });
});
