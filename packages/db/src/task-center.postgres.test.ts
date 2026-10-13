import { randomUUID } from "node:crypto";
import { encodeTaskCenterCursor } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteArtifactRowWithDetachEvent } from "./artifact-versions.js";
import type { PrismaClient } from "./client.js";
import { appendEvent, clearThread } from "./events.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";
import { loadTaskCenterPage, TaskCenterCursorError } from "./task-center.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("task center read model (PostgreSQL)", () => {
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let actorSeq = 0;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("taskcenter");
    prisma = isolated.db.prisma;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  type ActorContext = {
    userId: string;
    spaceId: string;
    botA: string;
    threadA: string;
    botB: string;
    threadB: string;
  };

  /**
   * Every test gets its own user+space+bots so the global Task Center list
   * can be asserted exactly, without cross-test pollution.
   */
  async function newActor(): Promise<ActorContext> {
    const label = `tc${++actorSeq}-${randomUUID().slice(0, 8)}`;
    const userId = `${label}-user`;
    const spaceId = `${label}-space`;
    await prisma.user.create({
      data: { id: userId, name: "TC owner", email: `${label}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id: label, name: "TC org", slug: label, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId: label, name: "TC space" },
    });
    await prisma.member.create({
      data: {
        id: `${label}-member`,
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
    const botA = await makeBot(spaceId, userId, `${label}-a`);
    const botB = await makeBot(spaceId, userId, `${label}-b`);
    return {
      userId,
      spaceId,
      botA: botA.botId,
      threadA: botA.threadId,
      botB: botB.botId,
      threadB: botB.threadId,
    };
  }

  async function makeBot(spaceId: string, userId: string, name: string) {
    const botId = (await prisma.bot.create({ data: { spaceId, userId, name, color: "test" } })).id;
    const threadId = (await prisma.thread.create({ data: { spaceId, userId, botId } })).id;
    return { botId, threadId };
  }

  async function makeGroup(ctx: ActorContext, name: string) {
    const groupId = (
      await prisma.chatGroup.create({
        data: { spaceId: ctx.spaceId, userId: ctx.userId, name },
      })
    ).id;
    const memberBots = [
      await makeBot(ctx.spaceId, ctx.userId, `${name}-m1`),
      await makeBot(ctx.spaceId, ctx.userId, `${name}-m2`),
    ];
    for (const member of memberBots) {
      await prisma.chatGroupMember.create({ data: { groupId, botId: member.botId } });
    }
    const threadId = (
      await prisma.thread.create({ data: { spaceId: ctx.spaceId, userId: ctx.userId, groupId } })
    ).id;
    return { groupId, threadId, memberBots };
  }

  async function makeRun(input: {
    ctx: ActorContext;
    botId: string;
    threadId: string;
    status?: string;
    trigger?: string;
    orchestration?: unknown;
    prompt?: string;
  }) {
    const task = await prisma.task.create({
      data: {
        spaceId: input.ctx.spaceId,
        userId: input.ctx.userId,
        botId: input.botId,
        threadId: input.threadId,
        prompt: input.prompt ?? "Summarize the quarter",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: input.ctx.spaceId,
        userId: input.ctx.userId,
        botId: input.botId,
        threadId: input.threadId,
        taskId: task.id,
        status: input.status ?? "running",
        trigger: input.trigger ?? "user",
        ...(input.orchestration !== undefined
          ? { orchestration: input.orchestration as object }
          : {}),
      },
    });
    return run;
  }

  /** Deterministic server-sort-key placement (invisible write; no rev bump). */
  async function setUpdatedAt(runId: string, at: Date) {
    await prisma.$executeRaw`UPDATE runs SET "updatedAt" = ${at} WHERE id = ${runId}`;
  }

  async function terminalize(input: {
    ctx: ActorContext;
    runId: string;
    botId: string;
    threadId: string;
    status?: "completed" | "failed" | "cancelled";
  }) {
    const status = input.status ?? "completed";
    await prisma.run.update({
      where: { id: input.runId },
      data: {
        status,
        startedAt: new Date("2026-10-12T00:00:00.000Z"),
        completedAt: new Date("2026-10-12T00:01:00.000Z"),
      },
    });
    await appendEvent(prisma, {
      spaceId: input.ctx.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      runId: input.runId,
      type: `run.${status}`,
      payload: {},
    });
  }

  async function attachArtifact(ctx: ActorContext, runId: string, botId: string, name: string) {
    const artifact = await prisma.artifact.create({
      data: {
        spaceId: ctx.spaceId,
        userId: ctx.userId,
        botId,
        runId,
        name,
        mimeType: "text/plain",
        size: 4,
        hash: "h",
        storageKey: "s",
      },
    });
    return artifact;
  }

  const load = (ctx: ActorContext, input?: { cursor?: string; limit?: number }) =>
    loadTaskCenterPage(prisma, {
      spaceId: ctx.spaceId,
      userId: ctx.userId,
      ...(input?.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input?.limit !== undefined ? { limit: input.limit } : {}),
    });

  const collaborationOrchestration = (ownerBotId: string, parentRunId: string | null) => ({
    version: "v1",
    routing: { kind: "bot_message" },
    ownership: { mode: "support", ownerBotId },
    responseMode: "single",
    collaboration: {
      role: "support",
      source: "bot_message",
      fromBotId: ownerBotId,
      parentRunId,
      handoffDepth: 1,
      messageHop: 1,
    },
  });

  it("returns authorized root Runs across two bot Threads and a group Thread with targets", async () => {
    const ctx = await newActor();
    const group = await makeGroup(ctx, "Reviewers");
    const runA = await makeRun({ ctx, botId: ctx.botA, threadId: ctx.threadA });
    const runB = await makeRun({
      ctx,
      botId: ctx.botB,
      threadId: ctx.threadB,
      status: "waiting_input",
    });
    await prisma.run.update({ where: { id: runB.id }, data: { waitKind: "input" } });
    const runG = await makeRun({
      ctx,
      botId: group.memberBots[0]!.botId,
      threadId: group.threadId,
    });

    const page = await load(ctx);
    const byId = new Map(page.items.map((item) => [item.summary.runId, item]));
    expect([...byId.keys()].sort()).toEqual([runA.id, runB.id, runG.id].sort());
    expect(byId.get(runA.id)?.target).toEqual({ kind: "bot", botId: ctx.botA });
    expect(byId.get(runB.id)?.target).toEqual({ kind: "bot", botId: ctx.botB });
    expect(byId.get(runG.id)?.target).toEqual({ kind: "group", groupId: group.groupId });
    expect(page.activeCount).toBe(3);
    // ExecutionSummary stays the single source: real summary fields ride along.
    expect(byId.get(runA.id)?.summary.title).toBe("Summarize the quarter");
    expect(byId.get(runA.id)?.summary.status).toBe("running");
  });

  it("excludes collaboration sub-Runs and never lists BackgroundAgentTask projections", async () => {
    const ctx = await newActor();
    const parent = await makeRun({ ctx, botId: ctx.botA, threadId: ctx.threadA });
    const child = await makeRun({
      ctx,
      botId: ctx.botB,
      threadId: ctx.threadB,
      trigger: "bot_message",
      orchestration: collaborationOrchestration(ctx.botB, parent.id),
    });
    // A lineage WITHOUT a parent (owner-role resume) stays a root Run.
    const rootWithLineage = await makeRun({
      ctx,
      botId: ctx.botB,
      threadId: ctx.threadB,
      orchestration: collaborationOrchestration(ctx.botB, null),
    });
    // An empty-string parent is no parent (matches the core lineage parser).
    const emptyParent = await makeRun({
      ctx,
      botId: ctx.botA,
      threadId: ctx.threadA,
      orchestration: collaborationOrchestration(ctx.botA, ""),
    });
    // A native background subtask of the parent is a projection row, not a Run.
    await prisma.backgroundAgentTask.create({
      data: {
        taskId: `bat-${randomUUID()}`,
        parentRunId: parent.id,
        userId: ctx.userId,
        spaceId: ctx.spaceId,
        botId: ctx.botA,
        threadId: ctx.threadA,
        threadGeneration: 0,
        agentId: "agent-1",
        sessionId: "session-1",
        toolNames: [],
        status: "running",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const page = await load(ctx);
    const ids = page.items.map((item) => item.summary.runId);
    expect(ids).not.toContain(child.id);
    expect(ids).toContain(parent.id);
    expect(ids).toContain(rootWithLineage.id);
    expect(ids).toContain(emptyParent.id);
    expect(page.items).toHaveLength(3);
    expect(page.activeCount).toBe(3);
    // The parent's summary counts the subtask as a collaborator, honestly.
    const parentItem = page.items.find((item) => item.summary.runId === parent.id);
    expect(parentItem?.summary.counts?.agents).toBe(1);
  });

  it("returns every active Run and bounds the terminal window at 50", async () => {
    const ctx = await newActor();
    const actives = [];
    for (const status of ["queued", "leased", "running", "waiting_input", "waiting_takeover"]) {
      actives.push(await makeRun({ ctx, botId: ctx.botA, threadId: ctx.threadA, status }));
    }
    const base = Date.now();
    const terminals = [];
    for (let index = 0; index < 60; index += 1) {
      const run = await makeRun({
        ctx,
        botId: ctx.botB,
        threadId: ctx.threadB,
        status: "completed",
        prompt: `terminal-${index}`,
      });
      await terminalize({ ctx, runId: run.id, botId: ctx.botB, threadId: ctx.threadB });
      await setUpdatedAt(run.id, new Date(base - (60 - index) * 60_000));
      terminals.push(run);
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    let activeCount = -1;
    for (;;) {
      const page = await load(ctx, { limit: 100, ...(cursor ? { cursor } : {}) });
      activeCount = page.activeCount;
      for (const item of page.items) seen.add(item.summary.runId);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    // All five active statuses are present; the terminal window kept exactly
    // the 50 most recently updated (the 10 oldest are outside the window).
    for (const active of actives) expect(seen.has(active.id)).toBe(true);
    const terminalSeen = terminals.filter((run) => seen.has(run.id));
    expect(terminalSeen).toHaveLength(50);
    expect(terminalSeen.map((run) => run.id)).toEqual(terminals.slice(10).map((run) => run.id));
    expect(activeCount).toBe(5);
  }, 120_000);

  it("orders waiting before running before queued, then failed, completed, cancelled", async () => {
    const ctx = await newActor();
    const base = Date.now();
    const waiting = await makeRun({
      ctx,
      botId: ctx.botA,
      threadId: ctx.threadA,
      status: "waiting_input",
    });
    await prisma.run.update({ where: { id: waiting.id }, data: { waitKind: "approval" } });
    const running = await makeRun({ ctx, botId: ctx.botA, threadId: ctx.threadA });
    const queued = await makeRun({
      ctx,
      botId: ctx.botA,
      threadId: ctx.threadA,
      status: "queued",
    });
    const failed = await makeRun({
      ctx,
      botId: ctx.botB,
      threadId: ctx.threadB,
      status: "failed",
    });
    await terminalize({
      ctx,
      runId: failed.id,
      botId: ctx.botB,
      threadId: ctx.threadB,
      status: "failed",
    });
    const completed = await makeRun({
      ctx,
      botId: ctx.botB,
      threadId: ctx.threadB,
      status: "completed",
    });
    await terminalize({ ctx, runId: completed.id, botId: ctx.botB, threadId: ctx.threadB });
    const cancelled = await makeRun({
      ctx,
      botId: ctx.botB,
      threadId: ctx.threadB,
      status: "cancelled",
    });
    await terminalize({
      ctx,
      runId: cancelled.id,
      botId: ctx.botB,
      threadId: ctx.threadB,
      status: "cancelled",
    });

    //updatedAt deliberately favors the WRONG display order: the group
    // priority must win over recency (queued is the newest row).
    await setUpdatedAt(waiting.id, new Date(base - 5 * 60_000));
    await setUpdatedAt(running.id, new Date(base - 3 * 60_000));
    await setUpdatedAt(queued.id, new Date(base - 1 * 60_000));
    await setUpdatedAt(failed.id, new Date(base - 1 * 60_000));
    await setUpdatedAt(completed.id, new Date(base - 2 * 60_000));
    await setUpdatedAt(cancelled.id, new Date(base - 3 * 60_000));

    const page = await load(ctx);
    expect(page.items.map((item) => item.summary.runId)).toEqual([
      waiting.id,
      running.id,
      queued.id,
      failed.id,
      completed.id,
      cancelled.id,
    ]);
    expect(page.activeCount).toBe(3);
  });

  it("sorts within a group by updatedAt descending with a stable runId tie breaker", async () => {
    const ctx = await newActor();
    const base = Date.now();
    const same = new Date(base - 60_000);
    const older = await makeRun({ ctx, botId: ctx.botA, threadId: ctx.threadA, prompt: "older" });
    const newer = await makeRun({ ctx, botId: ctx.botA, threadId: ctx.threadA, prompt: "newer" });
    const twinA = await makeRun({ ctx, botId: ctx.botB, threadId: ctx.threadB, prompt: "twin-a" });
    const twinB = await makeRun({ ctx, botId: ctx.botB, threadId: ctx.threadB, prompt: "twin-b" });
    await setUpdatedAt(newer.id, new Date(base));
    await setUpdatedAt(older.id, new Date(base - 2 * 60_000));
    await setUpdatedAt(twinA.id, same);
    await setUpdatedAt(twinB.id, same);

    const page = await load(ctx);
    const order = page.items.map((item) => item.summary.runId);
    expect(order.slice(0, 3)).toEqual([newer.id, ...[twinA.id, twinB.id].sort().reverse()]);
    expect(order[3]).toBe(older.id);
    // The tie breaker is deterministic across repeated reads.
    const again = await load(ctx);
    expect(again.items.map((item) => item.summary.runId)).toEqual(order);
  });

  it("drops cleared Runs after Thread Clear and a later artifact detach never revives them", async () => {
    const ctx = await newActor();
    const stale = await makeRun({
      ctx,
      botId: ctx.botA,
      threadId: ctx.threadA,
      status: "completed",
    });
    await terminalize({ ctx, runId: stale.id, botId: ctx.botA, threadId: ctx.threadA });
    const artifact = await attachArtifact(ctx, stale.id, ctx.botA, "stale-chart.png");
    expect((await load(ctx)).items.map((item) => item.summary.runId)).toContain(stale.id);

    await clearThread(prisma, {
      spaceId: ctx.spaceId,
      threadId: ctx.threadA,
      botId: ctx.botA,
    });
    expect((await load(ctx)).items.map((item) => item.summary.runId)).not.toContain(stale.id);

    // Legal thread maintenance for the stale Run: a fresh thread.artifact
    // event naming it must NOT drag it back into the current generation.
    await prisma.$transaction((tx) =>
      deleteArtifactRowWithDetachEvent(tx, {
        id: artifact.id,
        runId: stale.id,
        name: artifact.name,
        mimeType: artifact.mimeType,
        size: artifact.size,
      }),
    );
    expect((await load(ctx)).items.map((item) => item.summary.runId)).not.toContain(stale.id);

    // A Run that terminates in the NEW generation is listed normally.
    const fresh = await makeRun({
      ctx,
      botId: ctx.botA,
      threadId: ctx.threadA,
      status: "completed",
    });
    await terminalize({ ctx, runId: fresh.id, botId: ctx.botA, threadId: ctx.threadA });
    expect((await load(ctx)).items.map((item) => item.summary.runId)).toEqual([fresh.id]);
  });

  it("removes items and counts when a bot or group is archived, or a group drops below its member minimum", async () => {
    const ctx = await newActor();
    const group = await makeGroup(ctx, "Standup");
    const botRun = await makeRun({ ctx, botId: ctx.botB, threadId: ctx.threadB });
    const groupRun = await makeRun({
      ctx,
      botId: group.memberBots[0]!.botId,
      threadId: group.threadId,
    });
    const keep = await makeRun({ ctx, botId: ctx.botA, threadId: ctx.threadA });
    expect((await load(ctx)).activeCount).toBe(3);

    await prisma.bot.update({ where: { id: ctx.botB }, data: { archivedAt: new Date() } });
    let page = await load(ctx);
    expect(page.items.map((item) => item.summary.runId)).not.toContain(botRun.id);
    expect(page.activeCount).toBe(2);

    await prisma.chatGroup.update({
      where: { id: group.groupId },
      data: { archivedAt: new Date() },
    });
    page = await load(ctx);
    expect(page.items.map((item) => item.summary.runId)).not.toContain(groupRun.id);
    expect(page.activeCount).toBe(1);
    expect(page.items.map((item) => item.summary.runId)).toEqual([keep.id]);

    // Restoring both brings the authorized items back (no permanent leak).
    await prisma.chatGroup.update({ where: { id: group.groupId }, data: { archivedAt: null } });
    await prisma.bot.update({ where: { id: ctx.botB }, data: { archivedAt: null } });
    expect((await load(ctx)).activeCount).toBe(3);

    // Archiving one member bot drops the group below GROUP_MEMBER_MIN, so its
    // Thread is no longer an accessible target and its Run disappears.
    await prisma.bot.update({
      where: { id: group.memberBots[1]!.botId },
      data: { archivedAt: new Date() },
    });
    page = await load(ctx);
    expect(page.items.map((item) => item.summary.runId)).not.toContain(groupRun.id);
    expect(page.activeCount).toBe(2);
  });

  it("never shows another Space's Runs, to either actor", async () => {
    const mine = await newActor();
    const foreign = await newActor();
    const theirRun = await makeRun({
      ctx: foreign,
      botId: foreign.botA,
      threadId: foreign.threadA,
    });
    const myRun = await makeRun({ ctx: mine, botId: mine.botA, threadId: mine.threadA });

    const page = await load(mine);
    expect(page.items.map((item) => item.summary.runId)).toEqual([myRun.id]);
    expect(page.activeCount).toBe(1);
    const theirs = await load(foreign);
    expect(theirs.items.map((item) => item.summary.runId)).toEqual([theirRun.id]);
  });

  it("pages by opaque cursor without duplicates and rejects foreign, version-mismatched and malformed cursors", async () => {
    const ctx = await newActor();
    const base = Date.now();
    const runs = [];
    for (let index = 0; index < 5; index += 1) {
      const run = await makeRun({
        ctx,
        botId: ctx.botA,
        threadId: ctx.threadA,
        status: "completed",
        prompt: `paged-${index}`,
      });
      await terminalize({ ctx, runId: run.id, botId: ctx.botA, threadId: ctx.threadA });
      await setUpdatedAt(run.id, new Date(base - index * 60_000));
      runs.push(run);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await load(ctx, { limit: 2, ...(cursor ? { cursor } : {}) });
      pages += 1;
      for (const item of page.items) seen.push(item.summary.runId);
      expect(page.activeCount).toBe(0);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(runs.map((run) => run.id));
    expect(new Set(seen).size).toBe(seen.length);

    // A cursor issued for another Space or another user is refused outright.
    const validFirst = await load(ctx, { limit: 2 });
    const foreignSpace = encodeTaskCenterCursor({
      v: 1,
      sp: "another-space",
      us: ctx.userId,
      p: 5,
      t: Date.now(),
      r: runs[1]!.id,
    });
    const foreignUser = encodeTaskCenterCursor({
      v: 1,
      sp: ctx.spaceId,
      us: "another-user",
      p: 5,
      t: Date.now(),
      r: runs[1]!.id,
    });
    await expect(load(ctx, { cursor: foreignSpace })).rejects.toBeInstanceOf(TaskCenterCursorError);
    await expect(load(ctx, { cursor: foreignUser })).rejects.toBeInstanceOf(TaskCenterCursorError);
    // A future layout version and garbage are rejected, never reinterpreted.
    const nextVersion = Buffer.from(
      JSON.stringify({ v: 2, sp: ctx.spaceId, us: ctx.userId, p: 5, t: 0, r: "x" }),
    ).toString("base64url");
    await expect(load(ctx, { cursor: nextVersion })).rejects.toBeInstanceOf(TaskCenterCursorError);
    await expect(load(ctx, { cursor: "not-a-real-cursor-value" })).rejects.toBeInstanceOf(
      TaskCenterCursorError,
    );
    // The honest cursor still works after the forged ones.
    const second = await load(ctx, { limit: 2, cursor: validFirst.nextCursor! });
    expect(second.items.map((item) => item.summary.runId)).toEqual([runs[2]!.id, runs[3]!.id]);
  });

  it("builds one page with a bounded query count regardless of the Run count (no per-Run fan-out)", async () => {
    const counted = withQueryCount(prisma);
    const small = await newActor();
    for (let index = 0; index < 3; index += 1) {
      const run = await makeRun({ ctx: small, botId: small.botA, threadId: small.threadA });
      await terminalize({ ctx: small, runId: run.id, botId: small.botA, threadId: small.threadA });
    }
    const beforeSmall = counted.count();
    await loadTaskCenterPage(counted.db, { spaceId: small.spaceId, userId: small.userId });
    const smallQueries = counted.count() - beforeSmall;

    const large = await newActor();
    for (let index = 0; index < 12; index += 1) {
      const run = await makeRun({ ctx: large, botId: large.botA, threadId: large.threadA });
      await terminalize({ ctx: large, runId: run.id, botId: large.botA, threadId: large.threadA });
    }
    const beforeLarge = counted.count();
    await loadTaskCenterPage(counted.db, { spaceId: large.spaceId, userId: large.userId });
    const largeQueries = counted.count() - beforeLarge;

    expect(smallQueries).toBe(largeQueries);
    expect(smallQueries).toBeLessThanOrEqual(30);
  });

  it("computes activeCount with the same authorization and generation rules as the list", async () => {
    const ctx = await newActor();
    const group = await makeGroup(ctx, "Ops");
    const root = await makeRun({ ctx, botId: ctx.botA, threadId: ctx.threadA });
    const sub = await makeRun({
      ctx,
      botId: ctx.botA,
      threadId: ctx.threadA,
      orchestration: collaborationOrchestration(ctx.botA, root.id),
    });
    const groupRun = await makeRun({
      ctx,
      botId: group.memberBots[0]!.botId,
      threadId: group.threadId,
    });
    const archivedBot = await makeBot(ctx.spaceId, ctx.userId, "archived-bot");
    await prisma.bot.update({ where: { id: archivedBot.botId }, data: { archivedAt: new Date() } });
    const archivedRun = await makeRun({
      ctx,
      botId: archivedBot.botId,
      threadId: archivedBot.threadId,
    });
    const terminal = await makeRun({
      ctx,
      botId: ctx.botB,
      threadId: ctx.threadB,
      status: "completed",
    });
    await terminalize({ ctx, runId: terminal.id, botId: ctx.botB, threadId: ctx.threadB });

    const page = await load(ctx);
    expect(page.activeCount).toBe(2);
    const ids = page.items.map((item) => item.summary.runId);
    expect(ids.sort()).toEqual([groupRun.id, root.id, terminal.id].sort());
    expect(ids).not.toContain(sub.id);
    expect(ids).not.toContain(archivedRun.id);
    const activeItems = page.items.filter((item) =>
      ["queued", "leased", "running", "waiting_input", "waiting_takeover"].includes(
        item.summary.status,
      ),
    );
    expect(activeItems).toHaveLength(page.activeCount);
  });

  it("serves both selections from indexes (no sequential scan over runs)", async () => {
    const ctx = await newActor();
    const run = await makeRun({
      ctx,
      botId: ctx.botA,
      threadId: ctx.threadA,
      status: "completed",
    });
    await terminalize({ ctx, runId: run.id, botId: ctx.botA, threadId: ctx.threadA });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SET LOCAL enable_seqscan = off`;
      const terminalPlan = await tx.$queryRaw<[{ plan: unknown }[]]>`
        EXPLAIN (FORMAT JSON)
        SELECT r.id FROM runs r
        JOIN threads t ON t.id = r."threadId"
        WHERE r."spaceId" = ${ctx.spaceId}
          AND r.status IN ('completed','failed','cancelled')
          AND NULLIF(r.orchestration->'collaboration'->>'parentRunId', '') IS NULL
          AND EXISTS (SELECT 1 FROM events e WHERE e."runId" = r.id AND e.type <> 'thread.artifact')
        ORDER BY r."updatedAt" DESC, r.id DESC
        LIMIT 50
      `;
      const planText = JSON.stringify(terminalPlan);
      expect(planText).not.toContain('"Seq Scan on runs"');
      // Any runs index whose leading column serves the Space/status filter is
      // acceptable; the point is that the selection never degrades to a
      // sequential scan over the whole table.
      expect(planText).toMatch(
        /runs_spaceId_clientNonce_key|runs_status_updatedAt_id_idx|runs_spaceId_botId_idx/,
      );
    });
  });

  /** Counts model + raw query calls without changing behavior. */
  function withQueryCount(db: PrismaClient): { db: PrismaClient; count: () => number } {
    let queries = 0;
    const modelNames = new Set([
      "run",
      "task",
      "message",
      "event",
      "artifact",
      "runStep",
      "runTodo",
      "runPlan",
      "backgroundAgentTask",
      "intervention",
    ]);
    const countedMethods = new Set(["findMany", "findFirst", "findUnique", "groupBy", "count"]);
    const proxy = new Proxy(db as unknown as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "$queryRaw" && typeof value === "function") {
          return (...args: unknown[]) => {
            queries += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        if (
          typeof prop === "string" &&
          modelNames.has(prop) &&
          value &&
          typeof value === "object"
        ) {
          return new Proxy(value as object, {
            get(modelTarget, modelProp, modelReceiver) {
              const modelValue = Reflect.get(modelTarget, modelProp, modelReceiver);
              if (typeof modelProp === "string" && countedMethods.has(modelProp)) {
                return (...args: unknown[]) => {
                  queries += 1;
                  return (modelValue as (...a: unknown[]) => unknown).apply(modelTarget, args);
                };
              }
              return modelValue;
            },
          });
        }
        if (typeof value === "function")
          return (value as (...a: unknown[]) => unknown).bind(target);
        return value;
      },
    }) as PrismaClient;
    return { db: proxy, count: () => queries };
  }
});
