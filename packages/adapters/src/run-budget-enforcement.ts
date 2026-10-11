import type { AgentRuntime } from "@rakazo/adapter-kit";
import {
  BUDGET_ACTIONS,
  budgetWithOverride,
  runBudgetViolations,
  turnPolicyFromRun,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";

/** Independent of the model stream, so a hung model call still reaches its duration limit. */
export async function enforceRunBudgets(
  deps: { prisma: PrismaClient; events: ThreadEvents; runtime: AgentRuntime },
  now = new Date(),
  runId?: string,
) {
  const runs = await deps.prisma.run.findMany({
    where: {
      ...(runId ? { id: runId } : {}),
      status: "running",
      leaseOwner: { not: null },
    },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    take: 100,
  });
  let enforced = 0;
  for (const run of runs) {
    if (!run.leaseOwner) continue;
    const policy = turnPolicyFromRun({
      trigger: run.trigger,
      ownerBotId: run.botId,
      orchestration: run.orchestration,
    });
    const budget = budgetWithOverride(
      policy.budget,
      run.budgetOverride,
    );
    const [usage, toolCalls, attempts] = await Promise.all([
      deps.prisma.usageRecord.aggregate({
        where: { runId: run.id },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      deps.prisma.event.count({ where: { runId: run.id, type: "agent.tool.called" } }),
      deps.prisma.attempt.findMany({
        where: { runId: run.id },
        select: { id: true, fence: true, status: true, startedAt: true, finishedAt: true },
      }),
    ]);
    const attempt = attempts.find((item) => item.fence === run.leaseFence && item.status === "running");
    if (!attempt) continue;
    // A human can leave a budget card unanswered for hours. Count execution
    // attempts, not that idle wait, while keeping the total across retries.
    const durationSec = attempts.reduce((total, item) => {
      const end = item.finishedAt ?? (item.status === "running" ? now : item.startedAt);
      return total + Math.max(0, (end.getTime() - item.startedAt.getTime()) / 1_000);
    }, 0);
    const violation = runBudgetViolations(budget, {
      tokens: (usage._sum.inputTokens ?? 0) + (usage._sum.outputTokens ?? 0),
      // The UsageRecord has token counts but no trusted model-specific price.
      costUsd: null,
      durationSec,
      toolCalls,
    })[0];
    if (!violation) continue;
    const common = {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      taskId: run.taskId,
      attemptId: attempt.id,
      leaseOwner: run.leaseOwner,
      leaseFence: run.leaseFence,
    };
    const changed = policy.interaction.interactive
      ? await deps.events.pauseRunForInput({
          ...common,
          budgetExceeded: violation,
          blocks: [{
            kind: "ask",
            text: `This run reached its ${violation.reason.replaceAll("_", " ")} budget (${violation.limit}). Choose how to continue.`,
            status: "pending",
            actions: BUDGET_ACTIONS.map((action) => ({ ...action })),
          }],
          offeredActions: BUDGET_ACTIONS.map((action) => ({ ...action })),
        })
      : await deps.events.finalizeRun({
          ...common,
          outcome: "failed",
          error: `budget_exceeded:${violation.reason}`,
          budgetExceeded: violation,
        });
    if (!changed) continue;
    enforced += 1;
    await deps.runtime.abort(run.id).catch(() => undefined);
  }
  return enforced;
}
