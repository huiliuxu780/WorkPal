import {
  PublishRunStepInputSchema,
  RunPlanRevisionSchema,
  type RunStepSnapshot,
  RunStepSnapshotSchema,
} from "@rakazo/contracts";
import { appendEventInTransaction, currentThreadGeneration } from "./events.js";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

const terminal = new Set(["completed", "skipped", "cancelled"]);
const typeForStatus = {
  pending: "step.created",
  queued: "step.queued",
  running: "step.started",
  completed: "step.completed",
  failed: "step.failed",
  retrying: "step.retrying",
  skipped: "step.skipped",
  cancelled: "step.cancelled",
  blocked: "step.blocked",
} as const;

export type PublishRunStepResult =
  | { status: "published" | "replayed"; step: RunStepSnapshot; seq: number }
  | { status: "conflict"; currentRevision: number };

/** Publishes an explicit semantic Step; tool calls are never inferred as Steps. */
export async function publishRunStep(
  prisma: PrismaClient,
  scope: {
    spaceId: string;
    threadId: string;
    botId: string;
    runId: string;
    toolExecutionId: string;
  },
  rawInput: unknown,
): Promise<PublishRunStepResult> {
  const input = PublishRunStepInputSchema.parse(rawInput);
  if (!scope.toolExecutionId) throw new Error("Step tool execution id is required");
  return prisma.$transaction(async (tx) => {
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
        leaseFence: true,
      },
    });
    if (
      !run ||
      run.spaceId !== scope.spaceId ||
      run.threadId !== scope.threadId ||
      run.botId !== scope.botId ||
      run.status !== "running"
    ) {
      throw new Error("Run is not authorized to publish a Step");
    }
    const priorCall = await tx.runStepMutation.findUnique({
      where: { runId_toolExecutionId: { runId: run.id, toolExecutionId: scope.toolExecutionId } },
      select: { snapshot: true, eventSeq: true },
    });
    if (priorCall)
      return {
        status: "replayed" as const,
        step: RunStepSnapshotSchema.parse(priorCall.snapshot),
        seq: priorCall.eventSeq,
      };
    const key = { runId: run.id, stepId: input.stepId };
    const current = await tx.runStep.findUnique({ where: { runId_stepId: key } });
    const currentRevision = current?.revision ?? 0;
    if (input.expectedRevision !== currentRevision)
      return { status: "conflict" as const, currentRevision };
    const previous = current ? RunStepSnapshotSchema.parse(current.current) : null;
    const planItemId = input.planItemId ?? previous?.planItemId ?? null;
    const parentStepId = input.parentStepId ?? previous?.parentStepId ?? null;
    if (previous?.planItemId && planItemId !== previous.planItemId)
      throw new Error("Step Plan item link is immutable");
    if (previous?.parentStepId && parentStepId !== previous.parentStepId)
      throw new Error("Step parent link is immutable");
    if (previous && terminal.has(previous.status))
      throw new Error("A terminal Step cannot be revised");
    if (previous?.status === "failed" && !["retrying", "failed"].includes(input.status)) {
      throw new Error("A failed Step must enter retrying before continuing");
    }
    if (
      input.status === "retrying" &&
      previous?.status !== "failed" &&
      previous?.status !== "blocked"
    ) {
      throw new Error("A Step may retry only after failed or blocked");
    }
    if (!previous && input.status === "retrying")
      throw new Error("A new Step cannot start retrying");
    if (!previous && (await tx.runStep.count({ where: { runId: run.id } })) >= 100) {
      throw new Error("Run Step limit reached");
    }
    if (planItemId) {
      const plan = await tx.runPlan.findUnique({
        where: { runId: run.id },
        select: { current: true },
      });
      if (
        !plan ||
        !RunPlanRevisionSchema.parse(plan.current).items.some((item) => item.id === planItemId)
      ) {
        throw new Error("Plan item does not belong to this Run");
      }
    }
    if (parentStepId) {
      const parent = await tx.runStep.findUnique({
        where: { runId_stepId: { runId: run.id, stepId: parentStepId } },
        select: { current: true },
      });
      if (!parent) throw new Error("Parent Step does not belong to this Run");
      let ancestor: RunStepSnapshot | null = RunStepSnapshotSchema.parse(parent.current);
      while (ancestor?.parentStepId) {
        if (ancestor.parentStepId === input.stepId) throw new Error("Step parent cycle");
        const nextRow: { current: unknown } | null = await tx.runStep.findUnique({
          where: { runId_stepId: { runId: run.id, stepId: ancestor.parentStepId } },
          select: { current: true },
        });
        ancestor = nextRow ? RunStepSnapshotSchema.parse(nextRow.current) : null;
      }
    }
    for (const evidence of input.evidence ?? previous?.evidence ?? []) {
      if (evidence.kind === "external_effect") {
        const effect = await tx.externalEffect.findFirst({
          where: { id: evidence.id, runId: run.id },
          select: { id: true, status: true },
        });
        if (!effect) throw new Error("Step evidence does not belong to this Run");
        if (input.status === "completed" && !["completed", "reconciled"].includes(effect.status)) {
          throw new Error("A completed Step cannot cite an incomplete external effect");
        }
      } else if (evidence.kind === "artifact") {
        const artifact = await tx.artifact.findFirst({
          where: { id: evidence.id, runId: run.id, spaceId: run.spaceId },
          select: { id: true },
        });
        if (!artifact) throw new Error("Step evidence does not belong to this Run");
      } else {
        const event = await tx.event.findFirst({
          where: { id: evidence.id, runId: run.id, type: "agent.tool.completed" },
          select: { id: true, payload: true },
        });
        if (!event) throw new Error("Step evidence does not belong to this Run");
        if (
          input.status === "completed" &&
          (!event.payload ||
            typeof event.payload !== "object" ||
            Array.isArray(event.payload) ||
            event.payload.outcome !== "succeeded")
        ) {
          throw new Error("A completed Step cannot cite a failed tool action");
        }
      }
    }
    const attempt = await tx.attempt.findFirst({
      where: { runId: run.id, fence: run.leaseFence },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    const now = new Date().toISOString();
    const completedAt = terminal.has(input.status) || input.status === "failed" ? now : null;
    const resetResult =
      previous?.status !== input.status &&
      ["pending", "queued", "running", "retrying"].includes(input.status);
    const step: RunStepSnapshot = {
      stepId: input.stepId,
      runId: run.id,
      sourceMessageId: run.sourceMessageId,
      revision: currentRevision + 1,
      order: input.order,
      title: input.title,
      status: input.status,
      resultSummary:
        input.resultSummary ?? (resetResult ? null : (previous?.resultSummary ?? null)),
      planItemId,
      parentStepId,
      attemptId: attempt?.id ?? null,
      attemptNumber: attempt && run.leaseFence > 0 ? run.leaseFence : null,
      startedAt:
        previous?.startedAt ??
        (["running", "retrying", "completed", "failed"].includes(input.status) ? now : null),
      completedAt,
      evidence: input.evidence ?? (resetResult ? [] : (previous?.evidence ?? [])),
      batch: resetResult ? null : (previous?.batch ?? null),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    const generation = current
      ? current.threadGeneration
      : await currentThreadGeneration(tx, run.threadId);
    if (current) {
      await tx.runStep.update({
        where: { runId_stepId: key },
        data: {
          revision: step.revision,
          sortOrder: step.order,
          current: step as Prisma.InputJsonValue,
        },
      });
    } else {
      await tx.runStep.create({
        data: {
          ...key,
          threadGeneration: generation,
          revision: 1,
          sortOrder: step.order,
          current: step as Prisma.InputJsonValue,
        },
      });
    }
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: typeForStatus[input.status],
      payload: step,
    });
    await tx.runStepMutation.create({
      data: {
        ...key,
        toolExecutionId: scope.toolExecutionId,
        revision: step.revision,
        snapshot: step as Prisma.InputJsonValue,
        eventSeq: event.seq,
      },
    });
    return { status: "published" as const, step, seq: event.seq };
  });
}

export async function loadCurrentRunSteps(
  tx: Prisma.TransactionClient,
  threadId: string,
): Promise<RunStepSnapshot[]> {
  const generation = await currentThreadGeneration(tx, threadId);
  const rows = await tx.runStep.findMany({
    where: { threadGeneration: generation, run: { threadId } },
    orderBy: [{ updatedAt: "desc" }, { runId: "desc" }, { sortOrder: "asc" }],
    take: 200,
    select: { current: true, run: { select: { status: true } } },
  });
  return rows.map((row) => {
    const step = RunStepSnapshotSchema.parse(row.current);
    return ["completed", "failed", "cancelled"].includes(row.run.status) &&
      ["pending", "queued", "running", "retrying", "blocked"].includes(step.status)
      ? { ...step, status: "unknown" as const }
      : step;
  });
}
