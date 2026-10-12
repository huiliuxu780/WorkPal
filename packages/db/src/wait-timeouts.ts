import { MessageBlock } from "@rakazo/contracts";
import { cancelChildrenOfCancelledRuns } from "./cancel-child-runs.js";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { appendEventInTransaction } from "./events.js";
import { expirePendingIntervention } from "./interventions.js";

const WAIT_TRANSACTION = { timeout: 20_000, maxWait: 20_000 };

export const WAIT_TIMEOUT_MS = {
  approval: 24 * 60 * 60_000,
  input: 24 * 60 * 60_000,
  takeover: 30 * 60_000,
} as const;

type WaitKind = keyof typeof WAIT_TIMEOUT_MS;

function isExpired(waitKind: string | null, waitStartedAt: Date | null, now: Date): waitKind is WaitKind {
  return (
    waitKind !== null &&
    waitStartedAt !== null &&
    waitKind in WAIT_TIMEOUT_MS &&
    waitStartedAt.getTime() <= now.getTime() - WAIT_TIMEOUT_MS[waitKind as WaitKind]
  );
}

/**
 * Expire one waiting run. The caller may already hold the thread row lock.
 * Intervention expiry is recorded while the run is still waiting, and before
 * ask blocks are marked expired, so a legacy pending ask can still be found.
 */
export async function expireWaitingRunInTransaction(
  tx: Prisma.TransactionClient,
  runId: string,
  now: Date,
): Promise<{ runId: string; threadId: string; seq: number } | null> {
  const located = await tx.run.findUnique({
    where: { id: runId },
    select: { threadId: true },
  });
  if (!located) return null;
  await tx.$queryRaw`SELECT "id" FROM "threads" WHERE "id" = ${located.threadId} FOR UPDATE`;
  const run = await tx.run.findUnique({ where: { id: runId } });
  if (
    !run ||
    !["waiting_input", "waiting_takeover"].includes(run.status) ||
    !isExpired(run.waitKind, run.waitStartedAt, now)
  ) {
    return null;
  }

  const message =
    run.status === "waiting_input"
      ? await tx.message.findFirst({
          where: { runId: run.id, role: "bot" },
          orderBy: { seq: "desc" },
        })
      : null;
  const parsed = message ? MessageBlock.array().safeParse(message.blocks) : null;
  const blocks = parsed?.success ? parsed.data : null;
  const pendingApproval =
    run.waitKind === "approval"
      ? blocks?.find(
          (block) => block.kind === "ask" && block.status !== "answered" && block.approvalEffectId,
        )
      : null;
  // Lock order is Thread → Run → Intervention → ExternalEffect → Message → Event.
  // Settle the Intervention (which locks the Run first) before touching the
  // ExternalEffect, so a concurrent Approval answer and this expiry cannot
  // take the Run/Effect pair in opposite orders.
  if (run.status === "waiting_input") {
    await expirePendingIntervention(tx, {
      id: run.id,
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      waitStartedAt: run.waitStartedAt,
    });
  }
  const effectExpired =
    pendingApproval?.kind === "ask" && pendingApproval.approvalEffectId
      ? await tx.externalEffect.updateMany({
          where: { id: pendingApproval.approvalEffectId, runId: run.id, status: "intended" },
          data: { status: "expired" },
        })
      : { count: 0 };
  if (message && blocks?.some((block) => block.kind === "ask" && block.status !== "answered")) {
    const expiredBlocks = blocks.map((block) =>
      block.kind === "ask" && block.status !== "answered"
        ? { ...block, status: "expired" as const }
        : block,
    );
    await tx.message.update({
      where: { id: message.id },
      data: { blocks: expiredBlocks as Prisma.InputJsonValue },
    });
    await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks: expiredBlocks },
    });
  }
  if (effectExpired.count && pendingApproval?.kind === "ask" && pendingApproval.approvalEffectId) {
    await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "approval.resolved",
      schemaVersion: 2,
      payload: { approvalEffectId: pendingApproval.approvalEffectId, decision: "expired" },
    });
  }
  const cancelled = await cancelRunsInTransaction(
    tx,
    [{ id: run.id, taskId: run.taskId }],
    now,
    {
      error: "wait_timeout",
      attemptError: "wait_timeout",
      // A concurrent answer or claim changes status or the wait clock. Do not cancel that row.
      match: {
        status: run.status,
        waitKind: run.waitKind,
        waitStartedAt: run.waitStartedAt,
      },
    },
  );
  if (cancelled.length !== 1) throw new Error("Expired run was no longer waiting");
  await expireComputerExecutionLeases(tx, { runId: run.id });
  const event = await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId: run.id,
    type: "run.cancelled",
    payload: { reason: "wait_timeout" },
  });
  return { runId: run.id, threadId: run.threadId, seq: event.seq };
}

/** Claim a waiting Run under the Thread lock, so a concurrent answer cannot revive it. */
export async function expireWaitingRuns(prisma: PrismaClient, now = new Date()) {
  const candidates = await prisma.run.findMany({
    where: {
      OR: [
        {
          status: "waiting_input",
          waitStartedAt: { lte: new Date(now.getTime() - WAIT_TIMEOUT_MS.input) },
        },
        {
          status: "waiting_takeover",
          waitStartedAt: { lte: new Date(now.getTime() - WAIT_TIMEOUT_MS.takeover) },
        },
      ],
    },
    orderBy: [{ waitStartedAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true, threadId: true },
  });
  const expired: Array<{ runId: string; threadId: string; seq: number }> = [];
  for (const candidate of candidates) {
    const result = await prisma.$transaction(
      (tx: Prisma.TransactionClient) => expireWaitingRunInTransaction(tx, candidate.id, now),
      WAIT_TRANSACTION,
    );
    if (result) expired.push(result);
  }
  if (expired.length > 0) {
    await cancelChildrenOfCancelledRuns(
      prisma,
      expired.map((run) => run.runId),
    );
  }
  return expired;
}
