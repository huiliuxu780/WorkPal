import type {
  MessageBlock,
  RunInstructionRef,
  TaskAmendmentSource,
  TaskInstructionAmendment,
  TaskInstructionEnvelope,
} from "@rakazo/contracts";
import {
  MessageBlock as MessageBlockSchema,
  TaskInstructionEnvelopeSchema,
} from "@rakazo/contracts";
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
    where: { id: input.targetTaskId, spaceId: input.spaceId, threadId: input.threadId },
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
  const message = resolvedMessage.message;
  const existing = await tx.event.findFirst({
    where: { threadId: input.threadId, type: "task.amended", causationId: message.id },
    select: { id: true, seq: true, payload: true },
  });
  if (existing) {
    const payload = asRecord(existing.payload);
    if (payload?.taskId !== task.id) {
      throw new TaskAmendmentRejected("conflict", "This Message already belongs to another Task");
    }
    return {
      envelope: await readEnvelopeWithTask(tx, task),
      ref: { taskId: task.id, consumedRevision: task.revision },
      messageId: message.id,
      seq: typeof payload.seq === "number" ? payload.seq : Math.max(1, task.revision - 1),
      eventSeq: existing.seq,
      replayed: true,
    };
  }

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

/** Read the current (or requested historical) envelope without writing anything. */
export async function readTaskInstructionEnvelope(
  prisma: PrismaClient,
  input: ReadTaskInstructionInput,
): Promise<TaskInstructionEnvelope | null> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
