import type { MessageBlock, MessageOriginKind } from "@rakazo/contracts";
import { parseRunOrchestration } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

/** Group turns use channel inputs and their own outputs, never private thread history. */
export function loadRunHistoryMessages(
  prisma: PrismaClient,
  run: { id: string; threadId: string },
  limit: number,
  channelId?: string,
) {
  return prisma.message.findMany({
    where: {
      threadId: run.threadId,
      ...(channelId
        ? {
            OR: [
              {
                role: "user",
                blocks: { array_contains: [{ kind: "channel_message", channelId }] },
              },
              { role: "bot", runId: run.id },
            ],
          }
        : {}),
    },
    orderBy: { seq: "desc" },
    take: limit,
    select: {
      id: true,
      threadId: true,
      seq: true,
      role: true,
      originKind: true,
      authorUserId: true,
      runId: true,
      blocks: true,
      replyToMessageId: true,
      replyQuote: true,
      replyTo: { select: { id: true, threadId: true, role: true, blocks: true } },
    },
  });
}

export interface CreateThreadMessageInput {
  /** Pregenerated so an Intervention row can name the message in the same transaction. */
  id?: string;
  threadId: string;
  role: "user" | "bot" | "system";
  /** Explicitly derived by the trusted entry point; omission is conservative. */
  originKind?: MessageOriginKind;
  authorUserId?: string | null;
  blocks: MessageBlock[];
  botId?: string;
  replyToMessageId?: string;
  replyQuote?: string;
  runId?: string;
  clientNonce?: string;
  markUnread?: boolean;
  /** Typed cancel outcome only. Lets the cancelled owner write its one outcome. */
  allowTypedCancel?: boolean;
}

export async function createThreadMessage(prisma: PrismaClient, input: CreateThreadMessageInput) {
  return withTransactionRetry(() =>
    prisma.$transaction((tx: Prisma.TransactionClient) =>
      createThreadMessageInTransaction(tx, input),
    ),
  );
}

export async function createThreadMessageInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateThreadMessageInput,
) {
  const originKind = input.originKind ?? "unknown";
  const authorUserId = input.authorUserId?.trim() || null;
  const humanOrigin = originKind === "human_web" || originKind === "human_messaging";
  if (humanOrigin !== Boolean(authorUserId)) {
    throw new Error("Message author and origin are inconsistent");
  }
  if (humanOrigin && input.role !== "user") {
    throw new Error("Human-origin message must have the user role");
  }
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: {
      nextMessageSeq: { increment: 1 },
      unread: (input.markUnread ?? input.role === "bot") ? true : undefined,
    },
    select: { nextMessageSeq: true },
  });
  await assertRunCanWriteHistory(tx, input.runId, {
    allowTypedCancel: input.allowTypedCancel,
  });
  return tx.message.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      threadId: input.threadId,
      seq: thread.nextMessageSeq - 1,
      role: input.role,
      originKind,
      authorUserId,
      blocks: input.blocks as Prisma.InputJsonValue,
      botId: input.botId,
      replyToMessageId: input.replyToMessageId,
      replyQuote: input.replyQuote,
      runId: input.runId,
      clientNonce: input.clientNonce,
    },
  });
}

export class RunHistoryWriteError extends Error {
  constructor() {
    super("Run cannot write thread history");
    this.name = "RunHistoryWriteError";
  }
}

export async function assertRunCanWriteHistory(
  tx: Prisma.TransactionClient,
  runId?: string,
  options?: { allowTypedCancel?: boolean },
): Promise<{ status: string; startedAt: Date | null } | undefined> {
  if (!runId) return;
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { status: true, startedAt: true, orchestration: true, cancelReason: true },
  });
  if (!run) throw new RunHistoryWriteError();
  const typedCancel =
    options?.allowTypedCancel === true && run.status === "cancelled" && run.cancelReason !== null;
  if (run.status === "cancelled" && !typedCancel) {
    throw new RunHistoryWriteError();
  }
  // The terminal outcome is the only history a typed-cancelled run may write.
  if (typedCancel) return run;
  const parentRunId = parseRunOrchestration(run.orchestration)?.collaboration?.parentRunId;
  if (parentRunId) {
    const parent = await tx.run.findUnique({
      where: { id: parentRunId },
      select: { status: true, cancelReason: true },
    });
    const parentTypedCancel =
      options?.allowTypedCancel === true &&
      parent?.status === "cancelled" &&
      parent.cancelReason !== null;
    if (!parent || (parent.status === "cancelled" && !parentTypedCancel)) {
      throw new RunHistoryWriteError();
    }
  }
  return run;
}

/**
 * run.cancelled is recorded by the path that cancelled the run, after the row
 * already reads cancelled — where the liveness assert above would reject it.
 * The event must name its run (clients key off it) and the row must already be
 * cancelled, so it can never announce a cancellation nothing committed.
 */
export async function assertRunIsCancelled(
  tx: Prisma.TransactionClient,
  runId?: string,
): Promise<void> {
  if (!runId) throw new RunHistoryWriteError();
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  if (run?.status !== "cancelled") {
    throw new RunHistoryWriteError();
  }
}
