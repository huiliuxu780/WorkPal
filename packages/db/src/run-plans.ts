import { createHash, randomUUID } from "node:crypto";
import {
  MessageBlock as MessageBlockSchema,
  type PlanItem,
  type PlanReviewContent,
  type PlanReviewSource,
  type PlanReviewState,
  PublishRunPlanInputSchema,
  type RunPlanRevision,
  RunPlanRevisionSchema,
} from "@rakazo/contracts";
import { appendEventInTransaction, currentThreadGeneration } from "./events.js";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

/**
 * UX-02 unified plan service: the single authoritative write path for the
 * product Plan. Native plan_enter/plan_write/plan_exit (through the Java
 * facade bridge) and the structured publish_run_plan tool all land here, on
 * the same planId, content version, and review state. Two axes stay separate:
 *
 * - `revision` — every recorded change (execution progress: item statuses,
 *   reasons, evidence-driven updates). Never re-opens a review by itself.
 * - `contentVersion` — the approval basis (goal + item ids/titles/order).
 *   Any change creates a new content version, and execution may not advance
 *   on mutating tools until that version is approved.
 *
 * A deterministic content fingerprint (normalized goal + ordered id/title
 * pairs) decides which axis a submission moves: identical fingerprints are
 * progress; a changed fingerprint is a new content version requiring review.
 * The model never self-reports "this is a small change".
 */

export type PlanSubmissionScope = {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  toolExecutionId: string;
};

export type PlanReviewRoundInfo = {
  roundId: string;
  planId: string;
  contentVersion: number;
  revision: number;
  source: PlanReviewSource;
};

export type ApplyPlanSubmissionResult =
  | { status: "replayed"; plan: RunPlanRevision; seq: number; reviewStatus: string | null }
  | { status: "conflict"; currentRevision: number }
  | { status: "unchanged"; plan: RunPlanRevision }
  | { status: "progress"; plan: RunPlanRevision; seq: number }
  | { status: "draft_saved"; plan: RunPlanRevision; seq: number; contentVersion: number }
  | {
      status: "review_required";
      plan: RunPlanRevision;
      seq: number;
      round: PlanReviewRoundInfo;
      content: PlanReviewContent;
    };

function normalizePlanText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** Deterministic approval-basis fingerprint: goal + ordered item ids/titles. */
export function planContentFingerprint(goal: string, items: readonly PlanItem[]): string {
  const canonical = JSON.stringify({
    goal: normalizePlanText(goal),
    items: items.map((item) => ({ id: item.id, title: normalizePlanText(item.title) })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function samePlanContent(
  left: { goal: string; items: readonly PlanItem[] },
  right: { goal: string; items: readonly PlanItem[] },
): boolean {
  if (normalizePlanText(left.goal) !== normalizePlanText(right.goal)) return false;
  if (left.items.length !== right.items.length) return false;
  for (const [index, item] of left.items.entries()) {
    const other = right.items[index]!;
    if (item.id !== other.id) return false;
    if (normalizePlanText(item.title) !== normalizePlanText(other.title)) return false;
    if (item.status !== other.status) return false;
    if ((item.reason ?? null) !== (other.reason ?? null)) return false;
  }
  return true;
}

function reviewContentOf(
  plan: RunPlanRevision,
  contentVersion: number,
  source: PlanReviewSource,
): PlanReviewContent {
  return {
    planId: plan.planId,
    contentVersion,
    revision: plan.revision,
    goal: plan.goal,
    items: plan.items.map((item) => ({ id: item.id, title: item.title, status: item.status })),
    source,
  };
}

async function lockRunForPlan(
  tx: Prisma.TransactionClient,
  scope: Omit<PlanSubmissionScope, "toolExecutionId">,
) {
  // The Run row serializes concurrent revisions and makes the expectedRevision check atomic.
  await tx.$queryRaw`SELECT id FROM runs WHERE id = ${scope.runId} FOR UPDATE`;
  const run = await tx.run.findUnique({
    where: { id: scope.runId },
    select: {
      id: true,
      spaceId: true,
      threadId: true,
      botId: true,
      status: true,
      sourceMessageId: true,
    },
  });
  if (
    !run ||
    run.spaceId !== scope.spaceId ||
    run.threadId !== scope.threadId ||
    run.botId !== scope.botId ||
    run.status !== "running"
  ) {
    throw new Error("Run is not authorized to publish a Plan");
  }
  return run;
}

async function createReviewRound(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    planId: string;
    contentVersion: number;
    revision: number;
    source: PlanReviewSource;
    toolExecutionId: string;
  },
): Promise<PlanReviewRoundInfo> {
  const roundId = randomUUID();
  await tx.runPlanReview.create({
    data: {
      id: roundId,
      runId: input.runId,
      planId: input.planId,
      contentVersion: input.contentVersion,
      revision: input.revision,
      status: "pending",
      source: input.source,
      toolExecutionId: input.toolExecutionId,
      submittedAt: new Date(),
    },
  });
  return {
    roundId,
    planId: input.planId,
    contentVersion: input.contentVersion,
    revision: input.revision,
    source: input.source,
  };
}

/**
 * Unified content submission for plan_write (draft) and publish_run_plan
 * (submit). Writes the new revision, moves the correct axis, and opens a
 * review round whenever the approval basis changed or the entry submits.
 * `review_required` means the caller must pause the run for the typed
 * plan_review intervention before any further model progress.
 */
export async function applyPlanSubmission(
  prisma: PrismaClient,
  scope: PlanSubmissionScope,
  rawInput: unknown,
  options: { source: "plan_write" | "publish_run_plan"; submit: boolean },
): Promise<ApplyPlanSubmissionResult> {
  const input = PublishRunPlanInputSchema.parse(rawInput);
  if (!scope.toolExecutionId) throw new Error("Plan tool execution id is required");
  return prisma.$transaction(async (tx) => {
    const run = await lockRunForPlan(tx, scope);
    const priorCall = await tx.runPlanRevision.findUnique({
      where: { runId_toolExecutionId: { runId: run.id, toolExecutionId: scope.toolExecutionId } },
      select: { snapshot: true, eventSeq: true },
    });
    if (priorCall) {
      const plan = RunPlanRevisionSchema.parse(priorCall.snapshot);
      const current = await tx.runPlan.findUnique({ where: { runId: run.id } });
      return {
        status: "replayed" as const,
        plan,
        seq: priorCall.eventSeq,
        reviewStatus: current?.reviewStatus ?? null,
      };
    }
    const current = await tx.runPlan.findUnique({ where: { runId: run.id } });
    const currentRevision = current?.revision ?? 0;
    if (input.expectedRevision !== currentRevision)
      return { status: "conflict" as const, currentRevision };

    const previous = current ? RunPlanRevisionSchema.parse(current.current) : null;
    const revisionBase = {
      planId: current?.planId ?? `plan:${run.id}`,
      runId: run.id,
      sourceMessageId: run.sourceMessageId,
      goal: input.goal,
      items: input.items,
      changeReason: input.changeReason ?? null,
    };
    if (previous) {
      const ids = new Set(input.items.map((item) => item.id));
      if (previous.items.some((item) => !ids.has(item.id))) {
        throw new Error(
          "A revision must retain prior item ids; mark removed work superseded or skipped",
        );
      }
      if (samePlanContent(previous, input)) {
        return { status: "unchanged" as const, plan: previous };
      }
    }
    if (current?.reviewStatus === "pending") {
      throw new Error("A plan review is already pending for this run");
    }
    if (current?.reviewStatus === "rejected") {
      throw new Error("This plan was rejected; the run cannot revise it");
    }

    const fingerprint = planContentFingerprint(input.goal, input.items);
    const storedFingerprint =
      current?.contentFingerprint ??
      (previous ? planContentFingerprint(previous.goal, previous.items) : null);
    const contentChanged = storedFingerprint !== fingerprint;
    const approvedBasis =
      current?.reviewStatus === "approved" ||
      // Legacy plans (reviewStatus NULL) are grandfathered on their current
      // content: progress updates keep flowing, and the first content change
      // opens the first real review.
      (current !== null && current.reviewStatus === null);
    const opensReview = contentChanged
      ? approvedBasis || options.submit
      : // A submit with unchanged content only re-opens review for a draft or a
        // changes_requested version. Approved and legacy plans keep executing;
        // their status-only updates are progress revisions.
        options.submit &&
        current !== null &&
        current.reviewStatus !== "approved" &&
        current.reviewStatus !== null;
    const contentVersion = current
      ? contentChanged
        ? current.contentVersion + 1
        : current.contentVersion
      : 1;
    const reviewStatus = opensReview
      ? "pending"
      : contentChanged
        ? current?.reviewStatus === "approved"
          ? current.reviewStatus
          : "draft"
        : (current?.reviewStatus ?? null);

    const revision = currentRevision + 1;
    const plan: RunPlanRevision = {
      ...revisionBase,
      revisionId: `${revisionBase.planId}:${revision}`,
      revision,
      createdAt: new Date().toISOString(),
    };
    const generation = current
      ? current.threadGeneration
      : await currentThreadGeneration(tx, run.threadId);
    if (current) {
      await tx.runPlan.update({
        where: { runId: run.id },
        data: {
          revision,
          current: plan as Prisma.InputJsonValue,
          contentVersion,
          contentFingerprint: fingerprint,
          reviewStatus,
        },
      });
    } else {
      await tx.runPlan.create({
        data: {
          runId: run.id,
          planId: plan.planId,
          threadGeneration: generation,
          revision,
          current: plan as Prisma.InputJsonValue,
          contentVersion,
          contentFingerprint: fingerprint,
          reviewStatus,
        },
      });
    }
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "plan.revised",
      payload: plan,
      schemaVersion: 1,
    });
    await tx.runPlanRevision.create({
      data: {
        id: plan.revisionId,
        runId: run.id,
        revision,
        snapshot: plan as Prisma.InputJsonValue,
        eventSeq: event.seq,
        toolExecutionId: scope.toolExecutionId,
      },
    });
    if (!opensReview) {
      if (!contentChanged) return { status: "progress" as const, plan, seq: event.seq };
      return {
        status: "draft_saved" as const,
        plan,
        seq: event.seq,
        contentVersion,
      };
    }
    const round = await createReviewRound(tx, {
      runId: run.id,
      planId: plan.planId,
      contentVersion,
      revision,
      source: options.source,
      toolExecutionId: scope.toolExecutionId,
    });
    return {
      status: "review_required" as const,
      plan,
      seq: event.seq,
      round,
      content: reviewContentOf(plan, contentVersion, options.source),
    };
  });
}

export type SubmitDraftResult =
  | { status: "no_draft" }
  | { status: "already_approved"; plan: RunPlanRevision; contentVersion: number }
  | { status: "rejected"; plan: RunPlanRevision }
  | {
      status: "review_required";
      plan: RunPlanRevision;
      round: PlanReviewRoundInfo;
      content: PlanReviewContent;
      alreadyPending: boolean;
    };

/**
 * plan_exit: submit the current draft (or re-submit after changes were
 * requested) for review without writing new content. Idempotent for an
 * already-approved current version: a replay never opens a second card.
 */
export async function submitDraftForReview(
  prisma: PrismaClient,
  scope: PlanSubmissionScope,
): Promise<SubmitDraftResult> {
  return prisma.$transaction(async (tx) => {
    const run = await lockRunForPlan(tx, scope);
    const current = await tx.runPlan.findUnique({ where: { runId: run.id } });
    if (!current) return { status: "no_draft" as const };
    const plan = RunPlanRevisionSchema.parse(current.current);
    if (current.reviewStatus === "approved")
      return {
        status: "already_approved" as const,
        plan,
        contentVersion: current.contentVersion,
      };
    if (current.reviewStatus === "rejected") return { status: "rejected" as const, plan };
    if (current.reviewStatus === "pending") {
      const pending = await tx.runPlanReview.findFirst({
        where: { runId: run.id, status: "pending" },
        orderBy: { submittedAt: "desc" },
      });
      if (!pending) throw new Error("Plan review is pending without a review round");
      return {
        status: "review_required" as const,
        plan,
        alreadyPending: true,
        round: {
          roundId: pending.id,
          planId: pending.planId,
          contentVersion: pending.contentVersion,
          revision: pending.revision,
          source: pending.source as PlanReviewSource,
        },
        content: reviewContentOf(plan, pending.contentVersion, pending.source as PlanReviewSource),
      };
    }
    // draft | changes_requested | NULL (legacy): open the review round on the
    // current content version. A legacy plan gets its fingerprint rebaselined
    // so later progress updates compare against the reviewed content.
    const fingerprint =
      current.contentFingerprint ?? planContentFingerprint(plan.goal, plan.items);
    await tx.runPlan.update({
      where: { runId: run.id },
      data: { reviewStatus: "pending", contentFingerprint: fingerprint },
    });
    const round = await createReviewRound(tx, {
      runId: run.id,
      planId: current.planId,
      contentVersion: current.contentVersion,
      revision: current.revision,
      source: "plan_exit",
      toolExecutionId: scope.toolExecutionId,
    });
    return {
      status: "review_required" as const,
      plan,
      alreadyPending: false,
      round,
      content: reviewContentOf(plan, current.contentVersion, "plan_exit"),
    };
  });
}

/** Pairs a resumed bridge re-run (same executionId) with its review round. */
export async function planReviewRoundForToolExecution(
  prisma: PrismaClient | Prisma.TransactionClient,
  runId: string,
  toolExecutionId: string,
) {
  return prisma.runPlanReview.findFirst({
    where: { runId, toolExecutionId },
    orderBy: { submittedAt: "desc" },
  });
}

/**
 * One-time compatibility for a native plan approval that was already pending
 * before unified review existed: the answered legacy ask ("Allow plan_exit to
 * continue?") decides the original review exactly once. The audit round is
 * keyed by the resumed bridge executionId and created at most once per run
 * (source legacy_native), so a later fresh plan_exit in the same run can never
 * be mistaken for the legacy resume. Never creates a second card and never
 * re-executes anything.
 */
export async function recordLegacyNativePlanDecision(
  prisma: PrismaClient,
  scope: { spaceId: string; threadId: string; botId: string; runId: string },
  decision: "approve" | "reject",
  context: {
    toolExecutionId: string;
    interventionId?: string | null;
    decidedByUserId?: string | null;
  },
): Promise<{ plan: RunPlanRevision | null; contentVersion: number | null; replayed: boolean }> {
  return prisma.$transaction(async (tx) => {
    const run = await lockRunForPlan(tx, scope);
    const current = await tx.runPlan.findUnique({ where: { runId: run.id } });
    const plan = current ? RunPlanRevisionSchema.parse(current.current) : null;
    const existing = await tx.runPlanReview.findFirst({
      where: { runId: run.id, toolExecutionId: context.toolExecutionId },
      select: { id: true },
    });
    if (!existing) {
      await tx.runPlanReview.create({
        data: {
          id: randomUUID(),
          runId: run.id,
          planId: current?.planId ?? `plan:${run.id}`,
          contentVersion: current?.contentVersion ?? 0,
          revision: current?.revision ?? 0,
          status: decision === "approve" ? "approved" : "rejected",
          source: "legacy_native",
          toolExecutionId: context.toolExecutionId,
          submittedAt: new Date(),
          decidedAt: new Date(),
          ...(context.decidedByUserId ? { decidedByUserId: context.decidedByUserId } : {}),
          ...(context.interventionId ? { interventionId: context.interventionId } : {}),
        },
      });
    }
    if (current) {
      await tx.runPlan.update({
        where: { runId: run.id },
        data:
          decision === "approve"
            ? {
                reviewStatus: "approved",
                approvedContentVersion: current.contentVersion,
                approvedFingerprint:
                  current.contentFingerprint ?? planContentFingerprint(plan!.goal, plan!.items),
              }
            : { reviewStatus: "rejected" },
      });
    }
    if (decision === "approve") {
      await tx.run.updateMany({
        where: { id: run.id, status: "running" },
        data: { planPhase: "build" },
      });
    }
    return {
      plan,
      contentVersion: current?.contentVersion ?? null,
      replayed: Boolean(existing),
    };
  });
}

/**
 * The answered pre-UX-02 native plan approval ask of this run, when its resume
 * is what woke the current attempt: an ask block without a planReview binding,
 * offered exactly approve/reject, and answered with one of them.
 */
export async function latestAnsweredNativePlanAsk(
  prisma: PrismaClient,
  runId: string,
): Promise<{ answer: "approve" | "reject"; interventionId: string | null; resolvedByUserId: string | null } | null> {
  const messages = await prisma.message.findMany({
    where: { runId, role: "bot" },
    orderBy: { seq: "desc" },
    take: 8,
    select: { blocks: true },
  });
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    for (const block of [...parsed.data].reverse()) {
      if (block.kind !== "ask") continue;
      const actionIds = (block.actions ?? []).map((action) => action.id);
      const isLegacyPlanAsk =
        !block.planReview &&
        block.status === "answered" &&
        actionIds.length === 2 &&
        actionIds.includes("approve") &&
        actionIds.includes("reject");
      if (!isLegacyPlanAsk) return null;
      if (block.answer !== "approve" && block.answer !== "reject") return null;
      const intervention = block.interventionId
        ? await prisma.intervention.findUnique({
            where: { id: block.interventionId },
            select: { resolvedByUserId: true },
          })
        : null;
      return {
        answer: block.answer,
        interventionId: block.interventionId ?? null,
        resolvedByUserId: intervention?.resolvedByUserId ?? null,
      };
    }
  }
  return null;
}

/** Execute-time plan gate: the error text when a tool must not be sent, else null. */
export async function planExecutionGate(
  prisma: PrismaClient,
  runId: string,
): Promise<string | null> {
  const [plan, run] = await Promise.all([
    prisma.runPlan.findUnique({ where: { runId }, select: { reviewStatus: true } }),
    prisma.run.findUnique({ where: { id: runId }, select: { planPhase: true } }),
  ]);
  if (plan?.reviewStatus === "pending") {
    return "A plan review is pending for this run. The user must decide the submitted plan version before this tool can be sent.";
  }
  if (run?.planPhase === "planning") {
    return "Blocked: you are in PLAN mode (read-only). Record the plan with plan_write and submit it with plan_exit; execution resumes after the user approves.";
  }
  return null;
}

/** Current plan projection for tool results and the native PLAN.md mirror. */
export async function loadCurrentPlanProjection(
  prisma: PrismaClient,
  runId: string,
): Promise<{ goal: string; items: PlanItem[]; revision: number; contentVersion: number } | null> {
  const row = await prisma.runPlan.findUnique({
    where: { runId },
    select: { current: true, revision: true, contentVersion: true },
  });
  if (!row) return null;
  const parsed = RunPlanRevisionSchema.safeParse(row.current);
  if (!parsed.success) return null;
  return {
    goal: parsed.data.goal,
    items: parsed.data.items,
    revision: row.revision,
    contentVersion: row.contentVersion,
  };
}

/**
 * Attempt-start repair: a crash between the submission transaction and the
 * pause leaves a pending round without an intervention. Returns the binding
 * needed to re-issue the typed plan_review pause, or null when nothing is
 * pending or the pause already exists.
 */
export async function loadPendingPlanReviewRepair(
  prisma: PrismaClient,
  runId: string,
): Promise<{ content: PlanReviewContent; roundId: string } | null> {
  const round = await prisma.runPlanReview.findFirst({
    where: { runId, status: "pending", interventionId: null },
    orderBy: { submittedAt: "desc" },
  });
  if (!round) return null;
  const plan = await prisma.runPlan.findUnique({ where: { runId } });
  if (!plan || plan.reviewStatus !== "pending") return null;
  const current = RunPlanRevisionSchema.parse(plan.current);
  return {
    roundId: round.id,
    content: reviewContentOf(current, round.contentVersion, round.source as PlanReviewSource),
  };
}

/** Plan-level review state for ExecutionSnapshot; null for legacy/no plans. */
export async function loadPlanReviewState(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<PlanReviewState | null> {
  const plan = await tx.runPlan.findUnique({
    where: { runId },
    select: {
      planId: true,
      revision: true,
      contentVersion: true,
      reviewStatus: true,
      approvedContentVersion: true,
    },
  });
  if (!plan || plan.reviewStatus === null) return null;
  const latestFeedback = await tx.runPlanReview.findFirst({
    where: { runId, feedback: { not: null } },
    orderBy: { submittedAt: "desc" },
    select: { feedback: true },
  });
  return {
    planId: plan.planId,
    contentVersion: plan.contentVersion,
    reviewStatus: plan.reviewStatus as PlanReviewState["reviewStatus"],
    approvedContentVersion: plan.approvedContentVersion,
    revision: plan.revision,
    feedback: latestFeedback?.feedback ?? null,
  };
}

export type PlanReviewDecisionInput = {
  runId: string;
  roundId: string;
  decision: "approve" | "request_changes" | "reject";
  feedback: string | null;
  decidedByUserId: string;
  clientSubmissionId?: string;
};

/**
 * Persist one review decision inside the answer transaction (the run row is
 * already locked there): round audit, plan review state, approval basis, and
 * the mirrored plan phase. The caller owns resume/cancel mechanics, ask-block
 * updates, intervention settling, and lifecycle events.
 */
export async function applyPlanReviewDecisionInTransaction(
  tx: Prisma.TransactionClient,
  input: PlanReviewDecisionInput,
): Promise<{ contentVersion: number; planId: string }> {
  const round = await tx.runPlanReview.findUnique({ where: { id: input.roundId } });
  if (!round || round.runId !== input.runId || round.status !== "pending") {
    throw new Error("Plan review round is no longer pending");
  }
  const status =
    input.decision === "approve"
      ? "approved"
      : input.decision === "request_changes"
        ? "changes_requested"
        : "rejected";
  await tx.runPlanReview.update({
    where: { id: round.id },
    data: {
      status,
      decidedAt: new Date(),
      decidedByUserId: input.decidedByUserId,
      ...(input.feedback ? { feedback: input.feedback } : {}),
      ...(input.clientSubmissionId ? { decisionSubmissionId: input.clientSubmissionId } : {}),
    },
  });
  const plan = await tx.runPlan.findUnique({ where: { runId: input.runId } });
  if (plan) {
    await tx.runPlan.update({
      where: { runId: input.runId },
      data:
        input.decision === "approve"
          ? {
              reviewStatus: "approved",
              approvedContentVersion: round.contentVersion,
              approvedFingerprint: plan.contentFingerprint,
            }
          : { reviewStatus: status },
    });
  }
  if (input.decision !== "reject") {
    await tx.run.updateMany({
      where: { id: input.runId, status: "waiting_input" },
      data: { planPhase: input.decision === "approve" ? "build" : "planning" },
    });
  }
  return { contentVersion: round.contentVersion, planId: round.planId };
}

/** Settle the pending round when its intervention expires or is cancelled. */
export async function settleOrphanedPlanReview(
  tx: Prisma.TransactionClient,
  runId: string,
  status: "cancelled" | "expired",
): Promise<void> {
  await tx.runPlanReview.updateMany({
    where: { runId, status: "pending" },
    data: { status, decidedAt: new Date() },
  });
  await tx.runPlan.updateMany({
    where: { runId, reviewStatus: "pending" },
    data: { reviewStatus: "cancelled" },
  });
}

/** Current revisions only, scoped to the thread's current clear generation. */
export async function loadCurrentRunPlans(
  tx: Prisma.TransactionClient,
  threadId: string,
): Promise<RunPlanRevision[]> {
  const generation = await currentThreadGeneration(tx, threadId);
  const rows = await tx.runPlan.findMany({
    where: { threadGeneration: generation, run: { threadId } },
    orderBy: [{ updatedAt: "desc" }, { runId: "desc" }],
    take: 20,
    select: { current: true },
  });
  return rows.map((row) => RunPlanRevisionSchema.parse(row.current));
}
