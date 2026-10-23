import { randomUUID } from "node:crypto";
import { messageBot } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  IsolationError,
  lockOwnedStandardGroupThread,
  lockOwnedStandardGroupThreadByGroupId,
  type PrismaClient,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendThreadMessage, type ThreadTarget } from "./thread-target.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

const ROUNDS = Number(process.env.RT06F_ROUNDS ?? "20");

type Trace = {
  locks: string[];
  conflicts: unknown[];
};

function databaseCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  if (candidate.code === "P2034") return "P2034";
  const code = candidate.meta?.driverAdapterError?.cause?.originalCode;
  return typeof code === "string" ? code : undefined;
}

function rawSql(args: readonly unknown[]): string {
  const strings = args[0];
  if (!Array.isArray(strings)) return "";
  return strings.join("?");
}

function isLockStatement(sql: string): boolean {
  return /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i.test(sql);
}

function createFirstLockBarrier(timeoutMs = 75) {
  let arrivals = 0;
  let release: () => void = () => undefined;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    /**
     * Both transactions pause after their first lock. Under the old inverted
     * order both acquire a different row and then deadlock; under the shared
     * thread-first order the second transaction cannot reach the barrier, so a
     * bounded fallback releases the first instead of hanging the test.
     */
    async arrive() {
      arrivals += 1;
      if (arrivals >= 2) release();
      await Promise.race([
        bothArrived,
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    },
  };
}

/** Wraps one operation's Prisma client and records actual row locks. */
function instrumentPrisma(
  prisma: PrismaClient,
  trace: Trace,
  barrier: ReturnType<typeof createFirstLockBarrier>,
): PrismaClient {
  return new Proxy(prisma, {
    get(target, property) {
      if (property !== "$transaction") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (callback: (tx: never) => Promise<unknown>, options?: unknown) => {
        try {
          return await target.$transaction(async (tx) => {
            let arrived = false;
            const recordLock = async (label: string) => {
              trace.locks.push(label.replace(/\s+/g, " ").trim());
              if (!arrived) {
                arrived = true;
                await barrier.arrive();
              }
            };
            const wrapped = new Proxy(tx, {
              get(txTarget, txProperty) {
                if (txProperty === "thread" || txProperty === "chatGroup") {
                  const delegate = Reflect.get(txTarget, txProperty) as object;
                  return new Proxy(delegate, {
                    get(delegateTarget, method) {
                      const value = Reflect.get(delegateTarget, method);
                      if (
                        typeof value !== "function" ||
                        !["update", "updateMany", "delete", "deleteMany"].includes(String(method))
                      ) {
                        return typeof value === "function" ? value.bind(delegateTarget) : value;
                      }
                      return async (...args: unknown[]) => {
                        await recordLock(`${String(method)} ${String(txProperty)}`);
                        return (value as (...input: unknown[]) => Promise<unknown>).apply(
                          delegateTarget,
                          args,
                        );
                      };
                    },
                  });
                }
                if (txProperty !== "$queryRaw") {
                  const value = Reflect.get(txTarget, txProperty);
                  return typeof value === "function" ? value.bind(txTarget) : value;
                }
                return async (...args: unknown[]) => {
                  const result = await txTarget.$queryRaw(...(args as [TemplateStringsArray]));
                  const sql = rawSql(args);
                  if (isLockStatement(sql)) await recordLock(sql);
                  return result;
                };
              },
            });
            return callback(wrapped as never);
          }, options as never);
        } catch (error) {
          if (databaseCode(error)) trace.conflicts.push(error);
          throw error;
        }
      };
    },
  }) as PrismaClient;
}

/** Runs `hook` from a second connection after the transaction's first row lock. */
function withAfterFirstLock(prisma: PrismaClient, hook: () => Promise<void>): PrismaClient {
  return new Proxy(prisma, {
    get(target, property) {
      if (property !== "$transaction") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (callback: (tx: never) => Promise<unknown>, options?: unknown) => {
        return target.$transaction(async (tx) => {
          let ran = false;
          const wrapped = new Proxy(tx, {
            get(txTarget, txProperty) {
              if (txProperty !== "$queryRaw") {
                const value = Reflect.get(txTarget, txProperty);
                return typeof value === "function" ? value.bind(txTarget) : value;
              }
              return async (...args: unknown[]) => {
                const result = await txTarget.$queryRaw(...(args as [TemplateStringsArray]));
                if (!ran) {
                  ran = true;
                  await hook();
                }
                return result;
              };
            },
          });
          return callback(wrapped as never);
        }, options as never);
      };
    },
  }) as PrismaClient;
}

function expectThreadBeforeGroup(locks: string[]) {
  const first = locks[0] ?? "";
  expect(first).toMatch(/\bFROM\s+threads\b|\bUPDATE\s+threads\b/i);
  const group = locks.findIndex((sql) =>
    /\bFROM\s+chat_groups\b|\bUPDATE\s+chat_groups\b/i.test(sql),
  );
  if (group >= 0) {
    const thread = locks.findIndex((sql) => /\bFROM\s+threads\b|\bUPDATE\s+threads\b/i.test(sql));
    expect(thread).toBeGreaterThanOrEqual(0);
    expect(group).toBeGreaterThan(thread);
  }
}

describePostgres("RT-06F group/thread lock order (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let actor: Actor;
  let senderBot: { id: string; name: string };
  let sendTargetBot: { id: string; name: string };
  let publicTargetBot: { id: string; name: string };

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("group_thread_lock");
    prisma = isolated.db.prisma;
    await prisma.user.create({
      data: { id, name: "RT-06F owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "RT-06F", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "RT-06F" } });
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
    const first = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Sender", color: "test" },
    });
    const second = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Send target", color: "test" },
    });
    const third = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Public target", color: "test" },
    });
    senderBot = { id: first.id, name: first.name };
    sendTargetBot = { id: second.id, name: second.name };
    publicTargetBot = { id: third.id, name: third.name };
    actor = { userId: id, spaceId: id, email: `${id}@example.test`, isDeploymentOwner: true };
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  async function createRoundFixture(round: number) {
    const group = await prisma.chatGroup.create({
      data: {
        spaceId: id,
        userId: id,
        name: `Lock order ${round}`,
        kind: "standard",
        leadBotId: sendTargetBot.id,
      },
    });
    await prisma.chatGroupMember.createMany({
      data: [
        { groupId: group.id, botId: senderBot.id },
        { groupId: group.id, botId: sendTargetBot.id },
        { groupId: group.id, botId: publicTargetBot.id },
      ],
    });
    const thread = await prisma.thread.create({
      data: { spaceId: id, userId: id, groupId: group.id },
    });
    const sourceTask = await prisma.task.create({
      data: {
        spaceId: id,
        botId: senderBot.id,
        threadId: thread.id,
        userId: id,
        prompt: "public dispatch source",
        status: "running",
      },
    });
    const sourceRun = await prisma.run.create({
      data: {
        spaceId: id,
        botId: senderBot.id,
        threadId: thread.id,
        taskId: sourceTask.id,
        userId: id,
        status: "running",
        trigger: "user",
      },
    });
    return { group, thread, sourceRun };
  }

  it("completes group send and public dispatch once each without deadlock", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const fixture = await createRoundFixture(round);
      const sendNonce = `rt06f-send-${round}`;
      const deliveryKey = `rt06f-public-${round}`;
      const publicNonce = `bot-message:${deliveryKey}`;
      const sendTrace: Trace = { locks: [], conflicts: [] };
      const publicTrace: Trace = { locks: [], conflicts: [] };
      const barrier = createFirstLockBarrier();
      const sendPrisma = instrumentPrisma(prisma, sendTrace, barrier);
      const publicPrisma = instrumentPrisma(prisma, publicTrace, barrier);
      const roundTarget: Extract<ThreadTarget, { kind: "group" }> = {
        kind: "group",
        groupId: fixture.group.id,
        threadId: fixture.thread.id,
        spaceId: id,
        groupName: fixture.group.name,
        leadBotId: sendTargetBot.id,
        members: [],
        memberBotIds: [senderBot.id, sendTargetBot.id, publicTargetBot.id],
      };

      let releaseStart: () => void = () => undefined;
      const start = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      const send = (async () => {
        await start;
        return sendThreadMessage(
          {
            prisma: sendPrisma,
            events: { notify: async () => undefined } as never,
            jobs: { enqueue: async () => undefined } as never,
          },
          actor,
          roundTarget,
          { text: `send ${round}`, clientNonce: sendNonce },
        );
      })();
      const dispatch = (async () => {
        await start;
        return messageBot(
          {
            prisma: publicPrisma,
            events: { notify: async () => undefined },
            jobs: { enqueue: async () => undefined },
            roundtableFeatures: {
              private_pair: false,
              public_collaboration: true,
              message_group: false,
              background_helper: false,
            },
          },
          {
            id: fixture.sourceRun.id,
            spaceId: id,
            threadId: fixture.thread.id,
            botId: senderBot.id,
            userId: id,
            sourceMessageId: null,
          },
          senderBot,
          {
            bot_id: publicTargetBot.id,
            message: `dispatch ${round}`,
            intent: "request",
            deliveryKey,
          },
        );
      })();
      releaseStart();
      const settled = await Promise.allSettled([send, dispatch]);

      expect(sendTrace.conflicts, `round ${round} send conflicts`).toEqual([]);
      expect(publicTrace.conflicts, `round ${round} dispatch conflicts`).toEqual([]);
      expect(
        settled.map((result) =>
          result.status === "fulfilled" ? "fulfilled" : String(result.reason),
        ),
      ).toEqual(["fulfilled", "fulfilled"]);
      const sent = settled[0].status === "fulfilled" ? settled[0].value : undefined;
      const posted = settled[1].status === "fulfilled" ? settled[1].value : undefined;
      expect(sent).toMatchObject({ runId: expect.any(String) });
      expect(posted).toMatchObject({ ok: true, botId: publicTargetBot.id });

      expectThreadBeforeGroup(sendTrace.locks);
      expectThreadBeforeGroup(publicTrace.locks);

      const threadId = fixture.thread.id;
      const sentMessage = await prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId, clientNonce: sendNonce } },
      });
      const inbound = await prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId, clientNonce: publicNonce } },
      });
      expect(sentMessage).not.toBeNull();
      expect(inbound).not.toBeNull();

      expect(await prisma.message.count({ where: { threadId } })).toBe(3);
      expect(await prisma.message.count({ where: { threadId, role: "user" } })).toBe(2);
      expect(await prisma.message.count({ where: { threadId, role: "bot" } })).toBe(1);
      expect(await prisma.task.count({ where: { threadId } })).toBe(3);
      expect(await prisma.run.count({ where: { threadId } })).toBe(3);

      const sendRun = await prisma.run.findFirst({
        where: {
          threadId,
          clientNonce: `send:${sentMessage?.id}:${sendTargetBot.id}`,
        },
        select: { id: true, taskId: true, sourceMessageId: true },
      });
      const publicRun = await prisma.run.findFirst({
        where: { threadId, sourceMessageId: inbound?.id },
        select: { id: true, taskId: true, sourceMessageId: true },
      });
      expect(sendRun?.sourceMessageId).toBe(sentMessage?.id);
      expect(publicRun).not.toBeNull();
      expect(publicRun?.id).toBe(posted && "targetRunId" in posted ? posted.targetRunId : null);

      for (const run of [sendRun, publicRun]) {
        expect(run).not.toBeNull();
        const task = await prisma.task.findUnique({
          where: { id: run?.taskId },
          select: { threadId: true, runs: { select: { id: true } } },
        });
        expect(task?.threadId).toBe(threadId);
        expect(task?.runs.map((row) => row.id)).toEqual([run?.id]);
      }

      const created = await prisma.event.findMany({
        where: { threadId, type: "thread.message.created" },
        select: { payload: true },
      });
      const createdIds = created.map((event) => {
        const payload = event.payload as { messageId?: unknown } | null;
        return typeof payload?.messageId === "string" ? payload.messageId : null;
      });
      expect(createdIds).toHaveLength(3);
      expect(new Set(createdIds).size).toBe(3);
      expect(await prisma.event.count({ where: { threadId, type: "thread.turn.routed" } })).toBe(1);
      expect(
        await prisma.event.count({
          where: { threadId, type: "thread.collaboration.requested" },
        }),
      ).toBe(1);

      const messagesWithRun = await prisma.message.count({
        where: { threadId, runId: null },
      });
      expect(messagesWithRun).toBe(0);
      const tasksWithoutRuns = await prisma.task.count({
        where: { threadId, runs: { none: {} } },
      });
      expect(tasksWithoutRuns).toBe(0);
      const [runsWithoutTasks] = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        FROM runs AS run
        LEFT JOIN tasks AS task ON task.id = run."taskId"
        WHERE run."threadId" = ${threadId} AND task.id IS NULL
      `;
      expect(runsWithoutTasks?.count).toBe(0);
    }
  }, 240_000);

  it("re-reads and rejects state that changed after the thread lock", async () => {
    const fixture = await createRoundFixture(1000);
    const archivedAt = new Date();
    const hooked = withAfterFirstLock(prisma, async () => {
      await prisma.chatGroup.update({
        where: { id: fixture.group.id },
        data: { archivedAt },
      });
    });

    await expect(
      hooked.$transaction((tx) =>
        lockOwnedStandardGroupThread(tx, actor, {
          groupId: fixture.group.id,
          threadId: fixture.thread.id,
        }),
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      prisma.chatGroup.findUniqueOrThrow({
        where: { id: fixture.group.id },
        select: { archivedAt: true },
      }),
    ).resolves.toEqual({ archivedAt });
  });

  it("rejects archived, foreign, mismatched, and agent-pair groups under lock", async () => {
    const standard = await createRoundFixture(1001);
    await expect(
      prisma.$transaction((tx) =>
        lockOwnedStandardGroupThreadByGroupId(tx, actor, standard.group.id),
      ),
    ).resolves.toMatchObject({
      groupId: standard.group.id,
      threadId: standard.thread.id,
      name: standard.group.name,
    });

    const archived = await createRoundFixture(1002);
    await prisma.chatGroup.update({
      where: { id: archived.group.id },
      data: { archivedAt: new Date() },
    });
    await expect(
      prisma.$transaction((tx) =>
        lockOwnedStandardGroupThread(tx, actor, {
          groupId: archived.group.id,
          threadId: archived.thread.id,
        }),
      ),
    ).rejects.toBeInstanceOf(IsolationError);

    const foreign = await createRoundFixture(1003);
    await expect(
      prisma.$transaction((tx) =>
        lockOwnedStandardGroupThread(
          tx,
          { ...actor, userId: randomUUID() },
          { groupId: foreign.group.id, threadId: foreign.thread.id },
        ),
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      prisma.$transaction((tx) =>
        lockOwnedStandardGroupThread(
          tx,
          { ...actor, spaceId: randomUUID() },
          { groupId: foreign.group.id, threadId: foreign.thread.id },
        ),
      ),
    ).rejects.toBeInstanceOf(IsolationError);

    // A caller that only knows a foreign group id must not lock its Thread
    // before authorization; otherwise any guessed id becomes a lock lever.
    const foreignTrace: Trace = { locks: [], conflicts: [] };
    const foreignClient = instrumentPrisma(prisma, foreignTrace, createFirstLockBarrier());
    for (const intruder of [
      { ...actor, userId: randomUUID() },
      { ...actor, spaceId: randomUUID() },
    ]) {
      await expect(
        foreignClient.$transaction((tx) =>
          lockOwnedStandardGroupThreadByGroupId(tx, intruder, foreign.group.id),
        ),
      ).rejects.toBeInstanceOf(IsolationError);
    }
    expect(foreignTrace.locks).toEqual([]);

    const other = await createRoundFixture(1004);
    await expect(
      prisma.$transaction((tx) =>
        lockOwnedStandardGroupThread(tx, actor, {
          groupId: foreign.group.id,
          threadId: other.thread.id,
        }),
      ),
    ).rejects.toBeInstanceOf(IsolationError);

    const pair = await prisma.chatGroup.create({
      data: {
        spaceId: id,
        userId: id,
        name: "Agent pair",
        kind: "agent_pair",
        pairKey: randomUUID(),
        leadBotId: sendTargetBot.id,
      },
    });
    const pairThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, groupId: pair.id },
    });
    await expect(
      prisma.$transaction((tx) =>
        lockOwnedStandardGroupThread(tx, actor, {
          groupId: pair.id,
          threadId: pairThread.id,
        }),
      ),
    ).rejects.toBeInstanceOf(IsolationError);
  }, 60_000);
});
