import {
  type AvatarActivityCandidate,
  type BotAvatarState,
  selectAvatarActivity,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

type Viewer = { userId: string; spaceId: string };

/** A single database snapshot supplies the sidebar and focused avatar state. */
export async function loadBotAvatarStates(
  prisma: PrismaClient,
  viewer: Viewer,
): Promise<BotAvatarState[]> {
  return prisma.$transaction(
    async (tx) => {
      const bots = await tx.bot.findMany({
        where: { userId: viewer.userId, spaceId: viewer.spaceId, archivedAt: null },
        select: { id: true },
      });
      if (bots.length === 0) return [];
      const botIds = bots.map((bot) => bot.id);
      // Ownership of these Bots is the whole authorization scope: neither the
      // triggering user nor the Bot's direct thread may narrow the activity
      // queries, or Runs and background tasks in group chats and external
      // conversations go invisible while the Bot is actually busy (PR #52 P1).
      const [runs, pending, backgrounds] = await Promise.all([
        tx.run.findMany({
          where: {
            spaceId: viewer.spaceId,
            botId: { in: botIds },
            OR: [
              { status: { in: ["leased", "running", "waiting_input", "waiting_takeover"] } },
              { status: "failed", avatarFailureReceipts: { none: { userId: viewer.userId } } },
            ],
          },
          select: {
            id: true,
            botId: true,
            threadId: true,
            status: true,
            updatedAt: true,
            completedAt: true,
            snapshotRev: true,
          },
        }),
        tx.intervention.findMany({
          where: {
            spaceId: viewer.spaceId,
            botId: { in: botIds },
            status: "pending",
          },
          select: { runId: true, kind: true, updatedAt: true, revision: true },
        }),
        tx.backgroundAgentTask.findMany({
          where: {
            spaceId: viewer.spaceId,
            botId: { in: botIds },
            status: "running",
          },
          select: {
            botId: true,
            threadId: true,
            parentRunId: true,
            startedAt: true,
            heartbeatAt: true,
          },
        }),
      ]);
      // Cleared-thread suppression must cover every thread a fact came from —
      // direct, group and external alike — not just the Bot's direct thread.
      const factThreadIds = [
        ...new Set([
          ...runs.map((run) => run.threadId),
          ...backgrounds.map((task) => task.threadId),
        ]),
      ];
      const clears =
        factThreadIds.length === 0
          ? []
          : await tx.event.findMany({
              where: {
                spaceId: viewer.spaceId,
                threadId: { in: factThreadIds },
                type: "thread.cleared",
              },
              select: { threadId: true, createdAt: true },
              orderBy: { createdAt: "desc" },
            });
      const clearByThread = new Map<string, Date>();
      for (const clear of clears) {
        if (!clearByThread.has(clear.threadId)) clearByThread.set(clear.threadId, clear.createdAt);
      }
      const pendingByRun = new Map<string, (typeof pending)[number]>();
      for (const item of pending) {
        const previous = pendingByRun.get(item.runId);
        if (
          !previous ||
          (item.kind === "approval" && previous.kind !== "approval") ||
          (item.kind === previous.kind && item.updatedAt > previous.updatedAt)
        ) {
          pendingByRun.set(item.runId, item);
        }
      }
      const byBot = new Map<string, Array<AvatarActivityCandidate & { revision: number }>>();
      const append = (botId: string, candidate: AvatarActivityCandidate & { revision: number }) => {
        const list = byBot.get(botId) ?? [];
        list.push(candidate);
        byBot.set(botId, list);
      };
      for (const run of runs) {
        const clearedAt = clearByThread.get(run.threadId);
        if (run.status === "failed") {
          if (clearedAt && run.completedAt && run.completedAt <= clearedAt) continue;
          append(run.botId, {
            runId: run.id,
            kind: "failed",
            status: "failed",
            updatedAt: run.updatedAt.toISOString(),
            revision: run.snapshotRev,
          });
        } else if (run.status === "waiting_input") {
          const intervention = pendingByRun.get(run.id);
          if (!intervention) continue; // An orphan wait must not invent an approval.
          append(run.botId, {
            runId: run.id,
            kind: intervention.kind === "approval" ? "approval" : "waiting_input",
            status: "waiting",
            updatedAt: intervention.updatedAt.toISOString(),
            revision: Math.max(run.snapshotRev, intervention.revision),
          });
        } else if (run.status === "waiting_takeover") {
          append(run.botId, {
            runId: run.id,
            kind: "waiting_takeover",
            status: "waiting",
            updatedAt: run.updatedAt.toISOString(),
            revision: run.snapshotRev,
          });
        } else {
          append(run.botId, {
            runId: run.id,
            kind: "working",
            status: "running",
            updatedAt: run.updatedAt.toISOString(),
            revision: run.snapshotRev,
          });
        }
      }
      for (const task of backgrounds) {
        const clearedAt = clearByThread.get(task.threadId);
        if (clearedAt && task.startedAt <= clearedAt) continue;
        append(task.botId, {
          runId: task.parentRunId,
          kind: "background",
          status: "running",
          updatedAt: task.heartbeatAt.toISOString(),
          revision: 0,
        });
      }
      return bots.map((bot) => {
        const candidates = byBot.get(bot.id) ?? [];
        const chosen = selectAvatarActivity(candidates);
        const source = candidates.find(
          (item) => item.runId === chosen.runId && item.updatedAt === chosen.updatedAt,
        );
        return {
          botId: bot.id,
          state: chosen.state,
          runId: chosen.runId,
          revision: source?.revision ?? 0,
          updatedAt: chosen.updatedAt,
        };
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** Called only by the focused failed-Run detail view; generic thread read never calls it. */
export async function acknowledgeAvatarFailure(
  prisma: PrismaClient,
  viewer: Viewer,
  runId: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.run.findFirst({
      where: {
        id: runId,
        // No Run.userId filter: Bot ownership below is the authorization, so a
        // failure triggered by another Space member is still ackable by the owner.
        spaceId: viewer.spaceId,
        status: "failed",
        bot: { userId: viewer.userId, spaceId: viewer.spaceId, archivedAt: null },
      },
      select: { id: true, threadId: true, completedAt: true },
    });
    if (!run) return false;
    const clear = await tx.event.findFirst({
      where: { threadId: run.threadId, type: "thread.cleared" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (clear && run.completedAt && run.completedAt <= clear.createdAt) return false;
    await tx.avatarFailureReceipt.upsert({
      where: { userId_runId: { userId: viewer.userId, runId } },
      create: { userId: viewer.userId, runId, spaceId: viewer.spaceId },
      update: {},
    });
    return true;
  });
}
