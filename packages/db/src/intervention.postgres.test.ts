import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import { createDb, Prisma, type PrismaClient } from "./client.js";
import {
  clearThread,
  commitAnswerRunInput,
  pauseRunForInput,
  resolveIntervention,
} from "./events.js";
import { createThreadMessage } from "./messages.js";
import { loadInterventionViews } from "./interventions.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";
import { expireWaitingRunInTransaction, expireWaitingRuns, WAIT_TIMEOUT_MS } from "./wait-timeouts.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
const TX = { timeout: 20_000, maxWait: 20_000 } as const;
const SECRET = "sk-live-intervention-secret";

describePostgres("intervention contract (PostgreSQL)", () => {
  const id = randomUUID();
  const otherUserId = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let side: PrismaClient;
  let botId: string;
  let threadId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("intervention");
    prisma = isolated.db.prisma;
    const connectionString = isolated.db.pool.options.connectionString;
    if (!connectionString) throw new Error("isolated pool is missing its connection string");
    side = createDb(connectionString, { applicationName: "intervention_side", poolMax: 4 }).prisma;
    await prisma.user.create({
      data: { id, name: "Intervention owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.user.create({
      data: {
        id: otherUserId,
        name: "Intervention other",
        email: `${otherUserId}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id, name: "Intervention test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Intervention test" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: { id, spaceId: id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Intervention bot", color: "test" },
    });
    botId = bot.id;
    threadId = (await prisma.thread.create({ data: { spaceId: id, userId: id, botId } })).id;
  }, 180_000);

  afterAll(async () => {
    await side?.$disconnect().catch(() => undefined);
    await isolated?.drop();
  }, 60_000);

  function openGate() {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release: () => release() };
  }

  async function backendPid(tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
    const pid = Number(rows[0]?.pid);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("missing backend pid");
    return pid;
  }

  async function waitUntilBlockedBy(holderPid: number): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
        SELECT pid::int AS pid
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND ${holderPid}::int = ANY (pg_blocking_pids(pid))
      `;
      if (Number(rows[0]?.pid) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for a lock held by ${holderPid}`);
  }

  async function runningRun(targetThreadId = threadId, targetBotId = botId) {
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId: targetBotId, threadId: targetThreadId, prompt: "Wait", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: targetBotId,
        threadId: targetThreadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
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

  async function pause(
    run: { id: string },
    attempt: { id: string },
    blocks: Parameters<typeof pauseRunForInput>[1]["blocks"],
    targetThreadId = threadId,
    targetBotId = botId,
  ) {
    return pauseRunForInput(prisma, {
      spaceId: id,
      threadId: targetThreadId,
      botId: targetBotId,
      runId: run.id,
      attemptId: attempt.id,
      leaseOwner: "worker",
      leaseFence: 1,
      blocks,
    });
  }

  async function resolvedCount(runId: string, type = "intervention.resolved") {
    return prisma.event.count({ where: { runId, type } });
  }

  it("creates the intervention, ask block, and waiting run atomically", async () => {
    const { run, attempt } = await runningRun();
    expect(await pause(run, attempt, [{ kind: "ask", text: "Which city?", status: "pending" }])).toBe(true);
    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });
    const message = await prisma.message.findFirstOrThrow({ where: { runId: run.id, role: "bot" } });
    const blocks = message.blocks as Array<{ interventionId?: string; status?: string }>;
    expect(blocks[0]?.interventionId).toBe(row.id);
    expect(row).toMatchObject({ status: "pending", kind: "input", messageId: message.id, revision: 1 });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "waiting_input",
      waitKind: "input",
    });
    expect(await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({
      status: "waiting_input",
    });
    expect(await prisma.event.count({ where: { runId: run.id, type: "intervention.created" } })).toBe(1);
  });

  it("rolls back a second pending intervention and a missing approval effect", async () => {
    const first = await runningRun();
    expect(await pause(first.run, first.attempt, [{ kind: "ask", text: "First", status: "pending" }])).toBe(true);
    await prisma.run.update({
      where: { id: first.run.id },
      data: { status: "running", waitKind: null, leaseOwner: "worker", leaseFence: 1 },
    });
    await prisma.attempt.update({ where: { id: first.attempt.id }, data: { status: "running" } });
    await expect(
      pause(first.run, first.attempt, [{ kind: "ask", text: "Second", status: "pending" }]),
    ).rejects.toThrow("Run already has a pending intervention");
    expect(await prisma.run.findUniqueOrThrow({ where: { id: first.run.id } })).toMatchObject({
      status: "running",
    });
    expect(await prisma.intervention.count({ where: { runId: first.run.id } })).toBe(1);

    const missing = await runningRun();
    await expect(
      pause(missing.run, missing.attempt, [
        {
          kind: "ask",
          text: "Approve",
          status: "pending",
          approvalEffectId: "missing-effect",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        },
      ]),
    ).rejects.toThrow("Approval intervention requires its external effect");
    expect(await prisma.run.findUniqueOrThrow({ where: { id: missing.run.id } })).toMatchObject({
      status: "running",
    });
    expect(await prisma.intervention.count({ where: { runId: missing.run.id } })).toBe(0);
  });

  it("answers text and choice without copying the text into the intervention event", async () => {
    const textRun = await runningRun();
    expect(await pause(textRun.run, textRun.attempt, [{ kind: "ask", text: "City?", status: "pending" }])).toBe(true);
    const textRow = await prisma.intervention.findFirstOrThrow({ where: { runId: textRun.run.id } });
    const textResult = await resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: textRow.id,
      clientSubmissionId: randomUUID(),
      answeredByUserId: id,
      answer: "Paris",
    });
    expect(textResult.outcome).toBe("accepted");
    expect(await prisma.run.findUniqueOrThrow({ where: { id: textRun.run.id } })).toMatchObject({
      status: "queued",
    });
    const textEvent = await prisma.event.findFirstOrThrow({
      where: { runId: textRun.run.id, type: "intervention.resolved" },
    });
    expect(JSON.stringify(textEvent.payload)).not.toContain("Paris");

    const choiceRun = await runningRun();
    expect(
      await pause(choiceRun.run, choiceRun.attempt, [
        {
          kind: "ask",
          text: "Pick",
          status: "pending",
          actions: [
            { id: "city-paris", label: "Paris" },
            { id: "city-lyon", label: "Lyon" },
          ],
        },
      ]),
    ).toBe(true);
    const choiceRow = await prisma.intervention.findFirstOrThrow({ where: { runId: choiceRun.run.id } });
    expect(
      await resolveIntervention(prisma, {
        spaceId: id,
        threadId,
        interventionId: choiceRow.id,
        clientSubmissionId: randomUUID(),
        answeredByUserId: id,
        answer: "city-lyon",
      }),
    ).toMatchObject({ outcome: "accepted" });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: choiceRun.task.id } })).toMatchObject({
      prompt: "Selected choice city-lyon: Lyon",
    });
    expect(
      await resolveIntervention(prisma, {
        spaceId: id,
        threadId,
        interventionId: choiceRow.id,
        clientSubmissionId: randomUUID(),
        answeredByUserId: id,
        answer: "0",
      }),
    ).toMatchObject({ outcome: "already_handled" });
  });

  it("keeps approval decisions orthogonal to effect status and allows the owner only", async () => {
    async function approval(decision: "allow" | "always" | "deny") {
      const { run, attempt, task } = await runningRun();
      const effect = await prisma.externalEffect.create({
        data: {
          spaceId: id,
          runId: run.id,
          kind: `tool-${decision}-${run.id}`,
          idempotencyKey: `effect-${run.id}`,
          status: "intended",
          request: { token: SECRET },
        },
      });
      expect(
        await pause(run, attempt, [
          {
            kind: "ask",
            text: "Approve?",
            status: "pending",
            approvalEffectId: effect.id,
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "always", label: "Always allow" },
              { id: "deny", label: "Deny" },
            ],
          },
        ]),
      ).toBe(true);
      const row = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });
      const forbidden = await resolveIntervention(prisma, {
        spaceId: id,
        threadId,
        interventionId: row.id,
        clientSubmissionId: randomUUID(),
        answeredByUserId: otherUserId,
        answer: decision,
      });
      expect(forbidden).toMatchObject({ outcome: "rejected", reason: "forbidden" });
      const accepted = await resolveIntervention(prisma, {
        spaceId: id,
        threadId,
        interventionId: row.id,
        clientSubmissionId: randomUUID(),
        answeredByUserId: id,
        answer: decision,
      });
      expect(accepted.outcome).toBe("accepted");
      if (accepted.outcome === "accepted") {
        expect(accepted.intervention.approval?.decision).toBe(decision === "deny" ? "denied" : "approved");
        expect(accepted.intervention.approval?.effectStatus).toBe(decision === "deny" ? "denied" : "approved");
      }
      expect(JSON.stringify(accepted.outcome === "accepted" ? accepted.intervention : {})).not.toContain(SECRET);
      return { run, task, effect };
    }

    const allowed = await approval("allow");
    expect(await prisma.run.findUniqueOrThrow({ where: { id: allowed.run.id } })).toMatchObject({
      status: "queued",
    });
    const always = await approval("always");
    expect(
      await prisma.actionApprovalRule.count({
        where: { spaceId: id, createdByUserId: id, matchValue: always.effect.kind },
      }),
    ).toBe(1);
    const again = await prisma.intervention.findFirstOrThrow({ where: { runId: always.run.id } });
    await resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: again.id,
      clientSubmissionId: randomUUID(),
      answeredByUserId: id,
      answer: "always",
    });
    expect(
      await prisma.actionApprovalRule.count({
        where: { spaceId: id, createdByUserId: id, matchValue: always.effect.kind },
      }),
    ).toBe(1);
    const denied = await approval("deny");
    expect(await prisma.externalEffect.findUniqueOrThrow({ where: { id: denied.effect.id } })).toMatchObject({
      status: "denied",
    });
    expect(await resolvedCount(denied.run.id, "approval.resolved")).toBe(1);
    expect(await resolvedCount(denied.run.id)).toBe(1);
  });

  it("stores no secret plaintext in the intervention, message, event, or effect", async () => {
    const { run, attempt } = await runningRun();
    const credential = {
      name: "example_api",
      origin: "https://api.example.test",
      auth: { type: "bearer" as const },
    };
    expect(
      await pause(run, attempt, [
        {
          kind: "ask",
          text: "API key",
          status: "pending",
          input: "secret",
          purpose: "api_key",
          credential,
        },
      ]),
    ).toBe(true);
    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });
    let seen = "";
    const result = await resolveIntervention(
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
      { store: async (input) => { seen = input.plaintext; } },
    );
    expect(seen).toBe(SECRET);
    expect(result.outcome).toBe("accepted");
    const stored = JSON.stringify({
      intervention: await prisma.intervention.findMany({ where: { runId: run.id } }),
      messages: await prisma.message.findMany({ where: { runId: run.id } }),
      events: await prisma.event.findMany({ where: { runId: run.id } }),
      effects: await prisma.externalEffect.findMany({ where: { runId: run.id } }),
      submissions: await prisma.interventionSubmission.findMany({ where: { interventionId: row.id } }),
    });
    expect(stored).not.toContain(SECRET);
    const forbidden = await runningRun();
    expect(
      await pause(forbidden.run, forbidden.attempt, [
        { kind: "ask", text: "API key", status: "pending", input: "secret", purpose: "api_key", credential },
      ]),
    ).toBe(true);
    const secretRow = await prisma.intervention.findFirstOrThrow({ where: { runId: forbidden.run.id } });
    expect(
      await resolveIntervention(prisma, {
        spaceId: id,
        threadId,
        interventionId: secretRow.id,
        clientSubmissionId: randomUUID(),
        answeredByUserId: otherUserId,
        answer: SECRET,
      }, undefined, { store: async () => undefined }),
    ).toMatchObject({ outcome: "rejected", reason: "forbidden" });
  });

  it("returns the first result for the same submission id and already_handled for another client", async () => {
    const { run, attempt } = await runningRun();
    expect(await pause(run, attempt, [{ kind: "ask", text: "City?", status: "pending" }])).toBe(true);
    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });
    const submissionId = randomUUID();
    const first = await resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: row.id,
      clientSubmissionId: submissionId,
      answeredByUserId: id,
      answer: "Paris",
    });
    const retry = await resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: row.id,
      clientSubmissionId: submissionId,
      answeredByUserId: id,
      answer: "Paris",
    });
    const other = await resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: row.id,
      clientSubmissionId: randomUUID(),
      answeredByUserId: otherUserId,
      answer: "Lyon",
    });
    expect(first).toMatchObject({ outcome: "accepted", applied: true });
    expect(retry).toMatchObject({ outcome: "accepted", applied: false });
    expect(other).toMatchObject({ outcome: "already_handled", applied: false });
    expect(await resolvedCount(run.id)).toBe(1);
  });

  it("lets one blocked answer win and reports already_handled to the waiter", async () => {
    const { run, attempt } = await runningRun();
    expect(await pause(run, attempt, [{ kind: "ask", text: "City?", status: "pending" }])).toBe(true);
    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });
    const started = openGate();
    const release = openGate();
    let holderPid = 0;
    const holder = side.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      holderPid = await backendPid(tx);
      started.release();
      await release.promise;
      return commitAnswerRunInput(tx, {
        spaceId: id,
        threadId,
        runId: run.id,
        messageId: row.messageId,
        answeredByUserId: id,
        answer: "Paris",
        clientSubmissionId: randomUUID(),
      });
    }, TX);
    await started.promise;
    const waiter = resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: row.id,
      clientSubmissionId: randomUUID(),
      answeredByUserId: otherUserId,
      answer: "Lyon",
    });
    try {
      await waitUntilBlockedBy(holderPid);
    } finally {
      release.release();
    }
    await holder;
    expect(await waiter).toMatchObject({ outcome: "already_handled" });
    expect(await resolvedCount(run.id)).toBe(1);
    expect(await prisma.intervention.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "answered",
    });
  });

  it("answers while timeout is blocked, and expires while answer is blocked", async () => {
    const winner = await runningRun();
    expect(await pause(winner.run, winner.attempt, [{ kind: "ask", text: "City?", status: "pending" }])).toBe(true);
    const winnerRow = await prisma.intervention.findFirstOrThrow({ where: { runId: winner.run.id } });
    const old = new Date(Date.now() - WAIT_TIMEOUT_MS.input - 60_000);
    await prisma.run.update({ where: { id: winner.run.id }, data: { waitStartedAt: old } });
    const started = openGate();
    const release = openGate();
    let holderPid = 0;
    const holder = side.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      holderPid = await backendPid(tx);
      started.release();
      await release.promise;
      return commitAnswerRunInput(tx, {
        spaceId: id,
        threadId,
        runId: winner.run.id,
        messageId: winnerRow.messageId,
        answeredByUserId: id,
        answer: "Paris",
      });
    }, TX);
    await started.promise;
    const expiring = expireWaitingRuns(prisma);
    try {
      await waitUntilBlockedBy(holderPid);
    } finally {
      release.release();
    }
    await holder;
    await expiring;
    expect(await resolvedCount(winner.run.id)).toBe(1);
    expect(await prisma.intervention.findUniqueOrThrow({ where: { id: winnerRow.id } })).toMatchObject({
      status: "answered",
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: winner.run.id } })).toMatchObject({
      status: "queued",
    });

    const loser = await runningRun();
    expect(await pause(loser.run, loser.attempt, [{ kind: "ask", text: "City?", status: "pending" }])).toBe(true);
    const loserRow = await prisma.intervention.findFirstOrThrow({ where: { runId: loser.run.id } });
    await prisma.run.update({ where: { id: loser.run.id }, data: { waitStartedAt: old } });
    const expireStarted = openGate();
    const expireRelease = openGate();
    let expirePid = 0;
    const expirer = side.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      expirePid = await backendPid(tx);
      expireStarted.release();
      await expireRelease.promise;
      return expireWaitingRunInTransaction(tx, loser.run.id, new Date());
    }, TX);
    await expireStarted.promise;
    const answering = resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: loserRow.id,
      clientSubmissionId: randomUUID(),
      answeredByUserId: id,
      answer: "Paris",
    });
    try {
      await waitUntilBlockedBy(expirePid);
    } finally {
      expireRelease.release();
    }
    await expirer;
    expect(await answering).toMatchObject({ outcome: "already_handled" });
    expect(await prisma.intervention.findUniqueOrThrow({ where: { id: loserRow.id } })).toMatchObject({
      status: "expired",
    });
    expect(await resolvedCount(loser.run.id)).toBe(1);
    await expireWaitingRuns(prisma);
    expect(await resolvedCount(loser.run.id)).toBe(1);
  });

  it("answers while clear is blocked, and cancels while answer is blocked", async () => {
    const { run, attempt } = await runningRun();
    expect(await pause(run, attempt, [{ kind: "ask", text: "City?", status: "pending" }])).toBe(true);
    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });
    const started = openGate();
    const release = openGate();
    let holderPid = 0;
    const holder = side.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      holderPid = await backendPid(tx);
      started.release();
      await release.promise;
      return commitAnswerRunInput(tx, {
        spaceId: id,
        threadId,
        runId: run.id,
        messageId: row.messageId,
        answeredByUserId: id,
        answer: "Paris",
      });
    }, TX);
    await started.promise;
    const clearing = clearThread(prisma, { spaceId: id, threadId, botId });
    try {
      await waitUntilBlockedBy(holderPid);
    } finally {
      release.release();
    }
    await holder;
    await clearing;
    expect(await prisma.intervention.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "answered",
    });

    const { run: cancelRun, attempt: cancelAttempt } = await runningRun();
    expect(await pause(cancelRun, cancelAttempt, [{ kind: "ask", text: "City?", status: "pending" }])).toBe(true);
    const cancelRow = await prisma.intervention.findFirstOrThrow({ where: { runId: cancelRun.id } });
    const cancelStarted = openGate();
    const cancelRelease = openGate();
    let cancelPid = 0;
    const canceller = side.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      cancelPid = await backendPid(tx);
      cancelStarted.release();
      await cancelRelease.promise;
      await cancelRunsInTransaction(tx, [{ id: cancelRun.id, taskId: cancelRun.taskId }], new Date());
    }, TX);
    await cancelStarted.promise;
    const answering = resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: cancelRow.id,
      clientSubmissionId: randomUUID(),
      answeredByUserId: id,
      answer: "Paris",
    });
    try {
      await waitUntilBlockedBy(cancelPid);
    } finally {
      cancelRelease.release();
    }
    await canceller;
    expect(await answering).toMatchObject({ outcome: "already_handled" });
    expect(await prisma.intervention.findUniqueOrThrow({ where: { id: cancelRow.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await resolvedCount(cancelRun.id)).toBe(1);
    await prisma.$transaction((tx) =>
      cancelRunsInTransaction(tx, [{ id: cancelRun.id, taskId: cancelRun.taskId }], new Date()),
    );
    expect(await resolvedCount(cancelRun.id)).toBe(1);
  });

  it("does not approve an effect that was already claimed", async () => {
    const { run, attempt } = await runningRun();
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId: id,
        runId: run.id,
        kind: "send_email",
        idempotencyKey: `claim-${run.id}`,
        status: "intended",
        request: {},
      },
    });
    expect(
      await pause(run, attempt, [
        {
          kind: "ask",
          text: "Approve?",
          status: "pending",
          approvalEffectId: effect.id,
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        },
      ]),
    ).toBe(true);
    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });
    const started = openGate();
    const release = openGate();
    let holderPid = 0;
    const holder = side.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM external_effects WHERE id = ${effect.id} FOR UPDATE`;
      holderPid = await backendPid(tx);
      started.release();
      await release.promise;
      await tx.externalEffect.update({ where: { id: effect.id }, data: { status: "executing" } });
    }, TX);
    await started.promise;
    const answering = resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: row.id,
      clientSubmissionId: randomUUID(),
      answeredByUserId: id,
      answer: "allow",
    });
    try {
      await waitUntilBlockedBy(holderPid);
    } finally {
      release.release();
    }
    await holder;
    expect(await answering).toMatchObject({ outcome: "rejected", reason: "conflict" });
    expect(await prisma.intervention.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "pending",
    });
    expect(await prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).toMatchObject({
      status: "executing",
    });
    expect(await resolvedCount(run.id)).toBe(0);
    expect(await resolvedCount(run.id, "approval.resolved")).toBe(0);
  });

  it("does not create an intervention when the run is cancelled first", async () => {
    const { run, attempt } = await runningRun();
    const started = openGate();
    const release = openGate();
    let holderPid = 0;
    const holder = side.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      holderPid = await backendPid(tx);
      started.release();
      await release.promise;
      await tx.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
    }, TX);
    await started.promise;
    const pausing = pause(run, attempt, [{ kind: "ask", text: "City?", status: "pending" }]);
    try {
      await waitUntilBlockedBy(holderPid);
    } finally {
      release.release();
    }
    await holder;
    expect(await pausing).toBe(false);
    expect(await prisma.intervention.count({ where: { runId: run.id } })).toBe(0);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
    });
  });

  it("materializes a legacy pending ask on answer and keeps two runs independent", async () => {
    const { run } = await runningRun();
    await prisma.run.update({
      where: { id: run.id },
      data: { status: "waiting_input", waitKind: "input", waitStartedAt: new Date(), leaseOwner: null },
    });
    const message = await createThreadMessage(prisma, {
      threadId,
      role: "bot",
      botId,
      runId: run.id,
      blocks: [{ kind: "ask", text: "Legacy?", status: "pending" }],
    });
    const legacyId = `legacy_${message.id}`;
    const answered = await resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: legacyId,
      clientSubmissionId: randomUUID(),
      answeredByUserId: id,
      answer: "Yes",
    });
    expect(answered.outcome).toBe("accepted");
    expect(await prisma.intervention.findUniqueOrThrow({ where: { id: legacyId } })).toMatchObject({
      status: "answered",
      revision: 1,
    });
    expect(await prisma.event.count({ where: { runId: run.id, type: "intervention.created" } })).toBe(0);
    expect(await resolvedCount(run.id)).toBe(1);

    const left = await runningRun();
    const right = await runningRun();
    expect(await pause(left.run, left.attempt, [{ kind: "ask", text: "Left", status: "pending" }])).toBe(true);
    expect(await pause(right.run, right.attempt, [{ kind: "ask", text: "Right", status: "pending" }])).toBe(true);
    const leftRow = await prisma.intervention.findFirstOrThrow({ where: { runId: left.run.id } });
    await resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId: leftRow.id,
      clientSubmissionId: randomUUID(),
      answeredByUserId: id,
      answer: "Left answer",
    });
    expect(await prisma.intervention.findFirstOrThrow({ where: { runId: right.run.id } })).toMatchObject({
      status: "pending",
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: right.run.id } })).toMatchObject({
      status: "waiting_input",
    });
  });

  it("persists the sanitized presentation snapshot at creation and never carries the answer", async () => {
    const credential = {
      name: "example_login",
      origin: "https://login.example.test",
      auth: { type: "login" as const },
    };
    const { run, attempt } = await runningRun();
    expect(
      await pause(run, attempt, [
        {
          kind: "ask",
          text: "Sign in to continue.",
          detail: "We need the account password.",
          status: "pending",
          input: "secret",
          purpose: "password",
          credential,
        },
      ]),
    ).toBe(true);
    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });
    expect(row.presentation).toMatchObject({
      text: "Sign in to continue.",
      detail: "We need the account password.",
      credential: { name: "example_login", origin: "https://login.example.test", authType: "login" },
    });
    const createdEvent = await prisma.event.findFirstOrThrow({
      where: { runId: run.id, type: "intervention.created" },
    });
    expect(createdEvent.payload).toMatchObject({
      presentation: { text: "Sign in to continue." },
    });

    const answer = `sk-present-${randomUUID()}`;
    expect(
      await resolveIntervention(
        prisma,
        {
          spaceId: id,
          threadId,
          interventionId: row.id,
          clientSubmissionId: randomUUID(),
          answeredByUserId: id,
          answer,
          username: "someone",
        },
        undefined,
        { store: async () => undefined },
      ),
    ).toMatchObject({ outcome: "accepted" });
    const settled = await prisma.intervention.findFirstOrThrow({ where: { id: row.id } });
    expect(JSON.stringify(settled)).not.toContain(answer);
    expect(JSON.stringify(settled)).not.toContain("someone");
    const resolvedEvent = await prisma.event.findFirstOrThrow({
      where: { runId: run.id, type: "intervention.resolved" },
    });
    expect(JSON.stringify(resolvedEvent.payload)).not.toContain(answer);

    const approvalRun = await runningRun();
    const approvalEffect = await prisma.externalEffect.create({
      data: {
        spaceId: id,
        runId: approvalRun.run.id,
        kind: "present-approval",
        idempotencyKey: `present-${approvalRun.run.id}`,
        status: "intended",
        request: { token: answer },
      },
    });
    expect(
      await pause(approvalRun.run, approvalRun.attempt, [
        {
          kind: "ask",
          text: "Send the weekly report?",
          detail: "Recipient: team@example.test",
          status: "pending",
          approvalEffectId: approvalEffect.id,
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        },
      ]),
    ).toBe(true);
    const approvalRow = await prisma.intervention.findFirstOrThrow({ where: { runId: approvalRun.run.id } });
    expect(approvalRow.presentation).toMatchObject({
      text: "Send the weekly report?",
      detail: "Recipient: team@example.test",
    });
    expect(JSON.stringify(approvalRow)).not.toContain(answer);
  });

  it("projects pending rows and windowed terminal rows without their messages", async () => {
    const pendingRun = await runningRun();
    expect(await pause(pendingRun.run, pendingRun.attempt, [{ kind: "ask", text: "Hold?", status: "pending" }])).toBe(true);
    const settledRun = await runningRun();
    expect(await pause(settledRun.run, settledRun.attempt, [{ kind: "ask", text: "City?", status: "pending" }])).toBe(true);
    const settledRow = await prisma.intervention.findFirstOrThrow({ where: { runId: settledRun.run.id } });
    expect(
      await resolveIntervention(prisma, {
        spaceId: id,
        threadId,
        interventionId: settledRow.id,
        clientSubmissionId: randomUUID(),
        answeredByUserId: id,
        answer: "Paris",
      }),
    ).toMatchObject({ outcome: "accepted" });

    const pendingRow = await prisma.intervention.findFirstOrThrow({ where: { runId: pendingRun.run.id } });
    const noWindow = await prisma.$transaction((tx) => loadInterventionViews(tx, threadId, []));
    const noWindowIds = new Set(noWindow.map((view) => view.id));
    expect(noWindowIds.has(pendingRow.id)).toBe(true);
    expect(noWindowIds.has(settledRow.id)).toBe(false);
    expect(noWindow.every((view) => view.status === "pending")).toBe(true);
    const pendingView = noWindow.find((view) => view.id === pendingRow.id);
    expect(pendingView?.presentation?.text).toBe("Hold?");

    const inRunWindow = await prisma.$transaction((tx) =>
      loadInterventionViews(tx, threadId, [], [settledRun.run.id]),
    );
    const terminalView = inRunWindow.find((view) => view.id === settledRow.id);
    expect(terminalView).toMatchObject({ status: "answered", kind: "input" });
    expect(terminalView?.presentation?.text).toBe("City?");

    const inPageWindow = await prisma.$transaction((tx) =>
      loadInterventionViews(tx, threadId, [{ id: settledRow.messageId, blocks: [] }]),
    );
    expect(inPageWindow.map((view) => view.id)).toContain(settledRow.id);

    const unrelated = await runningRun();
    const missedWindow = await prisma.$transaction((tx) =>
      loadInterventionViews(tx, threadId, [], [unrelated.run.id]),
    );
    expect(missedWindow.map((view) => view.id)).not.toContain(settledRow.id);
  });

  it("backfills the presentation snapshot on the first terminalization of a row without one", async () => {
    const { run, attempt } = await runningRun();
    expect(await pause(run, attempt, [{ kind: "ask", text: "Legacy row?", status: "pending" }])).toBe(true);
    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });
    await prisma.intervention.update({
      where: { id: row.id },
      data: { presentation: Prisma.DbNull },
    });
    await prisma.$transaction((tx) =>
      cancelRunsInTransaction(tx, [{ id: run.id, taskId: run.taskId }], new Date()),
    );
    const settled = await prisma.intervention.findFirstOrThrow({ where: { id: row.id } });
    expect(settled.presentation).toMatchObject({ text: "Legacy row?" });
    const resolvedEvent = await prisma.event.findFirstOrThrow({
      where: { runId: run.id, type: "intervention.resolved" },
    });
    expect(resolvedEvent.payload).toMatchObject({ presentation: { text: "Legacy row?" } });
  });

  async function raceOutcome<T>(work: Promise<T>): Promise<{ value: T } | { error: string }> {
    try {
      return { value: await work };
    } catch (error) {
      return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  }

  function expectNoDeadlock(results: Array<{ value?: unknown; error?: string }>, round: number): void {
    for (const result of results) {
      if (result.error) {
        throw new Error(`round ${round}: ${result.error}`);
      }
    }
  }

  it("deadlock-free: resolveIntervention vs teaching-style cancel (no manual Thread lock)", async () => {
    // The holder is the production entry exactly as skills.start calls it:
    // cancelRunsInTransaction inside a bare transaction with no prior Thread lock.
    for (let round = 0; round < 8; round++) {
      const { run, attempt } = await runningRun();
      expect(await pause(run, attempt, [{ kind: "ask", text: "City?", status: "pending" }])).toBe(true);
      const row = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });
      const results = await Promise.all([
        raceOutcome(
          side.$transaction(
            (tx) => cancelRunsInTransaction(tx, [{ id: run.id, taskId: run.taskId }], new Date()),
            TX,
          ),
        ),
        raceOutcome(
          resolveIntervention(prisma, {
            spaceId: id,
            threadId,
            interventionId: row.id,
            clientSubmissionId: randomUUID(),
            answeredByUserId: id,
            answer: "Paris",
          }),
        ),
      ]);
      expectNoDeadlock(results, round);
      expect(await resolvedCount(run.id)).toBe(1);
      const settled = await prisma.intervention.findFirstOrThrow({ where: { id: row.id } });
      const settledRun = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
      expect(["answered", "cancelled"]).toContain(settled.status);
      // A resumed answer can still be cancelled by the same teaching sweep afterwards.
      if (settled.status === "cancelled") expect(settledRun.status).toBe("cancelled");
      else expect(["queued", "running", "completed", "cancelled"]).toContain(settledRun.status);
    }
  });

  it("deadlock-free: resolveIntervention vs cross-thread bot-delete-style cancel", async () => {
    // A Thread holds exactly one bot; a cross-thread bot sweep needs a second
    // bot, mirroring the shape of destroyBot's active-run query.
    const otherBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Intervention bot 2", color: "test" },
    });
    const secondThread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: otherBot.id } });
    for (let round = 0; round < 8; round++) {
      const first = await runningRun(threadId);
      const second = await runningRun(secondThread.id, otherBot.id);
      expect(await pause(first.run, first.attempt, [{ kind: "ask", text: "First?", status: "pending" }])).toBe(true);
      expect(
        await pause(
          second.run,
          second.attempt,
          [{ kind: "ask", text: "Second?", status: "pending" }],
          secondThread.id,
          otherBot.id,
        ),
      ).toBe(true);
      const secondRow = await prisma.intervention.findFirstOrThrow({ where: { runId: second.run.id } });
      // The entry shape of destroyBot's first transaction: cancel runs across
      // several Threads in one transaction, in either input order, while an
      // answer races one of the rows. Sorted Thread locks must serialize, not deadlock.
      const cancelFirst = [
        { id: first.run.id, taskId: first.task.id },
        { id: second.run.id, taskId: second.task.id },
      ];
      const cancelSecond = [...cancelFirst].reverse();
      const results = await Promise.all([
        raceOutcome(
          side.$transaction(
            (tx) => cancelRunsInTransaction(tx, round % 2 === 0 ? cancelFirst : cancelSecond, new Date()),
            TX,
          ),
        ),
        raceOutcome(
          prisma.$transaction(
            (tx) => cancelRunsInTransaction(tx, round % 2 === 0 ? cancelSecond : cancelFirst, new Date()),
            TX,
          ),
        ),
        raceOutcome(
          resolveIntervention(prisma, {
            spaceId: id,
            threadId: secondThread.id,
            interventionId: secondRow.id,
            clientSubmissionId: randomUUID(),
            answeredByUserId: id,
            answer: "Both",
          }),
        ),
      ]);
      expectNoDeadlock(results, round);
      expect(await resolvedCount(first.run.id)).toBe(1);
      expect(await resolvedCount(second.run.id)).toBe(1);
      for (const rowId of [secondRow.id]) {
        const settled = await prisma.intervention.findUniqueOrThrow({ where: { id: rowId } });
        expect(["answered", "cancelled"]).toContain(settled.status);
      }
    }
  });

  it("deadlock-free: wait timeout vs approval answer, intervention settles before the effect", async () => {
    for (let round = 0; round < 8; round++) {
      const { run, attempt } = await runningRun();
      const effect = await prisma.externalEffect.create({
        data: {
          spaceId: id,
          runId: run.id,
          kind: "timeout-race",
          idempotencyKey: `timeout-race-${run.id}`,
          status: "intended",
          request: {},
        },
      });
      expect(
        await pause(run, attempt, [
          {
            kind: "ask",
            text: "Approve send?",
            status: "pending",
            approvalEffectId: effect.id,
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          },
        ]),
      ).toBe(true);
      const row = await prisma.intervention.findFirstOrThrow({ where: { runId: run.id } });
      const old = new Date(Date.now() - WAIT_TIMEOUT_MS.input - 60_000);
      await prisma.run.update({ where: { id: run.id }, data: { waitStartedAt: old } });
      const results = await Promise.all([
        raceOutcome(expireWaitingRuns(prisma)),
        raceOutcome(
          resolveIntervention(prisma, {
            spaceId: id,
            threadId,
            interventionId: row.id,
            clientSubmissionId: randomUUID(),
            answeredByUserId: id,
            answer: "allow",
          }),
        ),
      ]);
      expectNoDeadlock(results, round);
      expect(await resolvedCount(run.id)).toBe(1);
      const settled = await prisma.intervention.findFirstOrThrow({ where: { id: row.id } });
      const settledEffect = await prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } });
      if (settled.status === "expired") {
        // Document order: the Intervention terminal event is appended before the
        // effect expiry's approval.resolved event.
        expect(["expired", "intended", "approved", "executing", "completed", "uncertain"]).toContain(
          settledEffect.status,
        );
        const resolved = await prisma.event.findFirstOrThrow({
          where: { runId: run.id, type: "intervention.resolved" },
        });
        const approvalResolved = await prisma.event.findFirst({
          where: { runId: run.id, type: "approval.resolved" },
        });
        if (approvalResolved) expect(resolved.seq).toBeLessThan(approvalResolved.seq);
      } else {
        expect(settled.status).toBe("answered");
        expect(["approved", "executing", "completed", "uncertain"]).toContain(settledEffect.status);
      }
    }
  });
});
