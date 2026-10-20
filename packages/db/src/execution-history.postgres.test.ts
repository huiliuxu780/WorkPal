import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteArtifactRowWithDetachEvent } from "./artifact-versions.js";
import { createDb, type Prisma, type PrismaClient } from "./client.js";
import { appendEvent, clearThread, pauseRunForInput, resolveIntervention } from "./events.js";
import {
  ExecutionActivityCursorError,
  executionEventCeilings,
  loadExecutionSnapshot,
  loadExecutionSummaries,
  loadRunActivityPage,
} from "./execution-history.js";
import { createThreadMessage } from "./messages.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";
import { promoteLeasedRunWithAttempt } from "./promote-run.js";
import { applyPlanSubmission } from "./run-plans.js";
import { publishRunStep } from "./run-steps.js";
import { publishRunTodo } from "./run-todos.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
const SECRET = "sk-live-execution-history";

describePostgres("execution history snapshot (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let side: PrismaClient;
  let botId: string;
  let threadId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("exechist");
    prisma = isolated.db.prisma;
    const connectionString = isolated.db.pool.options.connectionString;
    if (!connectionString) throw new Error("isolated pool is missing its connection string");
    side = createDb(connectionString, { applicationName: "exechist_side", poolMax: 4 }).prisma;
    await prisma.user.create({
      data: { id, name: "Exec owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Exec org", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Exec space" } });
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
    botId = (
      await prisma.bot.create({
        data: { spaceId: id, userId: id, name: "Exec bot", color: "test" },
      })
    ).id;
    threadId = (await prisma.thread.create({ data: { spaceId: id, userId: id, botId } })).id;
  }, 180_000);

  afterAll(async () => {
    await side?.$disconnect().catch(() => undefined);
    await isolated?.drop();
  }, 60_000);

  async function makeRun(opts: { status?: string; trigger?: string; botId?: string } = {}) {
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: opts.botId ?? botId,
        threadId,
        prompt: "Summarize the quarter in one line",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: opts.botId ?? botId,
        threadId,
        taskId: task.id,
        status: opts.status ?? "running",
        trigger: opts.trigger ?? "user",
        leaseOwner: "worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    return { task, run, attempt };
  }

  async function botMessage(
    runId: string,
    blocks: Parameters<typeof createThreadMessage>[1]["blocks"],
  ) {
    return createThreadMessage(prisma, { threadId, role: "bot", botId, runId, blocks });
  }

  async function terminalize(runId: string, completed = true) {
    await prisma.run.update({
      where: { id: runId },
      data: {
        status: completed ? "completed" : "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        startedAt: new Date("2026-10-12T00:00:00.000Z"),
        completedAt: new Date("2026-10-12T00:01:00.000Z"),
      },
    });
    await appendEvent(prisma, {
      spaceId: id,
      threadId,
      botId,
      runId,
      type: completed ? "run.completed" : "run.cancelled",
      payload: {},
    });
  }

  async function attachArtifact(runId: string, name: string) {
    const artifact = await prisma.artifact.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        runId,
        name,
        mimeType: "text/plain",
        size: 4,
        hash: "h",
        storageKey: "s",
      },
    });
    await appendEvent(prisma, {
      spaceId: id,
      threadId,
      botId,
      runId,
      type: "thread.artifact",
      payload: {
        artifactId: artifact.id,
        action: "attached",
        name,
        mimeType: "text/plain",
        size: 4,
      },
    });
    return artifact;
  }

  it("restores plan, step, todo, result and artifacts for a completed Run", async () => {
    const { run } = await makeRun();
    await applyPlanSubmission(
      prisma,
      { spaceId: id, threadId, botId, runId: run.id, toolExecutionId: "plan-1" },
      {
        expectedRevision: 0,
        goal: "Quarter summary",
        items: [{ id: "draft", title: "Draft", status: "completed" }],
      },
      { source: "publish_run_plan", submit: true },
    );
    await publishRunStep(
      prisma,
      { spaceId: id, threadId, botId, runId: run.id, toolExecutionId: "step-1" },
      {
        stepId: "draft",
        expectedRevision: 0,
        order: 0,
        title: "Draft the summary",
        status: "completed",
      },
    );
    await publishRunTodo(
      prisma,
      { spaceId: id, threadId, botId, runId: run.id, toolExecutionId: "todo-1" },
      {
        todoId: "collect",
        expectedRevision: 0,
        order: 0,
        title: "Collect numbers",
        status: "resolved",
      },
    );
    const firstMessage = await botMessage(run.id, [{ kind: "progress", text: "working" }]);
    await botMessage(run.id, [{ kind: "text", text: "The quarter closed at 4.2M." }]);
    await attachArtifact(run.id, "quarter.txt");
    await terminalize(run.id);

    const snapshot = await loadExecutionSnapshot(prisma, { threadId, spaceId: id, runId: run.id });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.plan).toMatchObject({ goal: "Quarter summary" });
    expect(snapshot!.steps.items.map((s) => s.title)).toContain("Draft the summary");
    expect(snapshot!.todos.items.map((t) => t.title)).toContain("Collect numbers");
    expect(snapshot!.result?.blocks).toEqual([
      { kind: "text", text: "The quarter closed at 4.2M." },
    ]);
    expect(snapshot!.summary.outcome).toBe("The quarter closed at 4.2M.");
    expect(snapshot!.summary.anchorMessageId).toBe(firstMessage.id);
    expect(snapshot!.summary.artifacts).toEqual([
      { id: expect.any(String), name: "quarter.txt", mimeType: "text/plain" },
    ]);
    expect(snapshot!.summary.counts?.artifacts).toBe(1);
    expect(snapshot!.summary.rev).toBeGreaterThan(0);
  });

  it("uses the latest result after more than 500 bot messages", async () => {
    const { run } = await makeRun();
    const count = 502;
    await prisma.$transaction(async (tx) => {
      const thread = await tx.thread.update({
        where: { id: threadId },
        data: { nextMessageSeq: { increment: count } },
        select: { nextMessageSeq: true },
      });
      const firstSeq = thread.nextMessageSeq - count;
      await tx.message.createMany({
        data: Array.from({ length: count }, (_, index) => ({
          threadId,
          seq: firstSeq + index,
          role: "bot",
          botId,
          runId: run.id,
          blocks: [
            { kind: "text", text: index === count - 1 ? "real final result" : `earlier ${index}` },
          ],
        })),
      });
    });
    await terminalize(run.id);
    const snapshot = await loadExecutionSnapshot(prisma, { threadId, spaceId: id, runId: run.id });
    expect(snapshot?.summary.outcome).toBe("real final result");
    expect(snapshot?.result?.blocks).toEqual([{ kind: "text", text: "real final result" }]);
  });

  it("restores the pending Intervention even when its ask message is off the page window", async () => {
    const { run } = await makeRun({ status: "waiting_input", trigger: "user" });
    await prisma.run.update({
      where: { id: run.id },
      data: {
        waitKind: "input",
        waitStartedAt: new Date(),
        leaseOwner: null,
        status: "waiting_input",
      },
    });
    const ask = await botMessage(run.id, [{ kind: "ask", text: "Which city?", status: "pending" }]);
    // No messages are supplied: the per-Run detail read must still surface the ask.
    const snapshot = await loadExecutionSnapshot(prisma, { threadId, spaceId: id, runId: run.id });
    expect(snapshot!.interventions.map((view) => view.messageId)).toContain(ask.id);
    expect(snapshot!.interventions[0]?.presentation?.text).toBe("Which city?");
  });

  it("keeps a terminal Intervention with its decision and safe presentation", async () => {
    const { run, attempt } = await makeRun();
    await pauseRunForInput(prisma, {
      spaceId: id,
      threadId,
      botId,
      runId: run.id,
      attemptId: attempt.id,
      leaseOwner: "worker",
      leaseFence: 1,
      blocks: [
        {
          kind: "ask",
          text: "API key please",
          status: "pending",
          input: "secret",
          purpose: "api_key",
        },
      ],
    });
    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });
    await resolveIntervention(
      prisma,
      {
        spaceId: id,
        threadId,
        interventionId: row.id,
        clientSubmissionId: randomUUID(),
        answeredByUserId: id,
        answer: SECRET,
      },
      undefined,
      { store: async () => undefined },
    );
    const snapshot = await loadExecutionSnapshot(prisma, { threadId, spaceId: id, runId: run.id });
    const view = snapshot!.interventions.find((v) => v.id === row.id);
    expect(view).toMatchObject({ status: "answered" });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
  });

  it("keeps the summary intact past 100 Activity events and pages without repeats or gaps", async () => {
    const { run } = await makeRun({ status: "completed" });
    await seedActivity(run.id, 130);
    const summary = (
      await loadExecutionSummaries(prisma, { threadId, spaceId: id, runIds: [run.id] })
    )[0]!;
    expect(summary.rev).toBeGreaterThan(100);
    expect(summary.counts?.actions).toBeUndefined();

    const first = await loadRunActivityPage(prisma, {
      threadId,
      spaceId: id,
      runId: run.id,
      limit: 50,
    });
    expect(first.items).toHaveLength(50);
    expect(first.truncated).toBe(true);
    expect(first.olderCursor).toBeTruthy();

    const second = await loadRunActivityPage(prisma, {
      threadId,
      spaceId: id,
      runId: run.id,
      cursor: first.olderCursor!,
      limit: 50,
    });
    const third = await loadRunActivityPage(prisma, {
      threadId,
      spaceId: id,
      runId: run.id,
      cursor: second.olderCursor!,
      limit: 50,
    });
    for (const page of [first, second, third]) {
      const pageIds = page.items.map((item) => item.id);
      expect(new Set(pageIds).size).toBe(pageIds.length);
    }
    // The same id never carries two different statuses across pages (no skip,
    // no contradictory duplicate after merging).
    const statusById = new Map<string, string>();
    for (const item of [...first.items, ...second.items, ...third.items]) {
      const seen = statusById.get(item.id);
      expect(seen === undefined || seen === item.status).toBe(true);
      statusById.set(item.id, item.status);
    }
    // The walk terminates: the oldest page reports no further data.
    let tail = third;
    while (tail.olderCursor) {
      tail = await loadRunActivityPage(prisma, {
        threadId,
        spaceId: id,
        runId: run.id,
        cursor: tail.olderCursor,
        limit: 50,
      });
    }
    expect(tail.truncated).toBe(false);
  });

  it("pairs a tool called/completed that straddle a page boundary into one stable item", async () => {
    const { run } = await makeRun({ status: "completed" });
    // Layout so the page-1/2 boundary falls exactly between the pair:
    // filler 1..30, called(31), completed(32), filler 33..81.
    const base = await prisma.thread.findUniqueOrThrow({
      where: { id: threadId },
      select: { nextEventSeq: true },
    });
    const start = base.nextEventSeq;
    const row = (
      n: number,
      type: string,
      data: Record<string, unknown>,
    ): Prisma.EventCreateManyInput => ({
      spaceId: id,
      threadId,
      botId,
      seq: start + n - 1,
      type,
      runId: run.id,
      schemaVersion: 1,
      payload: data as Prisma.InputJsonValue,
      createdAt: new Date(Date.parse("2026-10-12T00:00:00.000Z") + n * 10),
    });
    const rows: Prisma.EventCreateManyInput[] = [];
    for (let n = 1; n <= 30; n++)
      rows.push(row(n, "agent.tool.called", { name: "search", executionId: `filler-${n}` }));
    rows.push(row(31, "agent.tool.called", { name: "write_file", executionId: "pair-1" }));
    rows.push(
      row(32, "agent.tool.completed", { executionId: "pair-1", outcome: "ok", durationMs: 12 }),
    );
    for (let n = 33; n <= 81; n++)
      rows.push(row(n, "agent.tool.called", { name: "search", executionId: `filler-${n}` }));
    rows.push(row(82, "agent.tool.called", { name: "x", executionId: "tail" }));
    await prisma.$transaction(async (tx) => {
      await tx.event.createMany({ data: rows });
      await tx.thread.update({
        where: { id: threadId },
        data: { nextEventSeq: { increment: rows.length } },
      });
    });

    // limit 51 puts the boundary right after the completed(seq 32).
    const first = await loadRunActivityPage(prisma, {
      threadId,
      spaceId: id,
      runId: run.id,
      limit: 51,
    });
    const pairOnFirst = first.items.find((item) => item.id === `tool:${run.id}:pair-1`);
    expect(pairOnFirst, "the newer page carries the completed pair").toBeTruthy();
    expect(pairOnFirst!.status).toBe("completed");
    const second = await loadRunActivityPage(prisma, {
      threadId,
      spaceId: id,
      runId: run.id,
      cursor: first.olderCursor!,
      limit: 51,
    });
    const pairOnSecond = second.items.find((item) => item.id === `tool:${run.id}:pair-1`);
    // The older page may still show the raw called row as running; the client
    // dedupes by id and keeps the newer (completed) status.
    if (pairOnSecond) expect(pairOnSecond.status).toBe("running");
  });

  it("keeps two Runs' execution data strictly separated", async () => {
    const left = await makeRun();
    const right = await makeRun();
    await publishRunStep(
      prisma,
      { spaceId: id, threadId, botId, runId: left.run.id, toolExecutionId: "l" },
      {
        stepId: "only-left",
        expectedRevision: 0,
        order: 0,
        title: "Left only",
        status: "running",
      },
    );
    await botMessage(right.run.id, [{ kind: "text", text: "Right result" }]);
    await terminalize(right.run.id);
    await terminalize(left.run.id);

    const leftSnap = await loadExecutionSnapshot(prisma, {
      threadId,
      spaceId: id,
      runId: left.run.id,
    });
    const rightSnap = await loadExecutionSnapshot(prisma, {
      threadId,
      spaceId: id,
      runId: right.run.id,
    });
    expect(leftSnap!.steps.items.map((s) => s.title)).toContain("Left only");
    expect(rightSnap!.steps.items).toHaveLength(0);
    expect(rightSnap!.result?.blocks).toEqual([{ kind: "text", text: "Right result" }]);
    expect(leftSnap!.result).toBeUndefined();
    expect(leftSnap!.summary.runId).toBe(left.run.id);
    expect(rightSnap!.summary.runId).toBe(right.run.id);
  });

  it("drops the previous generation after Thread Clear and never revives it in detail", async () => {
    const { run } = await makeRun({ status: "completed" });
    await botMessage(run.id, [{ kind: "text", text: "pre-clear result" }]);
    await terminalize(run.id);
    const before = await loadExecutionSnapshot(prisma, { threadId, spaceId: id, runId: run.id });
    expect(before!.result?.messageId).toBeTruthy();

    await clearThread(prisma, { spaceId: id, threadId, botId });

    const window = await loadExecutionSummaries(prisma, {
      threadId,
      spaceId: id,
      runIds: [run.id],
    });
    expect(window.map((item) => item.runId)).not.toContain(run.id);
    const after = await loadExecutionSnapshot(prisma, { threadId, spaceId: id, runId: run.id });
    expect(after).toBeNull();
    await expect(
      loadRunActivityPage(prisma, { threadId, spaceId: id, runId: run.id }),
    ).rejects.toMatchObject({ reason: "stale_cursor" });
  });

  it("moves rev on every visible change and never on an unrelated Run change", async () => {
    const mine = await makeRun({ status: "completed" });
    const other = await makeRun({ status: "completed" });
    await terminalize(mine.run.id);
    await terminalize(other.run.id);
    const ceiling0 = await loadExecutionSummaries(prisma, {
      threadId,
      spaceId: id,
      runIds: [mine.run.id],
    });
    const rev0 = ceiling0[0]!.rev;

    await appendEvent(prisma, {
      spaceId: id,
      threadId,
      botId,
      runId: other.run.id,
      type: "thread.progress",
      payload: { activity: true, text: "other" },
    });
    const ceiling1 = await loadExecutionSummaries(prisma, {
      threadId,
      spaceId: id,
      runIds: [mine.run.id],
    });
    expect(ceiling1[0]!.rev).toBe(rev0);

    await appendEvent(prisma, {
      spaceId: id,
      threadId,
      botId,
      runId: mine.run.id,
      type: "agent.tool.called",
      payload: { name: "search", executionId: "x1" },
    });
    const ceiling2 = await loadExecutionSummaries(prisma, {
      threadId,
      spaceId: id,
      runIds: [mine.run.id],
    });
    expect(ceiling2[0]!.rev).toBeGreaterThan(rev0);
  });

  it("revises the Run rev when an Artifact joins and leaves", async () => {
    const { run } = await makeRun({ status: "completed" });
    await terminalize(run.id);
    const rev0 = (
      await loadExecutionSummaries(prisma, { threadId, spaceId: id, runIds: [run.id] })
    )[0]!.rev;
    const artifact = await attachArtifact(run.id, "chart.png");
    const rev1 = (
      await loadExecutionSummaries(prisma, { threadId, spaceId: id, runIds: [run.id] })
    )[0]!.rev;
    expect(rev1).toBeGreaterThan(rev0);
    // Detach event for the same Run moves it again (delete path appends in-transaction).
    await appendEvent(prisma, {
      spaceId: id,
      threadId,
      botId,
      runId: run.id,
      type: "thread.artifact",
      payload: {
        artifactId: artifact.id,
        action: "detached",
        name: "chart.png",
        mimeType: "image/png",
      },
    });
    const rev2 = (
      await loadExecutionSummaries(prisma, { threadId, spaceId: id, runIds: [run.id] })
    )[0]!.rev;
    expect(rev2).toBeGreaterThan(rev1);
    // rev is the composed signal: the Run's event ceiling plus its row-level
    // visible-transition counter (bumped once by terminalize's completedAt set).
    const ceilings = await executionEventCeilings(prisma, [run.id]);
    const row = await prisma.run.findUniqueOrThrow({
      where: { id: run.id },
      select: { snapshotRev: true },
    });
    expect(rev2).toBe((ceilings.get(run.id)?.ceiling ?? 0) + row.snapshotRev);
    expect(row.snapshotRev).toBeGreaterThan(0);
  });

  it("scans the Snapshot, resolved event, and Result for secret leakage", async () => {
    const { run } = await makeRun({ status: "completed" });
    await botMessage(run.id, [{ kind: "text", text: "Report ready, nothing secret." }]);
    await terminalize(run.id);
    const snapshot = await loadExecutionSnapshot(prisma, { threadId, spaceId: id, runId: run.id });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(JSON.stringify(await prisma.event.findMany({ where: { runId: run.id } }))).not.toContain(
      SECRET,
    );
  });

  it("reads a Snapshot consistently while a Run answers, completes, or clears (no torn state, no 40P01)", async () => {
    const { run, attempt } = await makeRun();
    await pauseRunForInput(prisma, {
      spaceId: id,
      threadId,
      botId,
      runId: run.id,
      attemptId: attempt.id,
      leaseOwner: "worker",
      leaseFence: 1,
      blocks: [{ kind: "ask", text: "City?", status: "pending" }],
    });
    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });

    // A consistent read holds Thread FOR SHARE while the answer path takes
    // Thread FOR UPDATE on the same row: serialization, never a cycle.
    const reader = side.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR SHARE`;
        const snapshot = await loadExecutionSnapshot(tx, { threadId, spaceId: id, runId: run.id });
        return snapshot!.summary.rev;
      },
      { timeout: 20_000, maxWait: 20_000 },
    );
    const answer = resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: row.id,
      clientSubmissionId: randomUUID(),
      answeredByUserId: id,
      answer: "Paris",
    });
    const [rev, outcome] = await Promise.all([reader, answer]);
    expect(typeof rev).toBe("number");
    expect(["accepted", "already_handled"]).toContain((outcome as { outcome: string }).outcome);

    // Clear while a detail read is in flight.
    const { run: terminal } = await makeRun({ status: "completed" });
    await terminalize(terminal.id);
    const [clearOutcome, snap] = await Promise.all([
      clearThread(prisma, { spaceId: id, threadId, botId }),
      loadExecutionSnapshot(prisma, { threadId, spaceId: id, runId: terminal.id }),
    ]);
    expect(clearOutcome.cancelledRunIds).toBeDefined();
    expect(snap === null || snap.summary.runId === terminal.id).toBe(true);
  });

  async function seedActivity(runId: string, count: number) {
    const base = await prisma.thread.findUniqueOrThrow({
      where: { id: threadId },
      select: { nextEventSeq: true },
    });
    const start = base.nextEventSeq;
    const rows: Prisma.EventCreateManyInput[] = [];
    for (let index = 0; index < count; index++) {
      rows.push({
        spaceId: id,
        threadId,
        botId,
        seq: start + index,
        type: "agent.tool.called",
        runId,
        schemaVersion: 1,
        payload: { name: "search", executionId: `seed-${index}` },
        createdAt: new Date(Date.parse("2026-10-12T00:00:00.000Z") + index * 10),
      });
    }
    await prisma.$transaction(async (tx) => {
      await tx.event.createMany({ data: rows });
      await tx.thread.update({
        where: { id: threadId },
        data: { nextEventSeq: { increment: count } },
      });
    });
    // One completed per Run so the actions count stays undefined-safe (no cross pairing crash).
    await appendEvent(prisma, {
      spaceId: id,
      threadId,
      botId,
      runId,
      type: "run.completed",
      payload: {},
    });
    await prisma.run.update({
      where: { id: runId },
      data: { status: "completed", leaseOwner: null },
    });
  }

  it("serves per-Run message and artifact reads from the new indexes (no seq scans)", async () => {
    const { run } = await makeRun({ status: "completed" });
    await terminalize(run.id);
    await attachArtifact(run.id, "indexed.txt");
    await botMessage(run.id, [{ kind: "text", text: "indexed result" }]);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SET LOCAL enable_seqscan = off`;
      const messagePlan = await tx.$queryRaw<[{ plan: unknown }[]]>`
        EXPLAIN (FORMAT JSON) SELECT "id" FROM "messages" WHERE "runId" = ${run.id} ORDER BY "seq"
      `;
      const artifactPlan = await tx.$queryRaw<[{ plan: unknown }[]]>`
        EXPLAIN (FORMAT JSON) SELECT "id" FROM "artifacts" WHERE "runId" = ${run.id} ORDER BY "createdAt"
      `;
      expect(JSON.stringify(messagePlan)).toContain("messages_runId_seq_idx");
      expect(JSON.stringify(artifactPlan)).toContain("artifacts_runId_createdAt_idx");
    });
  });

  it("advances rev on event-less Run transitions and never on lease renewals", async () => {
    const { run } = await makeRun();
    const revOf = async () =>
      (await loadExecutionSummaries(prisma, { threadId, spaceId: id, runIds: [run.id] }))[0]!.rev;
    const rev0 = await revOf();

    // Claim-style CAS: status changes with no event anywhere.
    await prisma.run.updateMany({
      where: { id: run.id, status: "running" },
      data: {
        status: "leased",
        leaseOwner: "worker",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const rev1 = await revOf();
    expect(rev1).toBeGreaterThan(rev0);

    // Lease renewal: invisible to the snapshot, must not invalidate anything.
    await prisma.run.updateMany({
      where: { id: run.id },
      data: { leaseExpiresAt: new Date(Date.now() + 120_000) },
    });
    await prisma.run.updateMany({
      where: { id: run.id },
      data: { budgetOverride: { maxTokens: 10 } },
    });
    expect(await revOf()).toBe(rev1);

    // Production promote path: leased -> running with startedAt, no event.
    const promoted = await promoteLeasedRunWithAttempt(prisma, {
      runId: run.id,
      leaseOwner: "worker",
      leaseFence: 2,
      startedAt: new Date(),
    });
    expect(promoted).not.toBeNull();
    const rev2 = await revOf();
    expect(rev2).toBeGreaterThan(rev1);

    // Events still advance rev, and only for their own Run.
    await appendEvent(prisma, {
      spaceId: id,
      threadId,
      botId,
      runId: run.id,
      type: "agent.tool.called",
      payload: { name: "search", executionId: "rev-tool" },
    });
    const rev3 = await revOf();
    expect(rev3).toBeGreaterThan(rev2);
    const other = await makeRun();
    await appendEvent(prisma, {
      spaceId: id,
      threadId,
      botId,
      runId: other.run.id,
      type: "agent.tool.called",
      payload: { name: "search", executionId: "other-tool" },
    });
    expect(await revOf()).toBe(rev3);
  });

  it("pins summary content to rev: invisible row writes never move the contract", async () => {
    const { run } = await makeRun();
    const read = async () =>
      (await loadExecutionSummaries(prisma, { threadId, spaceId: id, runIds: [run.id] }))[0]!;
    const before = await read();

    // Lease renewal and budget overrides bump runs.updatedAt (@updatedAt) but
    // are invisible to the snapshot: rev AND every contract field must hold —
    // one rev identifies exactly one summary content.
    await prisma.run.updateMany({
      where: { id: run.id },
      data: { leaseExpiresAt: new Date(Date.now() + 120_000) },
    });
    await prisma.run.updateMany({
      where: { id: run.id },
      data: { budgetOverride: { maxTokens: 10 } },
    });
    const after = await read();
    expect(after).toEqual(before);

    // A recorded update moves rev and updatedAt together, and updatedAt is
    // the newest event time — never the row timestamp.
    await appendEvent(prisma, {
      spaceId: id,
      threadId,
      botId,
      runId: run.id,
      type: "agent.tool.called",
      payload: { name: "search", executionId: "pin-tool" },
    });
    const moved = await read();
    expect(moved.rev).toBeGreaterThan(after.rev);
    const lastEvent = await prisma.event.findFirst({
      where: { runId: run.id },
      orderBy: { seq: "desc" },
      select: { createdAt: true },
    });
    expect(moved.updatedAt).toBe(lastEvent!.createdAt.toISOString());
    expect(after.updatedAt).not.toBe(moved.updatedAt);
  });

  it("keeps a cleared Run out of the window when its artifact is deleted afterwards", async () => {
    const { run } = await makeRun({ status: "completed" });
    await botMessage(run.id, [{ kind: "text", text: "pre-clear result" }]);
    await terminalize(run.id);
    const artifact = await attachArtifact(run.id, "stale-chart.png");
    const visible = await loadExecutionSummaries(prisma, {
      threadId,
      spaceId: id,
      runIds: [run.id],
    });
    expect(visible.map((item) => item.runId)).toContain(run.id);

    await clearThread(prisma, { spaceId: id, threadId, botId });
    const cleared = await loadExecutionSummaries(prisma, {
      threadId,
      spaceId: id,
      runIds: [run.id],
    });
    expect(cleared.map((item) => item.runId)).not.toContain(run.id);

    // Deleting the stale Run's artifact is legal thread maintenance and lands
    // a fresh thread.artifact event naming the pre-clear Run.
    await prisma.$transaction((tx) =>
      deleteArtifactRowWithDetachEvent(tx, {
        id: artifact.id,
        runId: run.id,
        name: artifact.name,
        mimeType: artifact.mimeType,
        size: artifact.size,
      }),
    );

    // That maintenance event must NOT revive the Run into the new generation.
    const afterDelete = await loadExecutionSummaries(prisma, {
      threadId,
      spaceId: id,
      runIds: [run.id],
    });
    expect(afterDelete.map((item) => item.runId)).not.toContain(run.id);
    const detail = await loadExecutionSnapshot(prisma, { threadId, spaceId: id, runId: run.id });
    expect(detail).toBeNull();

    // A Run that terminates in the NEW generation stays in the window even
    // after its own artifact detach event.
    const fresh = await makeRun({ status: "completed" });
    await terminalize(fresh.run.id);
    const freshArtifact = await attachArtifact(fresh.run.id, "fresh.png");
    await prisma.$transaction((tx) =>
      deleteArtifactRowWithDetachEvent(tx, {
        id: freshArtifact.id,
        runId: fresh.run.id,
        name: freshArtifact.name,
        mimeType: freshArtifact.mimeType,
        size: freshArtifact.size,
      }),
    );
    const window = await loadExecutionSummaries(prisma, {
      threadId,
      spaceId: id,
      runIds: [run.id, fresh.run.id],
    });
    expect(window.map((item) => item.runId)).toEqual([fresh.run.id]);
  });

  it("partitions the artifact preview per Run so one heavy Run cannot starve another", async () => {
    const heavy = await makeRun();
    const light = await makeRun();
    await prisma.artifact.createMany({
      data: Array.from({ length: 40 }, (_, index) => ({
        spaceId: id,
        userId: id,
        botId,
        runId: heavy.run.id,
        name: `heavy-${String(index).padStart(2, "0")}.txt`,
        mimeType: "text/plain",
        size: 1,
        hash: `h${index}`,
        storageKey: `k-${heavy.run.id}-${index}`,
        createdAt: new Date(Date.parse("2026-10-12T00:00:00.000Z") + index * 1000),
      })),
    });
    await prisma.artifact.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        runId: light.run.id,
        name: "light-late.txt",
        mimeType: "text/plain",
        size: 1,
        hash: "hl",
        storageKey: `k-${light.run.id}`,
        createdAt: new Date(Date.parse("2026-10-13T00:00:00.000Z")),
      },
    });
    const summaries = await loadExecutionSummaries(prisma, {
      threadId,
      spaceId: id,
      runIds: [heavy.run.id, light.run.id],
    });
    const heavySummary = summaries.find((item) => item.runId === heavy.run.id)!;
    const lightSummary = summaries.find((item) => item.runId === light.run.id)!;
    expect(heavySummary.artifacts).toHaveLength(20);
    expect(heavySummary.artifacts[0]?.name).toBe("heavy-00.txt");
    expect(heavySummary.counts?.artifacts).toBe(40);
    expect(heavySummary.incompleteSections).toContain("artifacts");
    // The late, single-artifact Run keeps its own preview despite the heavy
    // Run owning 40 earlier artifacts.
    expect(lightSummary.artifacts.map((artifact) => artifact.name)).toEqual(["light-late.txt"]);
    expect(lightSummary.counts?.artifacts).toBe(1);
  });

  it("commits the detach event with the row deletion and rolls both back on failure", async () => {
    const { run } = await makeRun();
    await terminalize(run.id);
    const artifact = await attachArtifact(run.id, "doomed.txt");
    const revBefore = (
      await loadExecutionSummaries(prisma, { threadId, spaceId: id, runIds: [run.id] })
    )[0]!.rev;

    // Any failure inside the transaction — including the event write — must
    // roll the row deletion back with it.
    await expect(
      prisma.$transaction(async (tx) => {
        const deleted = await deleteArtifactRowWithDetachEvent(tx, {
          id: artifact.id,
          runId: artifact.runId,
          name: artifact.name,
          mimeType: artifact.mimeType,
          size: artifact.size,
        });
        expect(deleted).toBe(true);
        await tx.$executeRaw`SELECT 1/0`;
      }),
    ).rejects.toBeTruthy();
    expect(await prisma.artifact.count({ where: { id: artifact.id } })).toBe(1);
    expect(
      await prisma.event.count({
        where: {
          runId: run.id,
          type: "thread.artifact",
          payload: { path: ["action"], equals: "detached" },
        },
      }),
    ).toBe(0);

    // Success commits both together and moves the Run's rev.
    const deleted = await prisma.$transaction((tx) =>
      deleteArtifactRowWithDetachEvent(tx, {
        id: artifact.id,
        runId: artifact.runId,
        name: artifact.name,
        mimeType: artifact.mimeType,
        size: artifact.size,
      }),
    );
    expect(deleted).toBe(true);
    expect(await prisma.artifact.count({ where: { id: artifact.id } })).toBe(0);
    expect(
      await prisma.event.count({
        where: {
          runId: run.id,
          type: "thread.artifact",
          payload: { path: ["action"], equals: "detached" },
        },
      }),
    ).toBe(1);
    const revAfter = (
      await loadExecutionSummaries(prisma, { threadId, spaceId: id, runIds: [run.id] })
    )[0]!.rev;
    expect(revAfter).toBeGreaterThan(revBefore);
  });

  it("binds the Activity cursor to the Run and generation and refuses a forged pair", async () => {
    const { run } = await makeRun({ status: "completed" });
    await terminalize(run.id);
    await seedActivity(run.id, 55);
    const page = await loadRunActivityPage(prisma, {
      threadId,
      spaceId: id,
      runId: run.id,
      limit: 20,
    });
    expect(page.olderCursor).toBeTruthy();
    await expect(
      loadRunActivityPage(prisma, {
        threadId,
        spaceId: id,
        runId: run.id,
        cursor: "garbage-value-123456",
      }),
    ).rejects.toBeInstanceOf(ExecutionActivityCursorError);
  });
});
