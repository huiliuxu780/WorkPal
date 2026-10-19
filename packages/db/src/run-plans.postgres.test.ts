import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { appendEvent } from "./events.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";
import {
  applyPlanReviewDecisionInTransaction,
  applyPlanSubmission,
  loadCurrentRunPlans,
  planContentFingerprint,
  recordLegacyNativePlanDecision,
  settleOrphanedPlanReview,
  submitDraftForReview,
} from "./run-plans.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("unified plan review service (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let botId: string;
  let threadId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("runplans");
    prisma = isolated.db.prisma;
    await prisma.user.create({
      data: { id, name: "Plan test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Plan test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Plan test" } });
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
        data: { spaceId: id, userId: id, name: "Plan bot", color: "test" },
      })
    ).id;
    threadId = (await prisma.thread.create({ data: { spaceId: id, userId: id, botId } })).id;
  });

  afterAll(async () => {
    await isolated?.drop();
  });

  async function makeRun(): Promise<string> {
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId, threadId, prompt: "Plan", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId,
        threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });
    return run.id;
  }

  const scopeFor = (runId: string, toolExecutionId: string) => ({
    spaceId: id,
    threadId,
    botId,
    runId,
    toolExecutionId,
  });

  async function setRunStatus(runId: string, status: string) {
    await prisma.run.update({ where: { id: runId }, data: { status } });
  }

  async function decide(
    runId: string,
    roundId: string,
    decision: "approve" | "request_changes" | "reject",
    feedback?: string,
  ) {
    await setRunStatus(runId, "waiting_input");
    await prisma.$transaction((tx) =>
      applyPlanReviewDecisionInTransaction(tx, {
        runId,
        roundId,
        decision,
        feedback: feedback ?? null,
        decidedByUserId: id,
        clientSubmissionId: `submission-${randomUUID()}`,
      }),
    );
    await setRunStatus(runId, "running");
  }

  const planRow = (runId: string) => prisma.runPlan.findUniqueOrThrow({ where: { runId } });
  const roundCount = (runId: string) => prisma.runPlanReview.count({ where: { runId } });

  it("first structured publish opens exactly one review round and replays idempotently", async () => {
    const runId = await makeRun();
    const scope = scopeFor(runId, "call-1");
    const input = {
      expectedRevision: 0,
      goal: "Review and deliver",
      items: [{ id: "review", title: "Review source", status: "active" as const }],
    };
    const first = await applyPlanSubmission(prisma, scope, input, {
      source: "publish_run_plan",
      submit: true,
    });
    expect(first.status).toBe("review_required");
    if (first.status !== "review_required") throw new Error("expected review_required");
    expect(first.round.contentVersion).toBe(1);
    expect(first.content).toMatchObject({
      planId: first.plan.planId,
      contentVersion: 1,
      goal: "Review and deliver",
      source: "publish_run_plan",
    });
    expect(await planRow(runId)).toMatchObject({ revision: 1, contentVersion: 1, reviewStatus: "pending" });
    expect(await roundCount(runId)).toBe(1);

    // Same bridge execution replays without a second round or event.
    const replay = await applyPlanSubmission(prisma, scope, input, {
      source: "publish_run_plan",
      submit: true,
    });
    expect(replay.status).toBe("replayed");
    expect(await roundCount(runId)).toBe(1);
    expect(await prisma.event.count({ where: { runId, type: "plan.revised" } })).toBe(1);

    // A stale expectedRevision is a business conflict, not an error.
    expect(
      await applyPlanSubmission(
        prisma,
        scopeFor(runId, "call-stale"),
        input,
        { source: "publish_run_plan", submit: true },
      ),
    ).toEqual({ status: "conflict", currentRevision: 1 });

    // While a review is pending the run is paused; a racing publish refuses.
    await expect(
      applyPlanSubmission(
        prisma,
        scopeFor(runId, "call-race"),
        { ...input, items: [{ id: "review", title: "Review source", status: "completed" }] },
        { source: "publish_run_plan", submit: true },
      ),
    ).rejects.toThrow("already pending");

    // Removing an item without marking it superseded/skipped still refuses.
    await expect(
      applyPlanSubmission(
        prisma,
        scopeFor(runId, "call-invalid"),
        {
          expectedRevision: 1,
          goal: "Changed",
          items: [{ id: "other", title: "Other", status: "pending" as const }],
          changeReason: "Scope changed",
        },
        { source: "publish_run_plan", submit: true },
      ),
    ).rejects.toThrow("retain prior item ids");

    await decide(runId, first.round.roundId, "approve");
    const approved = await planRow(runId);
    expect(approved).toMatchObject({
      reviewStatus: "approved",
      approvedContentVersion: 1,
      contentVersion: 1,
    });
    expect(approved.approvedFingerprint).toBe(
      planContentFingerprint("Review and deliver", [
        { id: "review", title: "Review source", status: "active" as const },
      ]),
    );
    expect(await prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      planPhase: "build",
    });
  });

  it("keeps progress revisions on the approved basis and never re-reviews identical content", async () => {
    const runId = await makeRun();
    const first = await applyPlanSubmission(
      prisma,
      scopeFor(runId, "p-1"),
      {
        expectedRevision: 0,
        goal: "Ship the release",
        items: [
          { id: "build", title: "Build", status: "active" as const },
          { id: "verify", title: "Verify", status: "pending" as const },
        ],
      },
      { source: "publish_run_plan", submit: true },
    );
    if (first.status !== "review_required") throw new Error("expected review_required");
    await decide(runId, first.round.roundId, "approve");

    // Status-only update: progress revision, same content version, no new round.
    const progress = await applyPlanSubmission(
      prisma,
      scopeFor(runId, "p-2"),
      {
        expectedRevision: 1,
        goal: "Ship the release",
        items: [
          { id: "build", title: "Build", status: "completed" as const },
          { id: "verify", title: "Verify", status: "active" as const },
        ],
        changeReason: "Build finished",
      },
      { source: "publish_run_plan", submit: true },
    );
    expect(progress.status).toBe("progress");
    expect(await planRow(runId)).toMatchObject({
      revision: 2,
      contentVersion: 1,
      reviewStatus: "approved",
    });
    expect(await roundCount(runId)).toBe(1);

    // Byte-identical replay of the same content is a no-op, not a new revision.
    const unchanged = await applyPlanSubmission(
      prisma,
      scopeFor(runId, "p-3"),
      {
        expectedRevision: 2,
        goal: "Ship the release",
        items: [
          { id: "build", title: "Build", status: "completed" as const },
          { id: "verify", title: "Verify", status: "active" as const },
        ],
        changeReason: "Build finished",
      },
      { source: "publish_run_plan", submit: true },
    );
    expect(unchanged.status).toBe("unchanged");
    expect(await prisma.runPlanRevision.count({ where: { runId } })).toBe(2);

    // A content change (new stage) re-opens review on a new content version.
    const changed = await applyPlanSubmission(
      prisma,
      scopeFor(runId, "p-4"),
      {
        expectedRevision: 2,
        goal: "Ship the release",
        items: [
          { id: "build", title: "Build", status: "completed" as const },
          { id: "verify", title: "Verify", status: "active" as const },
          { id: "announce", title: "Announce", status: "pending" as const },
        ],
        changeReason: "Added announce stage",
      },
      { source: "plan_write", submit: false },
    );
    expect(changed.status).toBe("review_required");
    if (changed.status !== "review_required") throw new Error("expected review_required");
    expect(changed.round.contentVersion).toBe(2);
    expect(await planRow(runId)).toMatchObject({ contentVersion: 2, reviewStatus: "pending" });

    await decide(runId, changed.round.roundId, "approve");
    expect(await planRow(runId)).toMatchObject({
      reviewStatus: "approved",
      approvedContentVersion: 2,
    });
  });

  it("runs the draft → submit → changes_requested → resubmit → approve cycle", async () => {
    const runId = await makeRun();
    // plan_write drafts without opening a review.
    const draft = await applyPlanSubmission(
      prisma,
      scopeFor(runId, "w-1"),
      {
        expectedRevision: 0,
        goal: "Plan the migration",
        items: [{ id: "audit", title: "Audit tables", status: "pending" as const }],
      },
      { source: "plan_write", submit: false },
    );
    expect(draft.status).toBe("draft_saved");
    expect(await planRow(runId)).toMatchObject({ reviewStatus: "draft" });
    expect(await roundCount(runId)).toBe(0);

    // plan_exit submits the current draft.
    const submitted = await submitDraftForReview(prisma, scopeFor(runId, "x-1"));
    expect(submitted.status).toBe("review_required");
    if (submitted.status !== "review_required") throw new Error("expected review_required");
    expect(submitted.round.source).toBe("plan_exit");
    expect(submitted.alreadyPending).toBe(false);

    // Requesting changes records feedback and keeps the same content version
    // when the model resubmits without changing content.
    await decide(runId, submitted.round.roundId, "request_changes", "Split audit per table");
    expect(await planRow(runId)).toMatchObject({ reviewStatus: "changes_requested" });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      planPhase: "planning",
    });
    const resubmit = await submitDraftForReview(prisma, scopeFor(runId, "x-2"));
    expect(resubmit.status).toBe("review_required");
    if (resubmit.status !== "review_required") throw new Error("expected review_required");
    expect(resubmit.round.contentVersion).toBe(1);
    expect(await roundCount(runId)).toBe(2);

    await decide(runId, resubmit.round.roundId, "approve");
    const approved = await planRow(runId);
    expect(approved.reviewStatus).toBe("approved");
    // An approved plan resubmitted without changes never opens a second card.
    const again = await submitDraftForReview(prisma, scopeFor(runId, "x-3"));
    expect(again.status).toBe("already_approved");
    expect(await roundCount(runId)).toBe(2);
    const feedbackRound = await prisma.runPlanReview.findFirstOrThrow({
      where: { runId, status: "changes_requested" },
    });
    expect(feedbackRound.feedback).toBe("Split audit per table");
    expect(feedbackRound.decidedByUserId).toBe(id);
    expect(feedbackRound.decisionSubmissionId).toBeTruthy();
  });

  it("rejects: review rejected, later submissions refused", async () => {
    const runId = await makeRun();
    const first = await applyPlanSubmission(
      prisma,
      scopeFor(runId, "r-1"),
      {
        expectedRevision: 0,
        goal: "Delete everything",
        items: [{ id: "drop", title: "Drop tables", status: "pending" as const }],
      },
      { source: "publish_run_plan", submit: true },
    );
    if (first.status !== "review_required") throw new Error("expected review_required");
    await decide(runId, first.round.roundId, "reject", "Too dangerous");
    expect(await planRow(runId)).toMatchObject({ reviewStatus: "rejected" });
    await expect(
      applyPlanSubmission(
        prisma,
        scopeFor(runId, "r-2"),
        {
          expectedRevision: 1,
          goal: "Delete everything",
          items: [{ id: "drop", title: "Drop tables", status: "pending" as const }],
          changeReason: "retry",
        },
        { source: "publish_run_plan", submit: true },
      ),
    ).rejects.toThrow("rejected");
  });

  it("grandfathers legacy plans: progress rebaselines, first content change reviews", async () => {
    const runId = await makeRun();
    // A pre-UX-02 row: no review state, no fingerprints, contentVersion seeded
    // from revision by the migration.
    const legacyPlan = {
      planId: `plan:${runId}`,
      runId,
      sourceMessageId: null,
      revisionId: `plan:${runId}:2`,
      revision: 2,
      goal: "Legacy goal",
      items: [{ id: "a", title: "Legacy stage", status: "active" }],
      changeReason: null,
      createdAt: new Date().toISOString(),
    };
    await prisma.runPlan.create({
      data: {
        runId,
        planId: legacyPlan.planId,
        threadGeneration: 0,
        revision: 2,
        current: legacyPlan as object,
        contentVersion: 2,
      },
    });
    await prisma.runPlanRevision.create({
      data: {
        id: legacyPlan.revisionId,
        runId,
        revision: 2,
        snapshot: legacyPlan as object,
        eventSeq: 0,
        toolExecutionId: "legacy-call",
      },
    });

    const progress = await applyPlanSubmission(
      prisma,
      scopeFor(runId, "l-1"),
      {
        expectedRevision: 2,
        goal: "Legacy goal",
        items: [{ id: "a", title: "Legacy stage", status: "completed" as const }],
        changeReason: "Done",
      },
      { source: "publish_run_plan", submit: true },
    );
    expect(progress.status).toBe("progress");
    expect(await planRow(runId)).toMatchObject({
      revision: 3,
      contentVersion: 2,
      reviewStatus: null,
    });

    const changed = await applyPlanSubmission(
      prisma,
      scopeFor(runId, "l-2"),
      {
        expectedRevision: 3,
        goal: "Legacy goal, widened",
        items: [{ id: "a", title: "Legacy stage", status: "completed" as const }],
        changeReason: "Goal changed",
      },
      { source: "publish_run_plan", submit: true },
    );
    expect(changed.status).toBe("review_required");
    if (changed.status !== "review_required") throw new Error("expected review_required");
    expect(changed.round.contentVersion).toBe(3);
    await decide(runId, changed.round.roundId, "approve");
    expect(await planRow(runId)).toMatchObject({
      reviewStatus: "approved",
      approvedContentVersion: 3,
    });
  });

  it("settles orphaned rounds and records one-time legacy native decisions", async () => {
    const runId = await makeRun();
    const first = await applyPlanSubmission(
      prisma,
      scopeFor(runId, "o-1"),
      {
        expectedRevision: 0,
        goal: "Orphan cycle",
        items: [{ id: "s1", title: "Stage", status: "pending" as const }],
      },
      { source: "publish_run_plan", submit: true },
    );
    if (first.status !== "review_required") throw new Error("expected review_required");
    // A Stop/Clear cancel settles the pending round through the intervention funnel.
    await prisma.$transaction((tx) => settleOrphanedPlanReview(tx, runId, "cancelled"));
    expect(await planRow(runId)).toMatchObject({ reviewStatus: "cancelled" });
    const round = await prisma.runPlanReview.findUniqueOrThrow({
      where: { id: first.round.roundId },
    });
    expect(round.status).toBe("cancelled");

    // Legacy native plan approval resume: decided exactly once, audited.
    const runId2 = await makeRun();
    const legacyFirst = await recordLegacyNativePlanDecision(
      prisma,
      { spaceId: id, threadId, botId, runId: runId2 },
      "approve",
      { decidedByUserId: id },
    );
    expect(legacyFirst.plan).toBeNull();
    await applyPlanSubmission(
      prisma,
      scopeFor(runId2, "o-2"),
      {
        expectedRevision: 0,
        goal: "Native legacy",
        items: [{ id: "n1", title: "Stage", status: "pending" as const }],
      },
      { source: "plan_write", submit: false },
    );
    const decided = await recordLegacyNativePlanDecision(
      prisma,
      { spaceId: id, threadId, botId, runId: runId2 },
      "approve",
      { interventionId: "legacy-intervention", decidedByUserId: id },
    );
    expect(decided.contentVersion).toBe(1);
    await recordLegacyNativePlanDecision(
      prisma,
      { spaceId: id, threadId, botId, runId: runId2 },
      "approve",
      { decidedByUserId: id },
    );
    expect(
      await prisma.runPlanReview.count({ where: { runId: runId2, source: "legacy_native" } }),
    ).toBe(1);
    expect(await planRow(runId2)).toMatchObject({
      reviewStatus: "approved",
      approvedContentVersion: 1,
    });
  });

  it("excludes Plans from a cleared thread generation", async () => {
    const runId = await makeRun();
    await applyPlanSubmission(
      prisma,
      scopeFor(runId, "c-1"),
      {
        expectedRevision: 0,
        goal: "Cleared thread plan",
        items: [{ id: "g1", title: "Stage", status: "pending" as const }],
      },
      { source: "plan_write", submit: false },
    );
    expect((await prisma.$transaction((tx) => loadCurrentRunPlans(tx, threadId))).length).toBeGreaterThan(0);
    await appendEvent(prisma, {
      spaceId: id,
      threadId,
      botId,
      type: "thread.cleared",
      payload: {},
    });
    expect(await prisma.$transaction((tx) => loadCurrentRunPlans(tx, threadId))).toEqual([]);
  });
});
