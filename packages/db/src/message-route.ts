import {
  ACTIVE_RUN_STATUSES,
  decideMessageRoute,
  type MessageRouteDecision,
  type SteeringCandidate,
} from "@rakazo/core";
import type { Prisma } from "./client.js";
import { readAmendmentTargetInTransaction } from "./task-instructions.js";

/**
 * RT-27 message write routing.
 *
 * Reads are the only thing this module does. The caller decides what to write
 * inside its own transaction, so a rejected route leaves no partial row.
 */

export type MessageRoutePlan = {
  decision: MessageRouteDecision;
  /** Ordered for logging and tests; the decision never indexes into it. */
  candidates: SteeringCandidate[];
};

const CANDIDATE_SELECT = {
  id: true,
  taskId: true,
  botId: true,
  status: true,
  trigger: true,
} as const;

/**
 * Active conversational Runs for the addressed Bots in this Thread.
 *
 * The order is stable (`createdAt`, `id`) so logs and tests are reproducible,
 * but the decision compares the whole set — a reversed result cannot change the
 * outcome.
 */
export async function readSteeringCandidates(
  tx: Prisma.TransactionClient,
  input: { threadId: string; botIds: readonly string[] },
): Promise<SteeringCandidate[]> {
  if (input.botIds.length === 0) return [];
  const runs = await tx.run.findMany({
    where: {
      threadId: input.threadId,
      botId: { in: [...input.botIds] },
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    select: CANDIDATE_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return runs.map((run) => ({
    runId: run.id,
    taskId: run.taskId,
    botId: run.botId,
    status: run.status,
    trigger: run.trigger,
  }));
}

export async function planMessageRoute(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    actorUserId: string;
    botId: string;
    targetTaskId?: string | null;
    /** Candidates the caller already read; read here when omitted. */
    candidates?: readonly SteeringCandidate[];
  },
): Promise<MessageRoutePlan> {
  const explicitTargetTaskId = input.targetTaskId?.trim() || null;
  const amendmentTarget = explicitTargetTaskId
    ? await readAmendmentTargetInTransaction(tx, {
        targetTaskId: explicitTargetTaskId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        actorUserId: input.actorUserId,
        botId: input.botId,
      })
    : null;
  // An explicit Task never falls back to candidate steering, so no candidate is
  // read or considered for it.
  const candidates = explicitTargetTaskId
    ? []
    : (input.candidates ??
      (await readSteeringCandidates(tx, {
        threadId: input.threadId,
        botIds: [input.botId],
      })));
  return {
    decision: decideMessageRoute({
      botId: input.botId,
      explicitTargetTaskId,
      amendmentTarget,
      candidates,
    }),
    candidates: [...candidates],
  };
}
