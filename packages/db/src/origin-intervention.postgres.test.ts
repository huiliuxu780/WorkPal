import { randomUUID } from "node:crypto";
import {
  RoundtableContractError,
  RoundtableFeatureDisabledError,
  resolveRoundtableFeatureGates,
} from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import { createDb, type PrismaClient } from "./client.js";
import {
  clearThread,
  pauseRunForInput,
  type ResolveInterventionInput,
  resolveIntervention,
} from "./events.js";
import { loadInterventionViews } from "./interventions.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";
import { expireWaitingRunInTransaction, WAIT_TIMEOUT_MS } from "./wait-timeouts.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
const TX = { timeout: 20_000, maxWait: 20_000 } as const;
const SECRET = "sk-live-pair-intervention-secret";

/**
 * RT-04 / AC20: a Run that executes where the user must not write — a fixed
 * Agent pair — still has to be answerable from the visible Thread that started
 * the work. At this layer a "pair" Thread is simply a second Thread holding the
 * executing Run; RT-02/RT-03 own its identity and its human-write ban, and RT-05
 * owns creating it. What is under test here is the split itself: which Thread
 * projects the card, which Thread a submission is accepted on, and which Run a
 * decision is allowed to resume.
 */
describePostgres("origin-aware intervention (PostgreSQL)", () => {
  const id = randomUUID();
  const otherUserId = randomUUID();
  const PAIR_ON = resolveRoundtableFeatureGates({ ROUNDTABLE_PRIVATE_PAIR_ENABLED: "true" });
  const PAIR_OFF = resolveRoundtableFeatureGates({});
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let side: PrismaClient;
  let hostBotId: string;
  let peerBotId: string;
  let originThreadId: string;
  let pairThreadId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("origin_intervention");
    prisma = isolated.db.prisma;
    const connectionString = isolated.db.pool.options.connectionString;
    if (!connectionString) throw new Error("isolated pool is missing its connection string");
    side = createDb(connectionString, { applicationName: "origin_side", poolMax: 4 }).prisma;
    await prisma.user.create({
      data: { id, name: "Origin owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.user.create({
      data: {
        id: otherUserId,
        name: "Origin other",
        email: `${otherUserId}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id, name: "Origin test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Origin test" } });
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
    const hostBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Joy", color: "test" },
    });
    const peerBot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Blue", color: "test" },
    });
    hostBotId = hostBot.id;
    peerBotId = peerBot.id;
    originThreadId = (
      await prisma.thread.create({ data: { spaceId: id, userId: id, botId: hostBotId } })
    ).id;
    pairThreadId = (
      await prisma.thread.create({ data: { spaceId: id, userId: id, botId: peerBotId } })
    ).id;
  }, 180_000);

  afterAll(async () => {
    await side?.$disconnect().catch(() => undefined);
    await isolated?.drop();
  }, 60_000);

  type Started = {
    task: { id: string };
    run: { id: string; threadId: string; botId: string; taskId: string };
    attempt: { id: string };
  };

  async function startRun(threadId: string, botId: string, trigger = "user"): Promise<Started> {
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        prompt: "Wait",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "running",
        trigger,
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

  /** The Run in the visible Thread that issued the collaboration. */
  async function startSourceRun(): Promise<Started> {
    return startRun(originThreadId, hostBotId);
  }

  /** A support Run executing in the pair Thread. */
  async function startPairRun(): Promise<Started> {
    return startRun(pairThreadId, peerBotId, "bot_message");
  }

  async function approvalEffect(runId: string) {
    return prisma.externalEffect.create({
      data: {
        spaceId: id,
        runId,
        kind: `tool-pair-${runId}`,
        idempotencyKey: `effect-${runId}`,
        status: "intended",
        request: { token: SECRET },
      },
    });
  }

  function approvalAsk(effectId: string) {
    return [
      {
        kind: "ask" as const,
        text: "Send the summary from the pair?",
        status: "pending" as const,
        approvalEffectId: effectId,
        actions: [
          { id: "allow", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      },
    ];
  }

  function textAsk(text = "Which release?") {
    return [{ kind: "ask" as const, text, status: "pending" as const }];
  }

  /** Pause a pair Run with its card projected into the originating Thread. */
  async function pausePairRun(
    source: Started,
    target: Started,
    blocks: Parameters<typeof pauseRunForInput>[1]["blocks"],
    overrides: Partial<Parameters<typeof pauseRunForInput>[1]> = {},
  ) {
    return pauseRunForInput(prisma, {
      spaceId: id,
      threadId: target.run.threadId,
      botId: target.run.botId,
      runId: target.run.id,
      attemptId: target.attempt.id,
      leaseOwner: "worker",
      leaseFence: 1,
      blocks,
      presentationThreadId: originThreadId,
      origin: { sourceThreadId: originThreadId, sourceRunId: source.run.id },
      gates: PAIR_ON,
      ...overrides,
    });
  }

  /** One source Run plus one paused pair Run awaiting an approval. */
  async function waitingPairApproval() {
    const source = await startSourceRun();
    const target = await startPairRun();
    const effect = await approvalEffect(target.run.id);
    expect(await pausePairRun(source, target, approvalAsk(effect.id))).toBe(true);
    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: target.run.id } });
    return { source, target, effect, row };
  }

  function resolveFrom(
    threadId: string,
    interventionId: string,
    overrides: Partial<ResolveInterventionInput> = {},
  ) {
    return resolveIntervention(prisma, {
      spaceId: id,
      threadId,
      interventionId,
      clientSubmissionId: randomUUID(),
      answeredByUserId: id,
      answer: "allow",
      gates: PAIR_ON,
      ...overrides,
    });
  }

  async function eventTypes(threadId: string, runId: string) {
    const events = await prisma.event.findMany({
      where: { threadId, runId },
      orderBy: { seq: "asc" },
    });
    return events.map((event) => event.type);
  }

  it("projects the wait into the originating Thread and keeps the ask in the executing one", async () => {
    const source = await startSourceRun();
    const target = await startPairRun();
    expect(await pausePairRun(source, target, textAsk())).toBe(true);

    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: target.run.id } });
    expect(row.threadId).toBe(originThreadId);

    // The ask Message belongs to the executing Thread: the pair keeps the full
    // record, and the origin Thread only ever gets the projection.
    const ask = await prisma.message.findUniqueOrThrow({ where: { id: row.messageId } });
    expect(ask.threadId).toBe(pairThreadId);
    expect(
      await prisma.message.count({ where: { threadId: originThreadId, runId: target.run.id } }),
    ).toBe(0);

    expect(await eventTypes(originThreadId, target.run.id)).toEqual(["intervention.created"]);
    expect(await eventTypes(pairThreadId, target.run.id)).toEqual([
      "thread.message.created",
      "run.waiting_input",
    ]);

    // The snapshot projection is what the answering Thread's card renders from.
    const inOrigin = await prisma.$transaction((tx) =>
      loadInterventionViews(tx, originThreadId, []),
    );
    expect(inOrigin.map((view) => view.id)).toEqual([row.id]);
    expect(inOrigin[0]).toMatchObject({
      threadId: originThreadId,
      runId: target.run.id,
      status: "pending",
      presentation: { text: "Which release?" },
    });
    const inPair = await prisma.$transaction((tx) => loadInterventionViews(tx, pairThreadId, []));
    expect(inPair.map((view) => view.id)).not.toContain(row.id);
  });

  it("refuses to publish a wait outside the executing Thread while the capability is off", async () => {
    const source = await startSourceRun();
    const target = await startPairRun();
    await expect(
      pausePairRun(source, target, textAsk(), { gates: PAIR_OFF }),
    ).rejects.toMatchObject({
      name: "RoundtableFeatureDisabledError",
      code: "ROUNDTABLE_FEATURE_DISABLED",
      feature: "private_pair",
      retryable: false,
    });
    // Nothing leaked out of the rolled-back transaction.
    expect(await prisma.intervention.count({ where: { runId: target.run.id } })).toBe(0);
    expect(await prisma.message.count({ where: { runId: target.run.id } })).toBe(0);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: target.run.id } })).toMatchObject({
      status: "running",
    });
  });

  it("rejects an origin whose source Run is not anchored in the presentation Thread", async () => {
    const source = await startSourceRun();
    const target = await startPairRun();
    const foreign = await startPairRun();
    await expect(
      pausePairRun(source, target, textAsk(), {
        origin: { sourceThreadId: originThreadId, sourceRunId: foreign.run.id },
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof RoundtableContractError && error.path === "sourceRunId",
    );
    expect(await prisma.intervention.count({ where: { runId: target.run.id } })).toBe(0);
  });

  it("answers a pair Run's approval from the originating Thread and resumes only that Run", async () => {
    const { target, effect, row } = await waitingPairApproval();

    const result = await resolveFrom(originThreadId, row.id);
    expect(result).toMatchObject({ outcome: "accepted", applied: true, resume: true });
    if (result.outcome !== "accepted") throw new Error("expected an accepted decision");
    expect(result.presentationThreadId).toBe(originThreadId);
    expect(result.presentationSeq).toBeGreaterThan(0);
    expect(result.intervention.approval?.decision).toBe("approved");
    expect(JSON.stringify(result.intervention)).not.toContain(SECRET);

    expect(await prisma.run.findUniqueOrThrow({ where: { id: target.run.id } })).toMatchObject({
      status: "queued",
      waitKind: null,
    });
    expect(
      await prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
    ).toMatchObject({
      status: "approved",
    });

    // The decision is recorded where the user made it; the execution detail stays
    // in the Thread that actually ran the tool.
    expect(await eventTypes(originThreadId, target.run.id)).toEqual([
      "intervention.created",
      "intervention.resolved",
    ]);
    expect(await eventTypes(pairThreadId, target.run.id)).toEqual([
      "thread.message.created",
      "run.waiting_input",
      "approval.requested",
      "thread.message.updated",
      "approval.resolved",
    ]);
  });

  it("answers a pair Run's input request from the originating Thread", async () => {
    // The "补充" half of AC20: an information gap, not only a tool approval.
    const source = await startSourceRun();
    const target = await startPairRun();
    expect(await pausePairRun(source, target, textAsk("Which release?"))).toBe(true);
    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: target.run.id } });

    const result = await resolveFrom(originThreadId, row.id, { answer: "v2.1" });

    expect(result).toMatchObject({ outcome: "accepted", applied: true, resume: true });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: target.run.id } })).toMatchObject({
      status: "queued",
    });
    // The supplement reaches the bound Task of the executing Run.
    expect(await prisma.task.findUniqueOrThrow({ where: { id: target.task.id } })).toMatchObject({
      prompt: "v2.1",
    });
    const ask = await prisma.message.findUniqueOrThrow({ where: { id: row.messageId } });
    expect(ask.threadId).toBe(pairThreadId);
    expect(JSON.stringify(ask.blocks)).toContain('"status":"answered"');
    expect(await eventTypes(originThreadId, target.run.id)).toEqual([
      "intervention.created",
      "intervention.resolved",
    ]);
  });

  it("rejects the same decision addressed at the executing Thread", async () => {
    const { target, row } = await waitingPairApproval();
    // The pair Thread is where the Run lives, and it is exactly where a human
    // submission must not be accepted.
    expect(await resolveFrom(pairThreadId, row.id)).toMatchObject({
      outcome: "rejected",
      reason: "not_found",
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: target.run.id } })).toMatchObject({
      status: "waiting_input",
    });
    expect(await prisma.intervention.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "pending",
    });
    expect(await prisma.interventionSubmission.count({ where: { interventionId: row.id } })).toBe(
      0,
    );
  });

  it("keeps a non-owner from deciding a pair Run's approval through the origin Thread", async () => {
    const { target, row } = await waitingPairApproval();
    expect(
      await resolveFrom(originThreadId, row.id, { answeredByUserId: otherUserId }),
    ).toMatchObject({ outcome: "rejected", reason: "forbidden" });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: target.run.id } })).toMatchObject({
      status: "waiting_input",
    });
  });

  it("stops accepting a cross-Thread decision once the capability is turned back off", async () => {
    const { target, row } = await waitingPairApproval();
    await expect(resolveFrom(originThreadId, row.id, { gates: PAIR_OFF })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RoundtableFeatureDisabledError && error.feature === "private_pair",
    );
    expect(await prisma.run.findUniqueOrThrow({ where: { id: target.run.id } })).toMatchObject({
      status: "waiting_input",
    });
    expect(await prisma.intervention.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "pending",
    });
  });

  it("resumes the bound pair Run and leaves the presentation Thread's own wait alone", async () => {
    const { target, row } = await waitingPairApproval();
    // The user's own Run in the visible Thread is waiting on a different card.
    const host = await startRun(originThreadId, hostBotId);
    expect(
      await pauseRunForInput(prisma, {
        spaceId: id,
        threadId: originThreadId,
        botId: hostBotId,
        runId: host.run.id,
        attemptId: host.attempt.id,
        leaseOwner: "worker",
        leaseFence: 1,
        blocks: textAsk("Which host release?"),
      }),
    ).toBe(true);
    const hostRow = await prisma.intervention.findFirstOrThrow({ where: { runId: host.run.id } });

    expect(await resolveFrom(originThreadId, row.id)).toMatchObject({ outcome: "accepted" });

    expect(await prisma.run.findUniqueOrThrow({ where: { id: target.run.id } })).toMatchObject({
      status: "queued",
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: host.run.id } })).toMatchObject({
      status: "waiting_input",
    });
    expect(
      await prisma.intervention.findUniqueOrThrow({ where: { id: hostRow.id } }),
    ).toMatchObject({
      status: "pending",
    });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: host.task.id } })).toMatchObject({
      prompt: "Wait",
    });
  });

  it("refuses a decision whose bound Attempt was superseded", async () => {
    const { target, row } = await waitingPairApproval();
    // A resume opens a newer Attempt and fails the older active one, so a
    // decision arriving for the superseded Attempt describes an execution whose
    // parameters no longer exist.
    await prisma.attempt.update({ where: { id: target.attempt.id }, data: { status: "failed" } });
    await prisma.attempt.create({ data: { runId: target.run.id, fence: 2, status: "running" } });

    expect(await resolveFrom(originThreadId, row.id)).toMatchObject({
      outcome: "rejected",
      reason: "conflict",
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: target.run.id } })).toMatchObject({
      status: "waiting_input",
    });
    expect(await prisma.intervention.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "pending",
    });
  });

  it("consumes one Intervention once when two clients decide at the same time", async () => {
    const { target, row } = await waitingPairApproval();
    const [first, second] = await Promise.all([
      resolveFrom(originThreadId, row.id),
      resolveFrom(originThreadId, row.id),
    ]);
    const applied = [first, second].filter(
      (result) => result.outcome === "accepted" && result.applied,
    );
    expect(applied).toHaveLength(1);
    const other = [first, second].find((result) => !applied.includes(result));
    expect(other).toMatchObject({ outcome: "already_handled", applied: false, resume: false });

    // Server-side CAS, not a disabled button: one resume, one projection, one
    // Effect transition, one recorded submission.
    expect(await prisma.interventionSubmission.count({ where: { interventionId: row.id } })).toBe(
      1,
    );
    expect(
      await prisma.event.count({ where: { runId: target.run.id, type: "intervention.resolved" } }),
    ).toBe(1);
    expect(
      await prisma.event.count({ where: { runId: target.run.id, type: "approval.resolved" } }),
    ).toBe(1);
    expect(await prisma.intervention.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "answered",
    });
  });

  it("replays the same clientSubmissionId as an idempotent accept", async () => {
    const { target, row } = await waitingPairApproval();
    const clientSubmissionId = randomUUID();
    expect(await resolveFrom(originThreadId, row.id, { clientSubmissionId })).toMatchObject({
      outcome: "accepted",
      applied: true,
    });
    expect(await resolveFrom(originThreadId, row.id, { clientSubmissionId })).toMatchObject({
      outcome: "accepted",
      applied: false,
      resume: false,
    });
    expect(await prisma.interventionSubmission.count({ where: { interventionId: row.id } })).toBe(
      1,
    );
    expect(
      await prisma.event.count({ where: { runId: target.run.id, type: "intervention.resolved" } }),
    ).toBe(1);
  });

  it("projects a wait timeout into the presentation Thread", async () => {
    const source = await startSourceRun();
    const target = await startPairRun();
    expect(await pausePairRun(source, target, textAsk())).toBe(true);
    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: target.run.id } });

    await prisma.$transaction(
      (tx) =>
        expireWaitingRunInTransaction(
          tx,
          target.run.id,
          new Date(Date.now() + WAIT_TIMEOUT_MS.input + 1000),
        ),
      TX,
    );

    expect(await prisma.intervention.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "expired",
    });
    const resolved = await prisma.event.findFirstOrThrow({
      where: { threadId: originThreadId, runId: target.run.id, type: "intervention.resolved" },
    });
    expect(resolved.payload).toMatchObject({ interventionId: row.id, status: "expired" });
    // The expired card is gone from the answering Thread's pending projection.
    const pending = await prisma.$transaction((tx) =>
      loadInterventionViews(tx, originThreadId, []),
    );
    expect(pending.map((view) => view.id)).not.toContain(row.id);
  });

  it("projects a withdrawal into the presentation Thread", async () => {
    const source = await startSourceRun();
    const target = await startPairRun();
    expect(await pausePairRun(source, target, textAsk())).toBe(true);
    const row = await prisma.intervention.findFirstOrThrow({ where: { runId: target.run.id } });

    await prisma.$transaction(
      (tx) =>
        cancelRunsInTransaction(
          tx,
          [{ id: target.run.id, taskId: target.task.id }],
          new Date(),
          undefined,
        ),
      TX,
    );

    expect(await prisma.intervention.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "cancelled",
    });
    const resolved = await prisma.event.findFirstOrThrow({
      where: { threadId: originThreadId, runId: target.run.id, type: "intervention.resolved" },
    });
    expect(resolved.payload).toMatchObject({ interventionId: row.id, status: "cancelled" });
  });

  async function raceOutcome<T>(work: Promise<T>): Promise<{ value: T } | { error: string }> {
    try {
      return { value: await work };
    } catch (error) {
      return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  }

  it("deadlock-free: cross-thread answer vs cancel of the same pair Run", async () => {
    // The answer locks the presentation Thread then the executing one; a cancel
    // starts from the Run. Sorted Thread locks taken before any Run lock are what
    // keep the two from meeting in opposite order (40P01).
    for (let round = 0; round < 8; round++) {
      const source = await startSourceRun();
      const target = await startPairRun();
      expect(await pausePairRun(source, target, textAsk())).toBe(true);
      const row = await prisma.intervention.findFirstOrThrow({ where: { runId: target.run.id } });
      const results: Array<{ value?: unknown; error?: string }> = await Promise.all([
        raceOutcome(
          side.$transaction(
            (tx) =>
              cancelRunsInTransaction(
                tx,
                [{ id: target.run.id, taskId: target.task.id }],
                new Date(),
              ),
            TX,
          ),
        ),
        raceOutcome(resolveFrom(originThreadId, row.id, { answer: "v2.1" })),
      ]);
      for (const result of results) {
        if (result.error) throw new Error(`round ${round}: ${result.error}`);
      }
      expect(
        await prisma.event.count({
          where: { runId: target.run.id, type: "intervention.resolved" },
        }),
      ).toBe(1);
      const settled = await prisma.intervention.findUniqueOrThrow({ where: { id: row.id } });
      expect(["answered", "cancelled"]).toContain(settled.status);
    }
  });

  it("deadlock-free: cross-thread answer vs clearing the executing Thread", async () => {
    // clearThread locks the Thread it clears before it reaches the settle helper,
    // which is exactly the shape that inverts against an answer taking the
    // presentation Thread first. Group ordering — execution Threads before
    // presentation Threads — is what keeps the two meeting in the same order.
    // Thread ids are random, so eight rounds cover both sort orders.
    for (let round = 0; round < 8; round++) {
      const source = await startSourceRun();
      const target = await startPairRun();
      expect(await pausePairRun(source, target, textAsk())).toBe(true);
      const row = await prisma.intervention.findFirstOrThrow({ where: { runId: target.run.id } });
      const results: Array<{ value?: unknown; error?: string }> = await Promise.all([
        raceOutcome(clearThread(side, { spaceId: id, threadId: pairThreadId, botId: peerBotId })),
        raceOutcome(resolveFrom(originThreadId, row.id, { answer: "v2.1" })),
      ]);
      for (const result of results) {
        if (result.error) throw new Error(`round ${round}: ${result.error}`);
      }
      expect(
        await prisma.event.count({
          where: { runId: target.run.id, type: "intervention.resolved" },
        }),
      ).toBe(1);
      const settled = await prisma.intervention.findUniqueOrThrow({ where: { id: row.id } });
      expect(["answered", "cancelled"]).toContain(settled.status);
      // The projection stays anchored to the answering Thread either way.
      expect(settled.threadId).toBe(originThreadId);
    }
  });

  it("deadlock-free: cross-thread answer vs the wait-timeout sweeper", async () => {
    for (let round = 0; round < 8; round++) {
      const source = await startSourceRun();
      const target = await startPairRun();
      expect(await pausePairRun(source, target, textAsk())).toBe(true);
      const row = await prisma.intervention.findFirstOrThrow({ where: { runId: target.run.id } });
      const results: Array<{ value?: unknown; error?: string }> = await Promise.all([
        raceOutcome(
          side.$transaction(
            (tx) =>
              expireWaitingRunInTransaction(
                tx,
                target.run.id,
                new Date(Date.now() + WAIT_TIMEOUT_MS.input + 1000),
              ),
            TX,
          ),
        ),
        raceOutcome(resolveFrom(originThreadId, row.id, { answer: "v2.1" })),
      ]);
      for (const result of results) {
        if (result.error) throw new Error(`round ${round}: ${result.error}`);
      }
      expect(
        await prisma.event.count({
          where: { runId: target.run.id, type: "intervention.resolved" },
        }),
      ).toBe(1);
      const settled = await prisma.intervention.findUniqueOrThrow({ where: { id: row.id } });
      expect(["answered", "expired"]).toContain(settled.status);
    }
  });
});
