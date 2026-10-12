import {
  PublishRunPlanInputSchema,
  type RunPlanRevision,
  RunPlanRevisionSchema,
} from "@rakazo/contracts";
import { appendEventInTransaction, currentThreadGeneration } from "./events.js";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

export type PublishRunPlanResult =
  | { status: "published" | "replayed"; plan: RunPlanRevision; seq: number }
  | { status: "conflict"; currentRevision: number };

/** Backend-owned write path: exact structured input, durable revision and live event in one transaction. */
export async function publishRunPlan(
  prisma: PrismaClient,
  scope: {
    spaceId: string;
    threadId: string;
    botId: string;
    runId: string;
    toolExecutionId: string;
  },
  rawInput: unknown,
): Promise<PublishRunPlanResult> {
  const input = PublishRunPlanInputSchema.parse(rawInput);
  if (!scope.toolExecutionId) throw new Error("Plan tool execution id is required");
  return prisma.$transaction(async (tx) => {
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
    const priorCall = await tx.runPlanRevision.findUnique({
      where: { runId_toolExecutionId: { runId: run.id, toolExecutionId: scope.toolExecutionId } },
      select: { snapshot: true, eventSeq: true },
    });
    if (priorCall)
      return {
        status: "replayed" as const,
        plan: RunPlanRevisionSchema.parse(priorCall.snapshot),
        seq: priorCall.eventSeq,
      };
    const current = await tx.runPlan.findUnique({ where: { runId: run.id } });
    const currentRevision = current?.revision ?? 0;
    if (input.expectedRevision !== currentRevision)
      return { status: "conflict" as const, currentRevision };
    if (current) {
      const previous = RunPlanRevisionSchema.parse(current.current);
      const ids = new Set(input.items.map((item) => item.id));
      if (previous.items.some((item) => !ids.has(item.id))) {
        throw new Error(
          "A revision must retain prior item ids; mark removed work superseded or skipped",
        );
      }
    }
    const revision = currentRevision + 1;
    const planId = current?.planId ?? `plan:${run.id}`;
    const plan: RunPlanRevision = {
      planId,
      runId: run.id,
      sourceMessageId: run.sourceMessageId,
      revisionId: `${planId}:${revision}`,
      revision,
      goal: input.goal,
      items: input.items,
      changeReason: input.changeReason ?? null,
      createdAt: new Date().toISOString(),
    };
    const generation = current
      ? current.threadGeneration
      : await currentThreadGeneration(tx, run.threadId);
    if (current) {
      await tx.runPlan.update({
        where: { runId: run.id },
        data: { revision, current: plan as Prisma.InputJsonValue },
      });
    } else {
      await tx.runPlan.create({
        data: {
          runId: run.id,
          planId,
          threadGeneration: generation,
          revision,
          current: plan as Prisma.InputJsonValue,
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
    return { status: "published" as const, plan, seq: event.seq };
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
