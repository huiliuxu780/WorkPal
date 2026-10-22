import { createHash, randomUUID } from "node:crypto";
import {
  type InterventionPlanReview,
  InterventionPlanReviewSchema,
  type InterventionPresentation,
  InterventionPresentationSchema,
  type InterventionView,
  legacyInterventionId,
  type MessageBlock,
  MessageBlock as MessageBlockSchema,
  presentationFromAskBlock,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  type InterventionThreads,
  isApprovalAskBlock,
  isSecretAskBlock,
} from "@rakazo/core";
import type { Prisma } from "./client.js";

/** Same wait as input and approval runs. Kept here to avoid a cycle with wait-timeouts. */
export const INTERVENTION_WAIT_MS = 24 * 60 * 60 * 1000;

export class InterventionRejected extends Error {
  readonly reason: "invalid_submission" | "forbidden" | "not_found" | "conflict";

  constructor(reason: InterventionRejected["reason"]) {
    super(reason);
    this.name = "InterventionRejected";
    this.reason = reason;
  }
}

export type InterventionRecord = {
  id: string;
  revision: number;
  kind: string;
  status: string;
  spaceId: string;
  threadId: string;
  runId: string;
  attemptId: string;
  botId: string;
  messageId: string;
  pendingRunKey: string | null;
  expiresAt: Date | null;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  supersededById: string | null;
  agentId: string | null;
  backgroundTaskId: string | null;
  inputMode: string | null;
  inputPurpose: string | null;
  inputActions: unknown;
  presentation: unknown;
  planReview?: unknown;
  effectId: string | null;
  decision: string | null;
  createdAt: Date;
};

type InterventionTx = Prisma.TransactionClient;

export function interventionStore(tx: object): InterventionTx["intervention"] | null {
  const store = (tx as { intervention?: InterventionTx["intervention"] }).intervention;
  if (!store || typeof store.findFirst !== "function" || typeof store.create !== "function") {
    return null;
  }
  return store;
}

export function assertSafeClientSubmissionId(clientSubmissionId: string, answer: string): void {
  if (clientSubmissionId.length < 8 || clientSubmissionId.length > 200) {
    throw new InterventionRejected("invalid_submission");
  }
  if (clientSubmissionId === answer) throw new InterventionRejected("invalid_submission");
  const digest = createHash("sha256").update(answer).digest("hex");
  if (
    clientSubmissionId === digest ||
    clientSubmissionId === digest.toUpperCase() ||
    clientSubmissionId === `sha256:${digest}`
  ) {
    throw new InterventionRejected("invalid_submission");
  }
  if (answer.length >= 12 && clientSubmissionId.includes(answer)) {
    throw new InterventionRejected("invalid_submission");
  }
}

function asksIn(blocks: MessageBlock[]): Array<Extract<MessageBlock, { kind: "ask" }>> {
  return blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "ask" }> => block.kind === "ask",
  );
}

function whitelistedActions(
  actions: Array<{ id: string; label: string }> | undefined,
): Array<{ id: string; label: string }> | undefined {
  if (!actions?.length) return undefined;
  return actions.map((action) => ({ id: action.id, label: action.label }));
}

function inputModeOf(
  ask: Extract<MessageBlock, { kind: "ask" }>,
): "text" | "choice" | "secret" | null {
  if (ask.approvalEffectId) return null;
  if (ask.input === "secret") return "secret";
  if (ask.actions?.length) return "choice";
  return "text";
}

function actionList(value: unknown): Array<{ id: string; label: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions: Array<{ id: string; label: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const id = "id" in item && typeof item.id === "string" ? item.id : "";
    const label = "label" in item && typeof item.label === "string" ? item.label : "";
    if (!id) continue;
    actions.push({ id, label });
  }
  return actions.length > 0 ? actions : undefined;
}

async function readEffectStatus(
  tx: InterventionTx,
  effectId: string | null,
): Promise<string | undefined> {
  if (!effectId) return undefined;
  const effect = await tx.externalEffect.findUnique({
    where: { id: effectId },
    select: { status: true },
  });
  return effect?.status ?? "unknown";
}

export function interventionView(row: InterventionRecord, effectStatus?: string): InterventionView {
  const parsedPresentation = InterventionPresentationSchema.safeParse(row.presentation);
  const presentation = parsedPresentation.success ? parsedPresentation.data : undefined;
  const parsedPlanReview = InterventionPlanReviewSchema.safeParse(row.planReview);
  const planReview: InterventionPlanReview | undefined =
    row.kind === "plan_review" && parsedPlanReview.success ? parsedPlanReview.data : undefined;
  const actions = actionList(row.inputActions);
  const decision =
    row.decision === "approved" || row.decision === "denied" ? row.decision : undefined;
  const mode =
    row.inputMode === "text" || row.inputMode === "choice" || row.inputMode === "secret"
      ? row.inputMode
      : undefined;
  const purpose =
    row.inputPurpose === "otp" || row.inputPurpose === "password" || row.inputPurpose === "api_key"
      ? row.inputPurpose
      : undefined;
  let input: InterventionView["input"];
  if (row.kind === "input" && mode) {
    input = { mode };
    if (purpose) input.purpose = purpose;
    if (actions) input.actions = actions;
  }
  const approval: InterventionView["approval"] =
    row.kind === "approval" && row.effectId
      ? {
          effectId: row.effectId,
          effectStatus: effectStatus || "unknown",
        }
      : undefined;
  if (approval && decision) approval.decision = decision;
  if (approval && actions) approval.actions = actions;
  return {
    id: row.id,
    revision: row.revision,
    kind:
      row.kind === "approval" ? "approval" : row.kind === "plan_review" ? "plan_review" : "input",
    status:
      row.status === "answered" ||
      row.status === "expired" ||
      row.status === "cancelled" ||
      row.status === "superseded"
        ? row.status
        : "pending",
    spaceId: row.spaceId,
    threadId: row.threadId,
    runId: row.runId,
    attemptId: row.attemptId,
    botId: row.botId,
    messageId: row.messageId,
    createdAt: row.createdAt.toISOString(),
    ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt.toISOString() } : {}),
    ...(row.resolvedByUserId ? { resolvedByUserId: row.resolvedByUserId } : {}),
    ...(row.supersededById ? { supersededById: row.supersededById } : {}),
    requestingActor: {
      botId: row.botId,
      ...(row.agentId ? { agentId: row.agentId } : {}),
      ...(row.backgroundTaskId ? { backgroundTaskId: row.backgroundTaskId } : {}),
    },
    ...(input ? { input } : {}),
    ...(approval ? { approval } : {}),
    ...(planReview ? { planReview } : {}),
    ...(presentation ? { presentation } : {}),
  };
}

function eventPayload(view: InterventionView): Record<string, unknown> {
  return {
    interventionId: view.id,
    revision: view.revision,
    kind: view.kind,
    status: view.status,
    runId: view.runId,
    attemptId: view.attemptId,
    messageId: view.messageId,
    botId: view.botId,
    createdAt: view.createdAt,
    ...(view.expiresAt ? { expiresAt: view.expiresAt } : {}),
    ...(view.resolvedAt ? { resolvedAt: view.resolvedAt } : {}),
    ...(view.resolvedByUserId ? { resolvedByUserId: view.resolvedByUserId } : {}),
    actor: view.requestingActor,
    ...(view.input ? { input: view.input } : {}),
    ...(view.approval ? { approval: view.approval } : {}),
    ...(view.planReview ? { planReview: view.planReview } : {}),
    ...(view.presentation ? { presentation: view.presentation } : {}),
  };
}

async function appendInterventionEvent(
  tx: InterventionTx,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    runId: string;
    type: "intervention.created" | "intervention.resolved";
    view: InterventionView;
  },
) {
  const { appendEventInTransaction } = await import("./events.js");
  return appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    runId: input.runId,
    type: input.type,
    schemaVersion: 1,
    payload: eventPayload(input.view),
  });
}

async function lockRun(tx: InterventionTx, runId: string) {
  await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`;
}

async function lockIntervention(tx: InterventionTx, interventionId: string) {
  await tx.$queryRaw`SELECT id FROM interventions WHERE id = ${interventionId} FOR UPDATE`;
}

/**
 * Lock the Thread rows a settling transaction is about to write, in the ONE
 * order every path uses: execution Threads first (sorted), then presentation
 * Threads (sorted).
 *
 * Terminalizing an Intervention appends an event, which writes the Thread row;
 * without a pre-lock a cancel that starts from the Run takes Run → Thread while
 * an answer takes Thread → Run — the deadlock PostgreSQL resolves by aborting
 * one transaction with 40P01.
 *
 * Two groups rather than one sorted set: every cancel and clear entry point in
 * this repository locks the Run's own Thread before it reaches this helper, so a
 * presentation Thread that happens to sort earlier would be acquired second and
 * invert against a concurrent answer. Grouping keeps those callers correct
 * unchanged, because the Thread a caller pre-locks is always an execution Thread
 * and a presentation Thread is only ever reached from here.
 *
 * Precondition: a presentation Thread is never the execution Thread of another
 * cross-Thread Intervention. RT-03 guarantees that — a Thread humans cannot
 * write to is not addressable as a presentation target.
 */
async function lockThreadGroups(
  tx: InterventionTx,
  executionThreadIds: Iterable<string | null | undefined>,
  presentationThreadIds: Iterable<string | null | undefined> = [],
): Promise<void> {
  const locked = new Set<string>();
  for (const group of [executionThreadIds, presentationThreadIds]) {
    const unique = [...new Set(group)].filter((threadId): threadId is string => Boolean(threadId));
    for (const threadId of unique.sort()) {
      if (locked.has(threadId)) continue;
      locked.add(threadId);
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
    }
  }
}

/** Lock one Intervention's execution Thread, then the Thread it is presented in. */
export async function lockInterventionThreads(
  tx: InterventionTx,
  executionThreadId: string | null | undefined,
  presentationThreadId?: string | null,
): Promise<void> {
  await lockThreadGroups(tx, [executionThreadId], [presentationThreadId]);
}

/**
 * Lock the Threads of these Runs plus the presentation Threads of their pending
 * Interventions. The execution group is taken first and on its own: a concurrent
 * pause or answer needs one of those locks to create or settle a row, so once
 * they are held the pending set read below cannot grow underneath us.
 */
export async function lockThreadsForRunSettling(
  tx: InterventionTx,
  runs: readonly { id: string; threadId: string }[],
): Promise<void> {
  if (runs.length === 0) return;
  await lockThreadGroups(
    tx,
    runs.map((run) => run.threadId),
  );
  if (!interventionStore(tx)) return;
  const runIds = [...new Set(runs.map((run) => run.id))];
  const pending = await tx.intervention.findMany({
    where: { runId: { in: runIds }, status: "pending" },
    select: { threadId: true },
  });
  await lockThreadGroups(
    tx,
    [],
    pending.map((row) => row.threadId),
  );
}

export async function insertPausedIntervention(
  tx: InterventionTx,
  input: {
    spaceId: string;
    /**
     * Execution/presentation pair resolved by `resolveInterventionThreads`, so
     * the row can only be anchored at a foreign Thread through the gated,
     * origin-validated path. `threadId` stays the presentation Thread: it is
     * what the snapshot projection and the submission authorization read.
     */
    threads: InterventionThreads;
    botId: string;
    runId: string;
    attemptId: string;
    messageId: string;
    blocks: MessageBlock[];
    waitStartedAt: Date;
  },
): Promise<{ id: string; blocks: MessageBlock[] }> {
  const store = interventionStore(tx);
  if (!store) throw new Error("Intervention store is not available");
  const asks = asksIn(input.blocks);
  if (asks.length !== 1) throw new Error("A waiting run accepts exactly one intervention");
  const ask = asks[0]!;
  const existing = await store.findFirst({
    where: { pendingRunKey: input.runId },
    select: { id: true },
  });
  if (existing) throw new Error("Run already has a pending intervention");
  let effectId: string | null = null;
  if (ask.approvalEffectId) {
    const effect = await tx.externalEffect.findFirst({
      where: { id: ask.approvalEffectId, runId: input.runId, spaceId: input.spaceId },
      select: { id: true },
    });
    if (!effect) throw new Error("Approval intervention requires its external effect");
    effectId = effect.id;
  }
  const id = randomUUID();
  const mode = inputModeOf(ask);
  const actions = whitelistedActions(ask.actions);
  const presentation = presentationFromAskBlock(ask);
  const createdAt = input.waitStartedAt;
  // A plan review carries its version binding instead of an external effect:
  // it authorizes a plan version's direction, never a tool call.
  const planReview: InterventionPlanReview | null = ask.planReview
    ? InterventionPlanReviewSchema.parse({ content: ask.planReview })
    : null;
  if (planReview && effectId) throw new Error("A plan review is not a tool approval");
  await store.create({
    data: {
      id,
      revision: 1,
      kind: planReview ? "plan_review" : effectId ? "approval" : "input",
      status: "pending",
      spaceId: input.spaceId,
      threadId: input.threads.presentationThreadId,
      runId: input.runId,
      attemptId: input.attemptId,
      botId: input.botId,
      messageId: input.messageId,
      pendingRunKey: input.runId,
      expiresAt: new Date(input.waitStartedAt.getTime() + INTERVENTION_WAIT_MS),
      inputMode: mode,
      inputPurpose: mode === "secret" ? (ask.purpose ?? null) : null,
      ...(actions ? { inputActions: actions } : {}),
      presentation,
      ...(planReview ? { planReview: planReview as object } : {}),
      effectId,
      createdAt,
    },
  });
  const blocks = input.blocks.map((block) =>
    block.kind === "ask" ? { ...block, interventionId: id } : block,
  );
  return { id, blocks };
}

/**
 * Append the `intervention.created` projection to the row's OWN Thread, which
 * is the presentation Thread: an origin-aware Intervention is created inside the
 * executing Run's transaction but has to surface where the user answers it.
 * Mirrors `emitInterventionResolved`, so both projections always land together.
 */
export async function emitInterventionCreated(
  tx: InterventionTx,
  interventionId: string,
): Promise<{ threadId: string; seq: number }> {
  const row = await tx.intervention.findUnique({ where: { id: interventionId } });
  if (!row) throw new Error("Intervention was not created");
  const effectStatus = await readEffectStatus(tx, row.effectId);
  const event = await appendInterventionEvent(tx, {
    spaceId: row.spaceId,
    threadId: row.threadId,
    botId: row.botId,
    runId: row.runId,
    type: "intervention.created",
    view: interventionView(row, effectStatus),
  });
  return { threadId: event.threadId, seq: event.seq };
}

/**
 * Rows created before the presentation column carried none. On the first
 * terminalization, synthesize the sanitized snapshot from the message's
 * pending Ask block so the terminal card survives a later refresh.
 */
async function backfillPresentation(
  tx: InterventionTx,
  row: InterventionRecord,
  callerPresentation?: InterventionPresentation,
): Promise<InterventionPresentation | undefined> {
  const parsed = InterventionPresentationSchema.safeParse(row.presentation);
  if (parsed.success) return parsed.data;
  // The answer path rewrites the Ask block to `answered` before settling the
  // row, so the message scan below cannot see it; that caller passes the
  // locked, validated Ask it already holds.
  if (callerPresentation) return callerPresentation;
  const message = await tx.message.findUnique({
    where: { id: row.messageId },
    select: { blocks: true },
  });
  for (const ask of pendingAskBlocks(message?.blocks)) {
    if (ask.interventionId && ask.interventionId !== row.id) continue;
    return presentationFromAskBlock(ask);
  }
  return undefined;
}

/**
 * Append the terminal projection for a settled row. Reads the current
 * ExternalEffect status, so callers that also expire or approve the Effect
 * must emit this AFTER that transition and still inside the same transaction:
 * the card's effect status then matches the projection clients store.
 */
export async function emitInterventionResolved(
  tx: InterventionTx,
  row: InterventionRecord,
): Promise<void> {
  const effectStatus = await readEffectStatus(tx, row.effectId);
  await appendInterventionEvent(tx, {
    spaceId: row.spaceId,
    threadId: row.threadId,
    botId: row.botId,
    runId: row.runId,
    type: "intervention.resolved",
    view: interventionView(row, effectStatus),
  });
}

async function transitionPending(
  tx: InterventionTx,
  row: InterventionRecord,
  status: "answered" | "expired" | "cancelled",
  patch: {
    resolvedByUserId?: string;
    decision?: "approved" | "denied";
    presentation?: InterventionPresentation;
  },
  options?: { emitEvent?: boolean },
): Promise<InterventionRecord | null> {
  const presentation = await backfillPresentation(tx, row, patch.presentation);
  const changed = await tx.intervention.updateManyAndReturn({
    where: { id: row.id, status: "pending" },
    data: {
      status,
      revision: { increment: 1 },
      pendingRunKey: null,
      resolvedAt: new Date(),
      ...(presentation ? { presentation } : {}),
      ...(patch.resolvedByUserId ? { resolvedByUserId: patch.resolvedByUserId } : {}),
      ...(patch.decision ? { decision: patch.decision } : {}),
    },
  });
  const next = changed[0];
  if (!next) return null;
  if (next.kind === "plan_review" && status !== "answered") {
    // The round cannot outlive its card: a Stop/Clear cancel or a wait timeout
    // settles the pending review round and the plan's review state with it.
    // (The answered path decides the round before settling, in the answer tx.)
    const { settleOrphanedPlanReview } = await import("./run-plans.js");
    await settleOrphanedPlanReview(tx, next.runId, status === "expired" ? "expired" : "cancelled");
  }
  if (options?.emitEvent !== false) await emitInterventionResolved(tx, next);
  return next;
}

async function latestAttemptId(tx: InterventionTx, runId: string): Promise<string> {
  const attempt = await tx.attempt.findFirst({
    where: { runId },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  return attempt?.id ?? "legacy";
}

function pendingAskBlocks(blocks: unknown): Array<Extract<MessageBlock, { kind: "ask" }>> {
  const parsed = MessageBlockSchema.array().safeParse(blocks);
  if (!parsed.success) return [];
  return asksIn(parsed.data).filter((ask) => ask.status !== "answered" && ask.status !== "expired");
}

async function createTerminalLegacy(
  tx: InterventionTx,
  input: {
    id: string;
    run: {
      id: string;
      spaceId: string;
      threadId: string;
      botId: string;
      waitStartedAt?: Date | null;
    };
    /** Anchors the audit row where the user answered; defaults to the Run. */
    presentationThreadId?: string;
    messageId: string;
    ask: Extract<MessageBlock, { kind: "ask" }>;
    status: "expired" | "cancelled" | "answered";
    resolvedByUserId?: string;
    decision?: "approved" | "denied";
  },
  options?: { emitEvent?: boolean },
): Promise<InterventionRecord> {
  const mode = inputModeOf(input.ask);
  const actions = whitelistedActions(input.ask.actions);
  const presentation = presentationFromAskBlock(input.ask);
  const now = new Date();
  const row = await tx.intervention.create({
    data: {
      id: input.id,
      revision: 1,
      kind: input.ask.approvalEffectId ? "approval" : "input",
      status: input.status,
      spaceId: input.run.spaceId,
      threadId: input.presentationThreadId ?? input.run.threadId,
      runId: input.run.id,
      attemptId: await latestAttemptId(tx, input.run.id),
      botId: input.run.botId,
      messageId: input.messageId,
      pendingRunKey: null,
      expiresAt: input.run.waitStartedAt
        ? new Date(input.run.waitStartedAt.getTime() + INTERVENTION_WAIT_MS)
        : null,
      resolvedAt: now,
      resolvedByUserId: input.resolvedByUserId,
      inputMode: mode,
      inputPurpose: mode === "secret" ? (input.ask.purpose ?? null) : null,
      ...(actions ? { inputActions: actions } : {}),
      presentation,
      effectId: input.ask.approvalEffectId,
      decision: input.decision,
      createdAt: input.run.waitStartedAt ?? now,
    },
  });
  if (options?.emitEvent !== false) await emitInterventionResolved(tx, row);
  return row;
}

async function terminalizeMissing(
  tx: InterventionTx,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    waitStartedAt?: Date | null;
  },
  status: "expired" | "cancelled",
  options?: { deferEvents?: boolean },
): Promise<InterventionRecord[]> {
  const messages = await tx.message.findMany({
    where: { threadId: run.threadId, runId: run.id, role: "bot" },
    select: { id: true, blocks: true },
  });
  const settled: InterventionRecord[] = [];
  for (const message of messages) {
    for (const ask of pendingAskBlocks(message.blocks)) {
      const id = ask.interventionId ?? legacyInterventionId(message.id);
      const existing = await tx.intervention.findUnique({ where: { id } });
      if (existing?.status === "pending") {
        const changed = await transitionPending(
          tx,
          existing,
          status,
          {},
          options?.deferEvents ? { emitEvent: false } : undefined,
        );
        if (changed) settled.push(changed);
        continue;
      }
      if (existing) continue;
      const created = await createTerminalLegacy(
        tx,
        { id, run, messageId: message.id, ask, status },
        options?.deferEvents ? { emitEvent: false } : undefined,
      );
      settled.push(created);
    }
  }
  return settled;
}

export async function settleAnsweredIntervention(
  tx: InterventionTx,
  input: {
    run: {
      id: string;
      spaceId: string;
      threadId: string;
      botId: string;
      waitStartedAt?: Date | null;
    };
    /** Thread the user answered from; the Run's own Thread when omitted. */
    presentationThreadId?: string;
    messageId: string;
    ask: Extract<MessageBlock, { kind: "ask" }>;
    resolvedByUserId: string;
    decision?: "approved" | "denied";
    clientSubmissionId?: string;
  },
): Promise<void> {
  if (!interventionStore(tx)) return;
  await lockInterventionThreads(tx, input.run.threadId, input.presentationThreadId);
  const id = input.ask.interventionId ?? legacyInterventionId(input.messageId);
  const existing = await tx.intervention.findUnique({ where: { id } });
  if (existing && existing.status !== "pending") return;
  if (existing) {
    const changed = await transitionPending(tx, existing, "answered", {
      resolvedByUserId: input.resolvedByUserId,
      ...(input.decision ? { decision: input.decision } : {}),
      // The caller's Ask block is the authoritative display source: the
      // answer path rewrites the message before settling this row.
      presentation: presentationFromAskBlock(input.ask),
    });
    if (!changed) return;
  } else {
    await createTerminalLegacy(tx, {
      id,
      run: input.run,
      ...(input.presentationThreadId ? { presentationThreadId: input.presentationThreadId } : {}),
      messageId: input.messageId,
      ask: input.ask,
      status: "answered",
      resolvedByUserId: input.resolvedByUserId,
      decision: input.decision,
    });
  }
  if (!input.clientSubmissionId) return;
  await tx.interventionSubmission.create({
    data: { interventionId: id, clientSubmissionId: input.clientSubmissionId },
  });
}

export async function cancelPendingInterventions(
  tx: InterventionTx,
  runIds: readonly string[],
  _cancelledAt: Date,
  match?: Prisma.RunWhereInput,
): Promise<void> {
  if (!interventionStore(tx) || runIds.length === 0) return;
  const runs = await tx.run.findMany({
    where: {
      AND: [
        { id: { in: [...runIds] }, status: { in: [...ACTIVE_RUN_STATUSES] } },
        ...(match ? [match] : []),
      ],
    },
    select: { id: true, spaceId: true, threadId: true, botId: true, waitStartedAt: true },
  });
  await lockThreadsForRunSettling(tx, runs);
  const ordered = [...runs].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  for (const run of ordered) {
    await lockRun(tx, run.id);
    const fresh = await tx.run.findUnique({ where: { id: run.id }, select: { status: true } });
    if (!fresh || !(ACTIVE_RUN_STATUSES as readonly string[]).includes(fresh.status)) continue;
    const pending = await tx.intervention.findMany({ where: { runId: run.id, status: "pending" } });
    if (pending.length === 0) {
      await terminalizeMissing(tx, run, "cancelled");
      continue;
    }
    for (const row of pending) await transitionPending(tx, row, "cancelled", {});
  }
}

/**
 * Expire the pending rows of a waiting Run and return every settled row.
 * With `deferEvents` the `intervention.resolved` projection is NOT appended
 * here: the timeout path expires the ExternalEffect after this call and must
 * emit once, with the post-transition effect status. The row writes still
 * happen under the Intervention lock before the Effect write, preserving the
 * documented Thread → Run → Intervention → Effect → Message → Event order.
 */
export async function expirePendingIntervention(
  tx: InterventionTx,
  run: { id: string; spaceId: string; threadId: string; botId: string; waitStartedAt: Date | null },
  options?: { deferEvents?: boolean },
): Promise<InterventionRecord[]> {
  if (!interventionStore(tx)) return [];
  await lockThreadsForRunSettling(tx, [run]);
  await lockRun(tx, run.id);
  const pending = await tx.intervention.findMany({ where: { runId: run.id, status: "pending" } });
  if (pending.length === 0) return terminalizeMissing(tx, run, "expired", options);
  const settled: InterventionRecord[] = [];
  for (const row of pending) {
    await lockIntervention(tx, row.id);
    const changed = await transitionPending(
      tx,
      row,
      "expired",
      {},
      options?.deferEvents ? { emitEvent: false } : undefined,
    );
    if (changed) settled.push(changed);
  }
  return settled;
}

type OrdinaryTarget = { runId: string; messageId: string; interventionId: string };

/**
 * Ordinary text targets across the considered waiting Runs: Intervention
 * rows plus legacy asks with no row (upgrade window). Both sources merge
 * before the caller applies its exactly-one rule, so one new text row and
 * one still-waiting legacy text ask are two candidates — a refusal, never a
 * guess at the composer/inbound/voice target.
 */
export async function findOrdinaryTextAsks(
  tx: InterventionTx,
  input: { threadId: string; runIds: readonly string[] },
): Promise<OrdinaryTarget[]> {
  if (input.runIds.length === 0) return [];
  const store = interventionStore(tx);
  const pendingRowIds = new Set<string>();
  const rowTargets: OrdinaryTarget[] = [];
  if (store) {
    const pendingRows = await store.findMany({
      where: {
        threadId: input.threadId,
        runId: { in: [...input.runIds] },
        status: "pending",
      },
      select: { id: true, runId: true, messageId: true, kind: true, inputMode: true },
    });
    for (const row of pendingRows) {
      pendingRowIds.add(row.id);
      if (row.kind === "input" && row.inputMode === "text") {
        rowTargets.push({ runId: row.runId, messageId: row.messageId, interventionId: row.id });
      }
    }
    // No new-format ordinary text row, but another pending kind does: the
    // card path governs this thread and free text must not answer at all.
    if (rowTargets.length === 0 && pendingRows.length > 0) return [];
  }
  const messages = await tx.message.findMany({
    where: { threadId: input.threadId, role: "bot", runId: { in: [...input.runIds] } },
    orderBy: { seq: "asc" },
    select: { id: true, runId: true, blocks: true },
  });
  const found: OrdinaryTarget[] = [...rowTargets];
  for (const message of messages) {
    const runId = message.runId ?? (input.runIds.length === 1 ? input.runIds[0] : null);
    if (!runId || !input.runIds.includes(runId)) continue;
    const pending = pendingAskBlocks(message.blocks);
    for (const ask of pending) {
      if (ask.interventionId && pendingRowIds.has(ask.interventionId)) continue;
      if (isApprovalAskBlock(ask) || isSecretAskBlock(ask) || ask.actions?.length) continue;
      found.push({
        runId,
        messageId: message.id,
        interventionId: ask.interventionId ?? legacyInterventionId(message.id),
      });
    }
  }
  return found;
}

/**
 * Authoritative Intervention projection for a thread snapshot.
 * Returns every pending Intervention of the thread, plus terminal rows in a
 * bounded window: runs inside `recentRunIds` (the snapshot's recent-terminal
 * Run list) and rows whose source message is on the current message page.
 * Never loads the whole thread history. Pending asks that predate the table
 * are synthesized from the Ask blocks of the current page without backfill.
 */
export async function loadInterventionViews(
  tx: InterventionTx,
  threadId: string,
  messages: readonly { id: string; runId?: string | null; blocks: unknown }[],
  recentRunIds: readonly string[] = [],
): Promise<InterventionView[]> {
  const store = interventionStore(tx);
  const rows = store ? await loadSnapshotRows(tx, store, threadId, messages, recentRunIds) : [];
  const effectIds = rows.map((row) => row.effectId).filter((id): id is string => Boolean(id));
  const effects =
    effectIds.length > 0
      ? await tx.externalEffect.findMany({
          where: { id: { in: effectIds } },
          select: { id: true, status: true },
        })
      : [];
  const effectStatus = new Map(effects.map((effect) => [effect.id, effect.status]));
  const views = rows.map((row) =>
    interventionView(row, row.effectId ? effectStatus.get(row.effectId) : undefined),
  );
  const covered = new Set(views.map((view) => view.messageId));
  for (const message of messages) {
    if (!message.runId || covered.has(message.id)) continue;
    for (const ask of pendingAskBlocks(message.blocks)) {
      if (ask.interventionId && views.some((view) => view.id === ask.interventionId)) continue;
      const run = await tx.run.findUnique({
        where: { id: message.runId },
        select: {
          id: true,
          spaceId: true,
          threadId: true,
          botId: true,
          waitStartedAt: true,
          status: true,
        },
      });
      if (!run || run.status !== "waiting_input") continue;
      const mode = inputModeOf(ask);
      const actions = whitelistedActions(ask.actions);
      const effect = ask.approvalEffectId ? effectStatus.get(ask.approvalEffectId) : undefined;
      let liveEffect = effect;
      if (ask.approvalEffectId && !liveEffect) {
        liveEffect = await readEffectStatus(tx, ask.approvalEffectId);
      }
      views.push({
        id: ask.interventionId ?? legacyInterventionId(message.id),
        revision: 1,
        kind: ask.approvalEffectId ? "approval" : "input",
        status: "pending",
        spaceId: run.spaceId,
        threadId: run.threadId,
        runId: run.id,
        attemptId: "legacy",
        botId: run.botId,
        messageId: message.id,
        createdAt: (run.waitStartedAt ?? new Date(0)).toISOString(),
        ...(run.waitStartedAt
          ? {
              expiresAt: new Date(run.waitStartedAt.getTime() + INTERVENTION_WAIT_MS).toISOString(),
            }
          : {}),
        requestingActor: { botId: run.botId },
        ...(!ask.approvalEffectId && mode
          ? {
              input: {
                mode,
                ...(mode === "secret" &&
                (ask.purpose === "otp" || ask.purpose === "password" || ask.purpose === "api_key")
                  ? { purpose: ask.purpose }
                  : {}),
                ...(actions ? { actions } : {}),
              },
            }
          : {}),
        ...(ask.approvalEffectId
          ? {
              approval: {
                effectId: ask.approvalEffectId,
                effectStatus: liveEffect || "unknown",
                ...(actions ? { actions } : {}),
              },
            }
          : {}),
        presentation: presentationFromAskBlock(ask),
      });
      covered.add(message.id);
    }
  }
  return views;
}

/**
 * Pending rows plus the bounded terminal window (recent Runs of the snapshot
 * or the current message page). Never an unbounded thread-history read.
 */
async function loadSnapshotRows(
  tx: InterventionTx,
  store: NonNullable<ReturnType<typeof interventionStore>>,
  threadId: string,
  messages: readonly { id: string }[],
  recentRunIds: readonly string[],
): Promise<InterventionRecord[]> {
  const pending = await store.findMany({
    where: { threadId, status: "pending" },
    orderBy: { createdAt: "asc" },
  });
  const messageIds = messages.map((message) => message.id);
  const or: Prisma.InterventionWhereInput["OR"] = [];
  if (recentRunIds.length > 0) or.push({ runId: { in: [...recentRunIds] } });
  if (messageIds.length > 0) or.push({ messageId: { in: messageIds } });
  if (or.length === 0) return [...pending];
  const terminal = await store.findMany({
    where: { threadId, status: { not: "pending" }, OR: or },
    orderBy: { createdAt: "asc" },
  });
  return [...pending, ...terminal].sort((left, right) =>
    left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0,
  );
}

export type ResolveInterventionOutcome =
  | {
      outcome: "accepted" | "already_handled";
      intervention: InterventionView;
      resume: boolean;
      cancelledRunId?: string;
      seq: number;
      /** Thread the execution-side events were appended to. */
      threadId: string;
      /**
       * Present only when the decision was submitted away from the executing
       * Thread. The projection event advanced this Thread too, so both have to
       * be published or the answering user never sees their own card settle.
       */
      presentationThreadId?: string;
      presentationSeq?: number;
      applied: boolean;
    }
  | { outcome: "rejected"; reason: InterventionRejected["reason"] };

export function legacyMessageId(interventionId: string): string | null {
  const prefix = "legacy_";
  if (!interventionId.startsWith(prefix)) return null;
  const messageId = interventionId.slice(prefix.length);
  return messageId.length > 0 ? messageId : null;
}

async function viewFor(tx: InterventionTx, row: InterventionRecord): Promise<InterventionView> {
  return interventionView(row, await readEffectStatus(tx, row.effectId));
}

async function threadHeadSeq(tx: InterventionTx, threadId: string): Promise<number> {
  const head = await tx.event.findFirst({
    where: { threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return head?.seq ?? 0;
}

/**
 * The bound Attempt must still be the Run's current waiting one. Resuming opens a
 * newer Attempt and `promoteRun` fails every older active Attempt, so a decision
 * arriving for a superseded Attempt describes an execution that no longer exists
 * and must not resume anything — the parameters the user approved are gone.
 */
async function boundAttemptIsCurrent(
  tx: InterventionTx,
  row: InterventionRecord,
): Promise<boolean> {
  // Rows that predate the Attempt table carry no binding to compare against.
  if (row.attemptId === "legacy") return true;
  const bound = await tx.attempt.findFirst({
    where: { id: row.attemptId, runId: row.runId },
    select: { fence: true, status: true },
  });
  if (bound?.status !== "waiting_input") return false;
  const newer = await tx.attempt.count({
    where: { runId: row.runId, fence: { gt: bound.fence } },
  });
  return newer === 0;
}

export async function resolveInterventionInTransaction(
  tx: InterventionTx,
  input: {
    interventionId: string;
    spaceId: string;
    answeredByUserId: string;
    answer: string;
    username?: string;
    clientSubmissionId: string;
    /**
     * Thread the submission is addressed at. This is the Intervention row's own
     * anchor, i.e. where the user sees the card — NOT necessarily where the Run
     * executes.
     */
    threadId: string;
    /** Thread of the bound Run, derived server-side from it. Never a client value. */
    executionThreadId: string;
    runId: string;
  },
  commit: (
    tx: InterventionTx,
  ) => Promise<{ threadId: string; seq: number; cancelledRunId?: string } | null>,
): Promise<ResolveInterventionOutcome> {
  await lockInterventionThreads(tx, input.executionThreadId, input.threadId);
  await lockRun(tx, input.runId);
  let row = await tx.intervention.findUnique({ where: { id: input.interventionId } });
  if (row) await lockIntervention(tx, row.id);
  row = await tx.intervention.findUnique({ where: { id: input.interventionId } });
  if (
    row &&
    (row.spaceId !== input.spaceId || row.threadId !== input.threadId || row.runId !== input.runId)
  ) {
    return { outcome: "rejected", reason: "not_found" };
  }
  if (row && row.status !== "pending") {
    const submission = await tx.interventionSubmission.findUnique({
      where: {
        interventionId_clientSubmissionId: {
          interventionId: row.id,
          clientSubmissionId: input.clientSubmissionId,
        },
      },
      select: { id: true },
    });
    const intervention = await viewFor(tx, row);
    if (submission) {
      return {
        outcome: "accepted",
        intervention,
        resume: false,
        seq: 0,
        threadId: row.threadId,
        applied: false,
      };
    }
    return {
      outcome: "already_handled",
      intervention,
      resume: false,
      seq: 0,
      threadId: row.threadId,
      applied: false,
    };
  }
  if (row && !(await boundAttemptIsCurrent(tx, row))) {
    return { outcome: "rejected", reason: "conflict" };
  }
  const committed = await commit(tx);
  if (!committed) {
    const run = await tx.run.findUnique({
      where: { id: input.runId },
      select: { userId: true },
    });
    const messageId = row?.messageId ?? legacyMessageId(input.interventionId);
    const message = messageId
      ? await tx.message.findFirst({
          where: { id: messageId, threadId: input.executionThreadId },
          select: { blocks: true },
        })
      : null;
    const ask = pendingAskBlocks(message?.blocks)[0];
    const ownerOnly =
      Boolean(ask && isApprovalAskBlock(ask)) ||
      Boolean(ask && isSecretAskBlock(ask) && ask.credential);
    if (ownerOnly && run && run.userId !== input.answeredByUserId) {
      return { outcome: "rejected", reason: "forbidden" };
    }
    return { outcome: "rejected", reason: "conflict" };
  }
  const fresh = await tx.intervention.findUnique({ where: { id: input.interventionId } });
  const legacyId = row?.id ?? input.interventionId;
  const settled = fresh ?? (await tx.intervention.findUnique({ where: { id: legacyId } }));
  if (!settled) return { outcome: "rejected", reason: "conflict" };
  const crossThread = input.threadId !== input.executionThreadId;
  return {
    outcome: "accepted",
    intervention: await viewFor(tx, settled),
    resume: !committed.cancelledRunId,
    ...(committed.cancelledRunId ? { cancelledRunId: committed.cancelledRunId } : {}),
    seq: committed.seq,
    threadId: committed.threadId,
    ...(crossThread
      ? {
          presentationThreadId: settled.threadId,
          presentationSeq: await threadHeadSeq(tx, settled.threadId),
        }
      : {}),
    applied: true,
  };
}
