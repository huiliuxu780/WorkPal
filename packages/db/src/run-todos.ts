import {
  PublishRunTodoInputSchema,
  type RunTodoSnapshot,
  RunTodoSnapshotSchema,
} from "@rakazo/contracts";
import { appendEventInTransaction, currentThreadGeneration } from "./events.js";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

export type PublishRunTodoResult =
  | { status: "published" | "replayed"; todo: RunTodoSnapshot; seq: number }
  | { status: "conflict"; currentRevision: number };

export async function publishRunTodo(
  prisma: PrismaClient,
  scope: {
    spaceId: string;
    threadId: string;
    botId: string;
    runId: string;
    toolExecutionId: string;
  },
  rawInput: unknown,
): Promise<PublishRunTodoResult> {
  const input = PublishRunTodoInputSchema.parse(rawInput);
  if (!scope.toolExecutionId) throw new Error("Todo tool execution id is required");
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
      },
    });
    if (
      !run ||
      run.spaceId !== scope.spaceId ||
      run.threadId !== scope.threadId ||
      run.botId !== scope.botId ||
      run.status !== "running"
    ) {
      throw new Error("Run is not authorized to publish a Todo");
    }
    const priorCall = await tx.runTodoMutation.findUnique({
      where: { runId_toolExecutionId: { runId: run.id, toolExecutionId: scope.toolExecutionId } },
      select: { snapshot: true, eventSeq: true },
    });
    if (priorCall)
      return {
        status: "replayed" as const,
        todo: RunTodoSnapshotSchema.parse(priorCall.snapshot),
        seq: priorCall.eventSeq,
      };
    const key = { runId: run.id, todoId: input.todoId };
    const current = await tx.runTodo.findUnique({ where: { runId_todoId: key } });
    const currentRevision = current?.revision ?? 0;
    if (input.expectedRevision !== currentRevision)
      return { status: "conflict" as const, currentRevision };
    const previous = current ? RunTodoSnapshotSchema.parse(current.current) : null;
    if (previous?.status === "resolved") throw new Error("A resolved Todo cannot be revised");
    if (!previous && (await tx.runTodo.count({ where: { runId: run.id } })) >= 100) {
      throw new Error("Run Todo limit reached");
    }
    const linkedStepId = input.linkedStepId ?? previous?.linkedStepId ?? null;
    if (previous?.linkedStepId && linkedStepId !== previous.linkedStepId) {
      throw new Error("Todo Step link is immutable");
    }
    if (linkedStepId) {
      const step = await tx.runStep.findUnique({
        where: { runId_stepId: { runId: run.id, stepId: linkedStepId } },
        select: { stepId: true },
      });
      if (!step) throw new Error("Linked Step does not belong to this Run");
    }
    const now = new Date().toISOString();
    const todo: RunTodoSnapshot = {
      todoId: input.todoId,
      runId: run.id,
      sourceMessageId: run.sourceMessageId,
      revision: currentRevision + 1,
      order: input.order,
      title: input.title,
      status: input.status,
      linkedStepId,
      reason: input.reason ?? (previous?.status === input.status ? previous.reason : null),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    const generation = current
      ? current.threadGeneration
      : await currentThreadGeneration(tx, run.threadId);
    if (current) {
      await tx.runTodo.update({
        where: { runId_todoId: key },
        data: {
          revision: todo.revision,
          sortOrder: todo.order,
          current: todo as Prisma.InputJsonValue,
        },
      });
    } else {
      await tx.runTodo.create({
        data: {
          ...key,
          threadGeneration: generation,
          revision: 1,
          sortOrder: todo.order,
          current: todo as Prisma.InputJsonValue,
        },
      });
    }
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: !previous
        ? "todo.created"
        : input.status === "resolved"
          ? "todo.resolved"
          : input.status === "deferred"
            ? "todo.deferred"
            : "todo.updated",
      payload: todo,
    });
    await tx.runTodoMutation.create({
      data: {
        ...key,
        toolExecutionId: scope.toolExecutionId,
        revision: todo.revision,
        snapshot: todo as Prisma.InputJsonValue,
        eventSeq: event.seq,
      },
    });
    return { status: "published" as const, todo, seq: event.seq };
  });
}

export async function loadCurrentRunTodos(
  tx: Prisma.TransactionClient,
  threadId: string,
): Promise<RunTodoSnapshot[]> {
  const generation = await currentThreadGeneration(tx, threadId);
  const rows = await tx.runTodo.findMany({
    where: { threadGeneration: generation, run: { threadId } },
    orderBy: [{ updatedAt: "desc" }, { runId: "desc" }, { sortOrder: "asc" }],
    take: 200,
    select: { current: true },
  });
  return rows.map((row) => RunTodoSnapshotSchema.parse(row.current));
}
