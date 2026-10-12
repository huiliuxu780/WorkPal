import { createHash, randomUUID } from "node:crypto";
import {
  type InterventionView,
  legacyInterventionId,
  type MessageBlock,
  MessageBlock as MessageBlockSchema,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, isApprovalAskBlock, isSecretAskBlock } from "@rakazo/core";
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
  return blocks.filter((block): block is Extract<MessageBlock, { kind: "ask" }> => block.kind === "ask");
}

function whitelistedActions(
  actions: Array<{ id: string; label: string }> | undefined,
): Array<{ id: string; label: string }> | undefined {
  if (!actions?.length) return undefined;
  return actions.map((action) => ({ id: action.id, label: action.label }));
}

function inputModeOf(ask: Extract<MessageBlock, { kind: "ask" }>): "text" | "choice" | "secret" | null {
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

export function interventionView(
  row: InterventionRecord,
  effectStatus?: string,
): InterventionView {
  const actions = actionList(row.inputActions);
  const decision = row.decision === "approved" || row.decision === "denied" ? row.decision : undefined;
  const mode =
    row.inputMode === "text" || row.inputMode === "choice" || row.inputMode === "secret"
      ? row.inputMode
      : undefined;
  const purpose =
    row.inputPurpose === "otp" || row.inputPurpose === "password" || row.inputPurpose === "api_key"
      ? row.inputPurpose
      : undefined;
  let input: InterventionView["input"] = undefined;
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
    kind: row.kind === "approval" ? "approval" : "input",
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

export async function insertPausedIntervention(
  tx: InterventionTx,
  input: {
    spaceId: string;
    threadId: string;
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
  const createdAt = input.waitStartedAt;
  await store.create({
    data: {
      id,
      revision: 1,
      kind: effectId ? "approval" : "input",
      status: "pending",
      spaceId: input.spaceId,
      threadId: input.threadId,
      runId: input.runId,
      attemptId: input.attemptId,
      botId: input.botId,
      messageId: input.messageId,
      pendingRunKey: input.runId,
      expiresAt: new Date(input.waitStartedAt.getTime() + INTERVENTION_WAIT_MS),
      inputMode: mode,
      inputPurpose: mode === "secret" ? (ask.purpose ?? null) : null,
      ...(actions ? { inputActions: actions } : {}),
      effectId,
      createdAt,
    },
  });
  const blocks = input.blocks.map((block) =>
    block.kind === "ask" ? { ...block, interventionId: id } : block,
  );
  return { id, blocks };
}

export async function emitInterventionCreated(
  tx: InterventionTx,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    runId: string;
    interventionId: string;
  },
): Promise<{ threadId: string; seq: number }> {
  const row = await tx.intervention.findUnique({ where: { id: input.interventionId } });
  if (!row) throw new Error("Intervention was not created");
  const effectStatus = await readEffectStatus(tx, row.effectId);
  const event = await appendInterventionEvent(tx, {
    ...input,
    type: "intervention.created",
    view: interventionView(row, effectStatus),
  });
  return { threadId: event.threadId, seq: event.seq };
}

async function transitionPending(
  tx: InterventionTx,
  row: InterventionRecord,
  status: "answered" | "expired" | "cancelled",
  patch: { resolvedByUserId?: string; decision?: "approved" | "denied" },
): Promise<InterventionRecord | null> {
  const changed = await tx.intervention.updateManyAndReturn({
    where: { id: row.id, status: "pending" },
    data: {
      status,
      revision: { increment: 1 },
      pendingRunKey: null,
      resolvedAt: new Date(),
      ...(patch.resolvedByUserId ? { resolvedByUserId: patch.resolvedByUserId } : {}),
      ...(patch.decision ? { decision: patch.decision } : {}),
    },
  });
  const next = changed[0];
  if (!next) return null;
  const effectStatus = await readEffectStatus(tx, next.effectId);
  await appendInterventionEvent(tx, {
    spaceId: next.spaceId,
    threadId: next.threadId,
    botId: next.botId,
    runId: next.runId,
    type: "intervention.resolved",
    view: interventionView(next, effectStatus),
  });
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
    run: { id: string; spaceId: string; threadId: string; botId: string; waitStartedAt?: Date | null };
    messageId: string;
    ask: Extract<MessageBlock, { kind: "ask" }>;
    status: "expired" | "cancelled" | "answered";
    resolvedByUserId?: string;
    decision?: "approved" | "denied";
  },
): Promise<InterventionRecord> {
  const mode = inputModeOf(input.ask);
  const actions = whitelistedActions(input.ask.actions);
  const now = new Date();
  const row = await tx.intervention.create({
    data: {
      id: input.id,
      revision: 1,
      kind: input.ask.approvalEffectId ? "approval" : "input",
      status: input.status,
      spaceId: input.run.spaceId,
      threadId: input.run.threadId,
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
      effectId: input.ask.approvalEffectId,
      decision: input.decision,
      createdAt: input.run.waitStartedAt ?? now,
    },
  });
  const effectStatus = await readEffectStatus(tx, row.effectId);
  await appendInterventionEvent(tx, {
    spaceId: row.spaceId,
    threadId: row.threadId,
    botId: row.botId,
    runId: row.runId,
    type: "intervention.resolved",
    view: interventionView(row, effectStatus),
  });
  return row;
}

async function terminalizeMissing(
  tx: InterventionTx,
  run: { id: string; spaceId: string; threadId: string; botId: string; waitStartedAt?: Date | null },
  status: "expired" | "cancelled",
) {
  const messages = await tx.message.findMany({
    where: { threadId: run.threadId, runId: run.id, role: "bot" },
    select: { id: true, blocks: true },
  });
  for (const message of messages) {
    for (const ask of pendingAskBlocks(message.blocks)) {
      const id = ask.interventionId ?? legacyInterventionId(message.id);
      const existing = await tx.intervention.findUnique({ where: { id } });
      if (existing?.status === "pending") {
        await transitionPending(tx, existing, status, {});
        continue;
      }
      if (existing) continue;
      await createTerminalLegacy(tx, { id, run, messageId: message.id, ask, status });
    }
  }
}

export async function settleAnsweredIntervention(
  tx: InterventionTx,
  input: {
    run: { id: string; spaceId: string; threadId: string; botId: string; waitStartedAt?: Date | null };
    messageId: string;
    ask: Extract<MessageBlock, { kind: "ask" }>;
    resolvedByUserId: string;
    decision?: "approved" | "denied";
    clientSubmissionId?: string;
  },
): Promise<void> {
  if (!interventionStore(tx)) return;
  const id = input.ask.interventionId ?? legacyInterventionId(input.messageId);
  const existing = await tx.intervention.findUnique({ where: { id } });
  if (existing && existing.status !== "pending") return;
  if (existing) {
    const changed = await transitionPending(tx, existing, "answered", {
      resolvedByUserId: input.resolvedByUserId,
      ...(input.decision ? { decision: input.decision } : {}),
    });
    if (!changed) return;
  } else {
    await createTerminalLegacy(tx, {
      id,
      run: input.run,
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
  const ordered = [...runs].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
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

export async function expirePendingIntervention(
  tx: InterventionTx,
  run: { id: string; spaceId: string; threadId: string; botId: string; waitStartedAt: Date | null },
): Promise<void> {
  if (!interventionStore(tx)) return;
  await lockRun(tx, run.id);
  const pending = await tx.intervention.findMany({ where: { runId: run.id, status: "pending" } });
  if (pending.length === 0) {
    await terminalizeMissing(tx, run, "expired");
    return;
  }
  for (const row of pending) {
    await lockIntervention(tx, row.id);
    await transitionPending(tx, row, "expired", {});
  }
}

type OrdinaryTarget = { runId: string; messageId: string; interventionId: string };

export async function findOrdinaryTextAsks(
  tx: InterventionTx,
  input: { threadId: string; runIds: readonly string[] },
): Promise<OrdinaryTarget[]> {
  if (input.runIds.length === 0) return [];
  const store = interventionStore(tx);
  if (store) {
    const rows = await store.findMany({
      where: {
        threadId: input.threadId,
        runId: { in: [...input.runIds] },
        status: "pending",
        kind: "input",
        inputMode: "text",
      },
      select: { id: true, runId: true, messageId: true },
    });
    if (rows.length > 0) {
      return rows.map((row) => ({
        runId: row.runId,
        messageId: row.messageId,
        interventionId: row.id,
      }));
    }
    const otherPending = await store.findFirst({
      where: { threadId: input.threadId, runId: { in: [...input.runIds] }, status: "pending" },
      select: { id: true },
    });
    if (otherPending) return [];
  }
  const messages = await tx.message.findMany({
    where: { threadId: input.threadId, role: "bot", runId: { in: [...input.runIds] } },
    orderBy: { seq: "asc" },
    select: { id: true, runId: true, blocks: true },
  });
  const found: OrdinaryTarget[] = [];
  for (const message of messages) {
    const runId = message.runId ?? (input.runIds.length === 1 ? input.runIds[0] : null);
    if (!runId || !input.runIds.includes(runId)) continue;
    const pending = pendingAskBlocks(message.blocks);
    for (const ask of pending) {
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

export async function loadInterventionViews(
  tx: InterventionTx,
  threadId: string,
  messages: readonly { id: string; runId?: string | null; blocks: unknown }[],
): Promise<InterventionView[]> {
  const store = interventionStore(tx);
  const rows = store
    ? await store.findMany({ where: { threadId, status: "pending" }, orderBy: { createdAt: "asc" } })
    : [];
  const effectIds = rows.map((row) => row.effectId).filter((id): id is string => Boolean(id));
  const effects =
    effectIds.length > 0
      ? await tx.externalEffect.findMany({
          where: { id: { in: effectIds } },
          select: { id: true, status: true },
        })
      : [];
  const effectStatus = new Map(effects.map((effect) => [effect.id, effect.status]));
  const views = rows.map((row) => interventionView(row, row.effectId ? effectStatus.get(row.effectId) : undefined));
  const covered = new Set(views.map((view) => view.messageId));
  for (const message of messages) {
    if (!message.runId || covered.has(message.id)) continue;
    for (const ask of pendingAskBlocks(message.blocks)) {
      if (ask.interventionId && views.some((view) => view.id === ask.interventionId)) continue;
      const run = await tx.run.findUnique({
        where: { id: message.runId },
        select: { id: true, spaceId: true, threadId: true, botId: true, waitStartedAt: true, status: true },
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
          ? { expiresAt: new Date(run.waitStartedAt.getTime() + INTERVENTION_WAIT_MS).toISOString() }
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
      });
      covered.add(message.id);
    }
  }
  return views;
}

export type ResolveInterventionOutcome =
  | {
      outcome: "accepted" | "already_handled";
      intervention: InterventionView;
      resume: boolean;
      cancelledRunId?: string;
      seq: number;
      threadId: string;
      applied: boolean;
    }
  | { outcome: "rejected"; reason: InterventionRejected["reason"] };

export function legacyMessageId(interventionId: string): string | null {
  const prefix = "legacy_";
  if (!interventionId.startsWith(prefix)) return null;
  const messageId = interventionId.slice(prefix.length);
  return messageId.length > 0 ? messageId : null;
}

async function viewFor(
  tx: InterventionTx,
  row: InterventionRecord,
): Promise<InterventionView> {
  return interventionView(row, await readEffectStatus(tx, row.effectId));
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
    threadId: string;
    runId: string;
  },
  commit: (tx: InterventionTx) => Promise<{ threadId: string; seq: number; cancelledRunId?: string } | null>,
): Promise<ResolveInterventionOutcome> {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
  await lockRun(tx, input.runId);
  let row = await tx.intervention.findUnique({ where: { id: input.interventionId } });
  if (row) await lockIntervention(tx, row.id);
  row = await tx.intervention.findUnique({ where: { id: input.interventionId } });
  if (row && (row.spaceId !== input.spaceId || row.threadId !== input.threadId || row.runId !== input.runId)) {
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
  const committed = await commit(tx);
  if (!committed) {
    const run = await tx.run.findUnique({
      where: { id: input.runId },
      select: { userId: true },
    });
    const messageId = row?.messageId ?? legacyMessageId(input.interventionId);
    const message = messageId
      ? await tx.message.findFirst({
          where: { id: messageId, threadId: input.threadId },
          select: { blocks: true },
        })
      : null;
    const ask = pendingAskBlocks(message?.blocks)[0];
    const ownerOnly =
      Boolean(ask && isApprovalAskBlock(ask)) || Boolean(ask && isSecretAskBlock(ask) && ask.credential);
    if (ownerOnly && run && run.userId !== input.answeredByUserId) {
      return { outcome: "rejected", reason: "forbidden" };
    }
    return { outcome: "rejected", reason: "conflict" };
  }
  const fresh = await tx.intervention.findUnique({ where: { id: input.interventionId } });
  const legacyId = row?.id ?? input.interventionId;
  const settled = fresh ?? (await tx.intervention.findUnique({ where: { id: legacyId } }));
  if (!settled) return { outcome: "rejected", reason: "conflict" };
  return {
    outcome: "accepted",
    intervention: await viewFor(tx, settled),
    resume: !committed.cancelledRunId,
    ...(committed.cancelledRunId ? { cancelledRunId: committed.cancelledRunId } : {}),
    seq: committed.seq,
    threadId: committed.threadId,
    applied: true,
  };
}
