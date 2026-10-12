import { MessageBlock } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { appendEventInTransaction } from "./events.js";

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
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT "id" FROM "threads" WHERE "id" = ${candidate.threadId} FOR UPDATE`;
      const run = await tx.run.findUnique({ where: { id: candidate.id } });
      if (
        !run ||
        !["waiting_input", "waiting_takeover"].includes(run.status) ||
        !isExpired(run.waitKind, run.waitStartedAt, now)
      )
        return null;

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
              (block) =>
                block.kind === "ask" && block.status !== "answered" && block.approvalEffectId,
            )
          : null;
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
      if (pendingApproval?.kind === "ask" && pendingApproval.approvalEffectId) {
        const effect = await tx.externalEffect.updateMany({
          where: { id: pendingApproval.approvalEffectId, runId: run.id, status: "intended" },
          data: { status: "expired" },
        });
        if (effect.count) {
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
      }
      const cancelled = await tx.run.updateMany({
        where: {
          id: run.id, status: run.status, waitKind: run.waitKind,
          waitStartedAt: run.waitStartedAt,
        },
        data: {
          status: "cancelled",
          waitKind: null,
          waitStartedAt: null,
          error: "wait_timeout",
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      if (cancelled.count !== 1) return null;
      await tx.attempt.updateMany({
        where: { runId: run.id, status: { in: ["waiting_input", "waiting_takeover"] } },
        data: { status: "cancelled", error: "wait_timeout", finishedAt: now },
      });
      await tx.task.updateMany({ where: { id: run.taskId }, data: { status: "cancelled" } });
      await tx.backgroundAgentTask.updateMany({
        where: { parentRunId: run.id, status: "running" },
        data: { status: "cancelling" },
      });
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
    });
    if (result) expired.push(result);
  }
  return expired;
}
