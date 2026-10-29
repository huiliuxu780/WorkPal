import { randomUUID } from "node:crypto";
import type {
  MessageBlock,
  RunInstructionRef,
  TaskAmendmentApplication,
  TaskAmendmentSource,
  TaskInstructionAmendment,
  TaskInstructionEnvelope,
  TaskInstructionRun,
  TaskInstructionView,
} from "@rakazo/contracts";
import {
  MessageBlock as MessageBlockSchema,
  RunStatus,
  RunTrigger,
  TaskAmendmentApplicationSchema,
  TaskInstructionEnvelopeSchema,
  TaskInstructionViewSchema,
} from "@rakazo/contracts";
import { type AmendmentTargetFact, pickExecutionResult } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { withTransactionRetry } from "./transaction-retry.js";

export class TaskAmendmentRejected extends Error {
  readonly reason: "not_found" | "invalid" | "conflict";

  constructor(reason: TaskAmendmentRejected["reason"], message: string = reason) {
    super(message);
    this.name = "TaskAmendmentRejected";
    this.reason = reason;
  }
}

/**
 * The Task aggregate says more revisions exist than the readable instruction
 * log can supply. This happens when a Thread clear removed the amendment
 * Messages/Events, and it must fail closed: never execute a truncated envelope.
 */
export class TaskInstructionIntegrityError extends Error {
  readonly taskId: string;
  readonly revision: number;
  readonly amendmentCount: number;

  constructor(taskId: string, revision: number, amendmentCount: number) {
    super(
      `Task instruction envelope ${taskId} is incomplete: revision ${revision} has ${amendmentCount} amendments`,
    );
    this.name = "TaskInstructionIntegrityError";
    this.taskId = taskId;
    this.revision = revision;
    this.amendmentCount = amendmentCount;
  }
}

export interface AppendTaskAmendmentInput {
  spaceId: string;
  threadId: string;
  actorUserId: string;
  targetTaskId: string;
  /** Required for explicit amendments; ask/choice answers derive it from the Message. */
  content?: string;
  /** Idempotency identity for explicit amendments. Message.clientNonce is unique per Thread. */
  clientNonce?: string;
  /** Append-only user Message carrying the amendment body. */
  messageId?: string;
  source?: TaskAmendmentSource;
  /**
   * Explicit user entries require Task ownership. Internal answer paths already
   * authorized the Run and preserve the existing group-answer behaviour.
   */
  requireTaskOwner?: boolean;
}

export interface AppendTaskAmendmentResult {
  envelope: TaskInstructionEnvelope;
  ref: RunInstructionRef;
  messageId: string;
  seq: number;
  eventSeq: number;
  replayed: boolean;
}

export interface ApplyTaskAmendmentResult extends AppendTaskAmendmentResult {
  application: TaskAmendmentApplication;
}

export type TaskAmendmentDecision =
  | TaskAmendmentApplication
  | { kind: "conflict"; reason: string }
  | { kind: "not_found" };

export interface ReadTaskInstructionInput {
  taskId: string;
  spaceId?: string;
  threadId?: string;
  /** Read the envelope as it existed at this revision; defaults to the current aggregate. */
  atRevision?: number;
}

export interface ReadTaskInstructionsForRunInput {
  runId: string;
  leaseOwner: string;
  leaseFence: number;
}

export interface RunTaskInstructions {
  envelope: TaskInstructionEnvelope;
  ref: RunInstructionRef;
}

type TaskRow = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  prompt: string;
  revision: number;
  status: string;
};

type TaskRunRow = {
  id: string;
  spaceId: string;
  botId: string;
  threadId: string;
  taskId: string;
  userId: string;
  status: string;
  trigger: string;
  orchestration: Prisma.JsonValue | null;
  sourceMessageId: string | null;
  routineId: string | null;
  consumedRevision: number | null;
  retryOfRunId: string | null;
  followUpOfRunId: string | null;
  createdAt: Date;
};

type MessageRow = {
  id: string;
  role: string;
  blocks: unknown;
};

type ResolvedMessageRow = MessageRow & {
  originKind: string;
  authorUserId: string | null;
};

type ResolvedAmendmentMessage = { message: ResolvedMessageRow; created: boolean };

const TASK_SELECT = {
  id: true,
  spaceId: true,
  threadId: true,
  botId: true,
  userId: true,
  prompt: true,
  revision: true,
  status: true,
} as const;

const TASK_RUN_SELECT = {
  id: true,
  spaceId: true,
  botId: true,
  threadId: true,
  taskId: true,
  userId: true,
  status: true,
  trigger: true,
  orchestration: true,
  sourceMessageId: true,
  routineId: true,
  consumedRevision: true,
  retryOfRunId: true,
  followUpOfRunId: true,
  createdAt: true,
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseBlocks(value: unknown): MessageBlock[] | null {
  const parsed = MessageBlockSchema.array().safeParse(value);
  return parsed.success ? parsed.data : null;
}

function userMessageText(blocks: readonly MessageBlock[]): string {
  return blocks
    .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function amendmentContent(message: MessageRow): string {
  const blocks = parseBlocks(message.blocks);
  if (!blocks) throw new TaskAmendmentRejected("invalid", "The amendment Message has no blocks");
  if (message.role !== "user") {
    throw new TaskAmendmentRejected("invalid", "An amendment must reference a user Message");
  }
  return userMessageText(blocks);
}

async function lockThread(tx: Prisma.TransactionClient, threadId: string): Promise<void> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE
  `;
  if (locked.length === 0) throw new TaskAmendmentRejected("not_found");
}

async function scopedTask(
  tx: Prisma.TransactionClient,
  input: { targetTaskId: string; spaceId: string; threadId: string },
): Promise<TaskRow> {
  const candidate = await tx.task.findFirst({
    where: {
      id: input.targetTaskId,
      spaceId: input.spaceId,
      threadId: input.threadId,
    },
    select: { id: true },
  });
  if (!candidate) throw new TaskAmendmentRejected("not_found");
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM tasks WHERE id = ${input.targetTaskId} FOR UPDATE
  `;
  if (locked.length === 0) throw new TaskAmendmentRejected("not_found");
  return tx.task.findUniqueOrThrow({
    where: { id: input.targetTaskId },
    select: TASK_SELECT,
  });
}

function expectedTaskStatus(runStatus: string): "queued" | "completed" | "failed" | "cancelled" {
  const parsed = RunStatus.safeParse(runStatus);
  if (!parsed.success) return "cancelled";
  const status = parsed.data;
  switch (status) {
    case "queued":
    case "leased":
    case "running":
    case "waiting_input":
    case "waiting_takeover":
      return "queued";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * The only RT-14 state table. Inputs are persisted facts plus the amendment
 * ref that will commit. Unknown states and incoherent Task projections fail
 * closed instead of falling through to a guessed action.
 */
export function decideTaskAmendment(input: {
  task: Pick<TaskRow, "id" | "revision" | "status"> | null;
  targetRun: Pick<TaskRunRow, "id" | "status" | "consumedRevision"> | null;
  amendmentRef: RunInstructionRef;
  followUpRunId?: string;
}): TaskAmendmentDecision {
  if (!input.task || !input.targetRun) return { kind: "not_found" };
  if (
    input.amendmentRef.taskId !== input.task.id ||
    input.amendmentRef.consumedRevision !== input.task.revision + 1
  ) {
    return { kind: "conflict", reason: "amendment_ref_mismatch" };
  }
  const parsed = RunStatus.safeParse(input.targetRun.status);
  if (!parsed.success) return { kind: "conflict", reason: "unknown_run_status" };
  const status = parsed.data;
  if (input.task.status !== expectedTaskStatus(status)) {
    return { kind: "conflict", reason: "task_run_status_mismatch" };
  }
  switch (status) {
    case "queued":
      return input.targetRun.consumedRevision === null
        ? { kind: "queued_update_only", targetRunId: input.targetRun.id }
        : { kind: "active_steering", targetRunId: input.targetRun.id };
    case "leased":
    case "running":
    case "waiting_input":
    case "waiting_takeover":
      return { kind: "active_steering", targetRunId: input.targetRun.id };
    case "completed":
      return input.followUpRunId
        ? {
            kind: "completed_follow_up",
            targetRunId: input.targetRun.id,
            followUpRunId: input.followUpRunId,
          }
        : { kind: "conflict", reason: "missing_follow_up_identity" };
    case "failed":
      return {
        kind: "failed_record_only",
        targetRunId: input.targetRun.id,
        requiresExplicitRetry: true,
      };
    case "cancelled":
      return {
        kind: "cancelled_record_only",
        targetRunId: input.targetRun.id,
        requiresExplicitRetry: true,
      };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

async function lockTaskRuns(tx: Prisma.TransactionClient, taskId: string): Promise<TaskRunRow[]> {
  await tx.$queryRaw`
    SELECT id FROM runs WHERE "taskId" = ${taskId} ORDER BY "createdAt", id FOR UPDATE
  `;
  return tx.run.findMany({
    where: { taskId },
    select: TASK_RUN_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** One unbranched retry/follow-up lineage has exactly one current head. */
function boundTaskRun(runs: readonly TaskRunRow[]): TaskRunRow | null {
  if (runs.length === 0) return null;
  const byId = new Map(runs.map((run) => [run.id, run]));
  const childCount = new Map<string, number>();
  const predecessorIds = new Set<string>();
  for (const run of runs) {
    const predecessors = [run.retryOfRunId, run.followUpOfRunId].filter(
      (id): id is string => id !== null,
    );
    if (predecessors.length > 1) return null;
    const predecessorId = predecessors[0];
    if (!predecessorId) continue;
    if (!byId.has(predecessorId)) return null;
    const nextCount = (childCount.get(predecessorId) ?? 0) + 1;
    if (nextCount > 1) return null;
    childCount.set(predecessorId, nextCount);
    predecessorIds.add(predecessorId);
  }
  const heads = runs.filter((run) => !predecessorIds.has(run.id));
  if (heads.length !== 1) return null;
  const visited = new Set<string>();
  let current: TaskRunRow | undefined = heads[0];
  while (current) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    const predecessorId = current.retryOfRunId ?? current.followUpOfRunId;
    current = predecessorId ? byId.get(predecessorId) : undefined;
  }
  return visited.size === runs.length ? heads[0]! : null;
}

async function resolveAmendmentMessage(
  tx: Prisma.TransactionClient,
  input: AppendTaskAmendmentInput,
  source: TaskAmendmentSource,
): Promise<ResolvedAmendmentMessage> {
  if (input.messageId) {
    const message = await tx.message.findFirst({
      where: { id: input.messageId, threadId: input.threadId, role: "user" },
      select: { id: true, role: true, originKind: true, authorUserId: true, blocks: true },
    });
    if (!message) throw new TaskAmendmentRejected("not_found");
    return { message, created: false };
  }
  if (source !== "explicit") {
    throw new TaskAmendmentRejected("invalid", "An answered ask must append its user Message");
  }
  if (!input.clientNonce) {
    throw new TaskAmendmentRejected("invalid", "A client nonce or Message is required");
  }
  const existing = await tx.message.findUnique({
    where: {
      threadId_clientNonce: { threadId: input.threadId, clientNonce: input.clientNonce },
    },
    select: { id: true, role: true, originKind: true, authorUserId: true, blocks: true },
  });
  const content = input.content?.trim();
  if (!content) throw new TaskAmendmentRejected("invalid", "An amendment cannot be empty");
  if (existing) {
    const existingContent = amendmentContent(existing);
    if (
      existing.originKind !== "human_web" ||
      existing.authorUserId !== input.actorUserId ||
      existingContent !== content
    ) {
      throw new TaskAmendmentRejected(
        "conflict",
        "This client nonce belongs to a different Message",
      );
    }
    return { message: existing, created: false };
  }
  const message = await createThreadMessageInTransaction(tx, {
    threadId: input.threadId,
    role: "user",
    originKind: "human_web",
    authorUserId: input.actorUserId,
    blocks: [{ kind: "text", text: content }],
    clientNonce: input.clientNonce,
  });
  return { message, created: true };
}

async function readEnvelopeWithTask(
  tx: Prisma.TransactionClient,
  task: TaskRow,
  atRevision?: number,
): Promise<TaskInstructionEnvelope> {
  const requested = atRevision ?? task.revision;
  if (task.revision < 1 || requested < 1) {
    throw new TaskInstructionIntegrityError(task.id, requested, 0);
  }
  const revision = Math.min(requested, task.revision);
  const rows =
    revision === 1
      ? []
      : await tx.$queryRaw<Array<{ payload: unknown }>>`
          SELECT payload
          FROM events
          WHERE "threadId" = ${task.threadId}
            AND type = 'task.amended'
            AND payload->>'taskId' = ${task.id}
            AND COALESCE((payload->>'revision')::int, 0) <= ${revision}
          ORDER BY COALESCE((payload->>'seq')::int, 0) ASC, seq ASC
        `;
  const events = rows
    .map((row) => asRecord(row.payload))
    .filter((payload): payload is Record<string, unknown> => payload !== null)
    .map((payload) => ({
      payload,
      seq: typeof payload.seq === "number" ? payload.seq : 0,
      messageId: typeof payload.messageId === "string" ? payload.messageId : null,
      source:
        payload.source === "ask_answer" ||
        payload.source === "choice_answer" ||
        payload.source === "explicit"
          ? (payload.source as TaskAmendmentSource)
          : "explicit",
    }))
    .filter((event) => event.seq > 0 && event.messageId !== null);

  const messageIds = [
    ...new Set(events.flatMap((event) => (event.messageId ? [event.messageId] : []))),
  ];
  const messages =
    messageIds.length > 0
      ? await tx.message.findMany({
          where: { id: { in: messageIds }, threadId: task.threadId },
          select: { id: true, role: true, blocks: true },
        })
      : [];
  const messageById = new Map(messages.map((message) => [message.id, message]));

  const seenSeq = new Set<number>();
  const amendments: TaskInstructionAmendment[] = [];
  for (const event of events) {
    if (seenSeq.has(event.seq)) continue;
    const message = event.messageId ? messageById.get(event.messageId) : undefined;
    if (!message) continue;
    try {
      const content = amendmentContent(message);
      if (!content) continue;
      seenSeq.add(event.seq);
      amendments.push({ messageId: message.id, seq: event.seq, content });
    } catch {
      // A malformed or superseded card cannot be fed to the executor. Skip it
      // rather than inventing content from Task.prompt.
    }
  }
  amendments.sort((left, right) => left.seq - right.seq);
  if (amendments.length !== revision - 1) {
    throw new TaskInstructionIntegrityError(task.id, revision, amendments.length);
  }
  const parsed = TaskInstructionEnvelopeSchema.safeParse({
    taskId: task.id,
    revision,
    original: { content: task.prompt },
    amendments,
  });
  if (!parsed.success) {
    throw new TaskInstructionIntegrityError(task.id, revision, amendments.length);
  }
  return parsed.data;
}

/**
 * Append one natural-language revision. Thread, Message, Task revision and the
 * task.amended Event commit or roll back together. The Task row lock serializes
 * seq allocation, so concurrent appends cannot duplicate or skip a revision.
 */
export function appendTaskAmendment(
  prisma: PrismaClient,
  input: AppendTaskAmendmentInput,
): Promise<AppendTaskAmendmentResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      (tx: Prisma.TransactionClient) => appendTaskAmendmentInTransaction(tx, input),
      { timeout: 20_000, maxWait: 20_000 },
    ),
  );
}

export async function appendTaskAmendmentInTransaction(
  tx: Prisma.TransactionClient,
  input: AppendTaskAmendmentInput,
): Promise<AppendTaskAmendmentResult> {
  const source = input.source ?? "explicit";
  const content = input.content?.trim();
  if (source === "explicit" && !content) {
    throw new TaskAmendmentRejected("invalid", "An amendment cannot be empty");
  }
  // Same lock order as the other Thread writers, then the Task row that owns seq.
  await lockThread(tx, input.threadId);
  const task = await scopedTask(tx, input);
  if (input.requireTaskOwner !== false && task.userId !== input.actorUserId) {
    // Report absence, not ownership: another user's Task must stay unenumerable.
    throw new TaskAmendmentRejected("not_found");
  }
  // A cleared Thread leaves the Task aggregate without its amendment log. Read
  // the current envelope before writing so an append cannot resurrect a partial
  // instruction history.
  const current = await readEnvelopeWithTask(tx, task);
  const resolvedMessage = await resolveAmendmentMessage(tx, input, source);
  const replay = await replayedTaskAmendment(tx, task, input.threadId, resolvedMessage.message);
  if (replay) return replay;
  return commitTaskAmendment(tx, {
    input,
    source,
    task,
    current,
    resolvedMessage,
  });
}

async function replayedTaskAmendment(
  tx: Prisma.TransactionClient,
  task: TaskRow,
  threadId: string,
  message: ResolvedMessageRow,
): Promise<(AppendTaskAmendmentResult & { application?: TaskAmendmentApplication }) | null> {
  const existing = await tx.event.findFirst({
    where: { threadId, type: "task.amended", causationId: message.id },
    select: { id: true, seq: true, payload: true },
  });
  if (!existing) return null;
  const payload = asRecord(existing.payload);
  if (payload?.taskId !== task.id) {
    throw new TaskAmendmentRejected("conflict", "This Message already belongs to another Task");
  }
  const revision =
    typeof payload.revision === "number" && Number.isInteger(payload.revision)
      ? payload.revision
      : null;
  const seq = typeof payload.seq === "number" && Number.isInteger(payload.seq) ? payload.seq : null;
  if (!revision || revision < 2 || !seq || seq !== revision - 1) {
    throw new TaskAmendmentRejected("conflict", "The amendment Event is incomplete");
  }
  const application = TaskAmendmentApplicationSchema.safeParse(payload.application);
  return {
    envelope: await readEnvelopeWithTask(tx, task, revision),
    ref: { taskId: task.id, consumedRevision: revision },
    messageId: message.id,
    seq,
    eventSeq: existing.seq,
    replayed: true,
    ...(application.success ? { application: application.data } : {}),
  };
}

async function commitTaskAmendment(
  tx: Prisma.TransactionClient,
  options: {
    input: AppendTaskAmendmentInput;
    source: TaskAmendmentSource;
    task: TaskRow;
    current: TaskInstructionEnvelope;
    resolvedMessage: ResolvedAmendmentMessage;
    application?: TaskAmendmentApplication;
  },
): Promise<AppendTaskAmendmentResult> {
  const { input, source, task, current, resolvedMessage, application } = options;
  const message = resolvedMessage.message;
  const derived = amendmentContent(message);
  if (!derived.trim()) throw new TaskAmendmentRejected("invalid", "An amendment cannot be empty");
  if (resolvedMessage.created) {
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: task.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "user", blocks: message.blocks },
    });
  }
  const nextRevision = task.revision + 1;
  const amendmentSeq = nextRevision - 1;
  const updated = await tx.task.updateMany({
    where: { id: task.id, revision: task.revision },
    data: { revision: nextRevision },
  });
  if (updated.count !== 1) {
    throw new TaskAmendmentRejected("conflict", "The Task revision changed during the append");
  }
  const event = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: task.botId,
    type: "task.amended",
    causationId: message.id,
    payload: {
      taskId: task.id,
      messageId: message.id,
      seq: amendmentSeq,
      revision: nextRevision,
      actorUserId: input.actorUserId,
      source,
      ...(application ? { application } : {}),
    },
  });
  const envelope: TaskInstructionEnvelope = {
    ...current,
    revision: nextRevision,
    amendments: [
      ...current.amendments,
      { messageId: message.id, seq: amendmentSeq, content: derived },
    ],
  };
  return {
    envelope,
    ref: { taskId: task.id, consumedRevision: nextRevision },
    messageId: message.id,
    seq: amendmentSeq,
    eventSeq: event.seq,
    replayed: false,
  };
}

/**
 * Apply an explicit amendment to the one unbranched Run lineage of its Task.
 * Thread → Run(s) → Task is the lock order. The transaction either records the
 * revision and its state action together, or leaves no visible fragment.
 */
export function applyTaskAmendment(
  prisma: PrismaClient,
  input: AppendTaskAmendmentInput,
): Promise<ApplyTaskAmendmentResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      (tx: Prisma.TransactionClient) => applyTaskAmendmentInTransaction(tx, input),
      { timeout: 20_000, maxWait: 20_000 },
    ),
  );
}

export async function applyTaskAmendmentInTransaction(
  tx: Prisma.TransactionClient,
  input: AppendTaskAmendmentInput,
): Promise<ApplyTaskAmendmentResult> {
  const source = input.source ?? "explicit";
  const content = input.content?.trim();
  if (source !== "explicit" || !content || !input.clientNonce || input.messageId) {
    throw new TaskAmendmentRejected(
      "invalid",
      "State-aware Task amendments require explicit text and a client nonce",
    );
  }
  const candidate = await tx.task.findFirst({
    where: {
      id: input.targetTaskId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      ...(input.requireTaskOwner === false ? {} : { userId: input.actorUserId }),
    },
    select: { id: true },
  });
  if (!candidate) throw new TaskAmendmentRejected("not_found");

  await lockThread(tx, input.threadId);
  const runs = await lockTaskRuns(tx, input.targetTaskId);
  const targetRun = boundTaskRun(runs);
  if (!targetRun) {
    throw new TaskAmendmentRejected(
      runs.length === 0 ? "not_found" : "conflict",
      runs.length === 0 ? "not_found" : "Task Run lineage is ambiguous",
    );
  }
  const task = await scopedTask(tx, input);
  if (input.requireTaskOwner !== false && task.userId !== input.actorUserId) {
    throw new TaskAmendmentRejected("not_found");
  }
  const current = await readEnvelopeWithTask(tx, task);
  const resolvedMessage = await resolveAmendmentMessage(tx, input, source);
  const replay = await replayedTaskAmendment(tx, task, input.threadId, resolvedMessage.message);
  if (replay) {
    if (!replay.application) {
      throw new TaskAmendmentRejected(
        "conflict",
        "This amendment predates state-aware application",
      );
    }
    return { ...replay, application: replay.application };
  }

  const followUpRunId = randomUUID();
  const amendmentRef: RunInstructionRef = {
    taskId: task.id,
    consumedRevision: task.revision + 1,
  };
  const decision = decideTaskAmendment({
    task,
    targetRun,
    amendmentRef,
    followUpRunId,
  });
  if (decision.kind === "not_found") throw new TaskAmendmentRejected("not_found");
  if (decision.kind === "conflict") {
    throw new TaskAmendmentRejected("conflict", decision.reason);
  }

  if (decision.kind === "active_steering" && targetRun.consumedRevision === null) {
    const pinned = await tx.run.updateMany({
      where: { id: targetRun.id, consumedRevision: null },
      data: { consumedRevision: task.revision },
    });
    if (pinned.count !== 1) {
      throw new TaskAmendmentRejected("conflict", "The active Run revision changed");
    }
  }

  const appended = await commitTaskAmendment(tx, {
    input,
    source,
    task,
    current,
    resolvedMessage,
    application: decision,
  });

  if (decision.kind === "active_steering") {
    await tx.steeringMessage.create({
      data: {
        messageId: appended.messageId,
        botId: targetRun.botId,
        userId: input.actorUserId,
        runId: targetRun.id,
      },
    });
  } else if (decision.kind === "completed_follow_up") {
    await tx.run.create({
      data: {
        id: decision.followUpRunId,
        spaceId: targetRun.spaceId,
        botId: targetRun.botId,
        threadId: targetRun.threadId,
        taskId: targetRun.taskId,
        userId: targetRun.userId,
        status: "queued",
        trigger: "follow_up",
        sourceMessageId: appended.messageId,
        clientNonce: `task-amendment:${appended.messageId}`,
        followUpOfRunId: targetRun.id,
        orchestration: targetRun.orchestration ?? undefined,
      },
    });
    await tx.task.update({ where: { id: task.id }, data: { status: "queued" } });
  }

  const associatedRunId =
    decision.kind === "completed_follow_up" ? decision.followUpRunId : decision.targetRunId;
  await tx.message.update({
    where: { id: appended.messageId },
    data: { botId: targetRun.botId, runId: associatedRunId },
  });
  return { ...appended, application: decision };
}

/**
 * RT-27 read-only route fact for an explicitly addressed Task. The query is
 * scoped by Space, Thread, owner, and (when known) Bot so a foreign Task is
 * indistinguishable from a missing one. `amendable` is false when the Task
 * exists but its Run lineage or status projection cannot take a revision; the
 * amendment itself re-validates under locks.
 *
 * RT-27 also rejects terminal Tasks at the routing layer: RT-14 can record or
 * follow up on a terminal Task internally, but an explicit chat supplement is
 * not the retry/recovery path for work that already finished.
 */
export async function readAmendmentTargetInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    targetTaskId: string;
    spaceId: string;
    threadId: string;
    actorUserId: string;
    botId?: string;
  },
): Promise<AmendmentTargetFact | null> {
  const task = await tx.task.findFirst({
    where: {
      id: input.targetTaskId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      userId: input.actorUserId,
      ...(input.botId ? { botId: input.botId } : {}),
    },
    select: TASK_SELECT,
  });
  if (!task) return null;
  const runs = await tx.run.findMany({
    where: { taskId: task.id },
    select: TASK_RUN_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const targetRun = boundTaskRun(runs);
  if (!targetRun) return null;
  const status = RunStatus.safeParse(targetRun.status);
  const terminal =
    status.success &&
    (status.data === "completed" || status.data === "failed" || status.data === "cancelled");
  const amendable = status.success && !terminal && task.status === expectedTaskStatus(status.data);
  return { taskId: task.id, botId: task.botId, amendable };
}

/** Read the current (or requested historical) envelope without writing anything. */
export async function readTaskInstructionEnvelope(
  prisma: PrismaClient,
  input: ReadTaskInstructionInput,
): Promise<TaskInstructionEnvelope | null> {
  return prisma.$transaction((tx: Prisma.TransactionClient) =>
    readTaskInstructionEnvelopeInTransaction(tx, input),
  );
}

export async function readTaskInstructionEnvelopeInTransaction(
  tx: Prisma.TransactionClient,
  input: ReadTaskInstructionInput,
): Promise<TaskInstructionEnvelope | null> {
  const candidate = await tx.task.findFirst({
    where: {
      id: input.taskId,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    select: { id: true },
  });
  if (!candidate) return null;
  await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${input.taskId} FOR UPDATE`;
  const task = await tx.task.findUniqueOrThrow({
    where: { id: input.taskId },
    select: TASK_SELECT,
  });
  return readEnvelopeWithTask(tx, task, input.atRevision);
}

export async function readTaskInstructionView(
  prisma: PrismaClient,
  input: { taskId: string; spaceId: string; threadId: string },
): Promise<TaskInstructionView | null> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockThread(tx, input.threadId);
    const instructions = await readTaskInstructionEnvelopeInTransaction(tx, input);
    if (!instructions) return null;
    const runs = await tx.run.findMany({
      where: { taskId: input.taskId, spaceId: input.spaceId, threadId: input.threadId },
      select: TASK_RUN_SELECT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (!boundTaskRun(runs)) {
      throw new TaskAmendmentRejected("conflict", "Task Run lineage is not readable");
    }
    const runIds = runs.map((run) => run.id);
    const messages =
      runIds.length > 0
        ? await tx.message.findMany({
            where: { runId: { in: runIds }, role: "bot" },
            select: { id: true, runId: true, seq: true, blocks: true },
            orderBy: [{ runId: "asc" }, { seq: "asc" }],
          })
        : [];
    const resultByRun = new Map<string, TaskInstructionRun["result"]>();
    for (const message of messages) {
      if (!message.runId) continue;
      const result = pickExecutionResult({ messageId: message.id, blocks: message.blocks });
      if (result) resultByRun.set(message.runId, result);
    }
    const projectedRuns: TaskInstructionRun[] = runs.map((run) => {
      const status = RunStatus.safeParse(run.status);
      const trigger = RunTrigger.safeParse(run.trigger);
      if (!status.success || !trigger.success || (run.retryOfRunId && run.followUpOfRunId)) {
        throw new TaskAmendmentRejected("conflict", "Task Run lineage is not readable");
      }
      const lineage: TaskInstructionRun["lineage"] = run.retryOfRunId
        ? { kind: "manual_retry", predecessorRunId: run.retryOfRunId }
        : run.followUpOfRunId
          ? { kind: "amendment_follow_up", predecessorRunId: run.followUpOfRunId }
          : { kind: "original" };
      const result = resultByRun.get(run.id);
      const terminalResult =
        status.data === "completed" || status.data === "failed" ? result : undefined;
      return {
        runId: run.id,
        status: status.data,
        trigger: trigger.data,
        consumedRevision: run.consumedRevision,
        lineage,
        ...(terminalResult ? { result: terminalResult } : {}),
      };
    });
    return TaskInstructionViewSchema.parse({ instructions, runs: projectedRuns });
  });
}

/**
 * Read the exact input a leased Run may execute and persist the revision it
 * consumed. The Run row lock proves ownership; the Task row lock excludes a
 * concurrent append from landing between the revision read and the event read.
 */
export async function readTaskInstructionsForRun(
  prisma: PrismaClient,
  input: ReadTaskInstructionsForRunInput,
): Promise<RunTaskInstructions | null> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const lockedRun = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM runs WHERE id = ${input.runId} FOR UPDATE
    `;
    if (lockedRun.length === 0) return null;
    const run = await tx.run.findUnique({
      where: { id: input.runId },
      select: {
        id: true,
        taskId: true,
        status: true,
        leaseOwner: true,
        leaseFence: true,
        consumedRevision: true,
      },
    });
    if (
      run?.status !== "running" ||
      run.leaseOwner !== input.leaseOwner ||
      run.leaseFence !== input.leaseFence
    ) {
      return null;
    }
    await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${run.taskId} FOR UPDATE`;
    const task = await tx.task.findUniqueOrThrow({
      where: { id: run.taskId },
      select: TASK_SELECT,
    });
    const consumedRevision = run.consumedRevision ?? task.revision;
    const envelope = await readEnvelopeWithTask(tx, task, consumedRevision);
    const ref: RunInstructionRef = {
      taskId: task.id,
      consumedRevision,
    };
    if (run.consumedRevision === null) {
      await tx.run.update({
        where: { id: run.id },
        data: { consumedRevision: ref.consumedRevision },
      });
    }
    return { envelope, ref };
  });
}
