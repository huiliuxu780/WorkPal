import type { CollaborationOrigin } from "@rakazo/core";
import { CHAT_GROUP_KIND_AGENT_PAIR, type PrismaClient } from "@rakazo/db";

/** The origin facts persisted on a delegated Run (absent on user-started rows). */
export type RunOriginFields = {
  threadId: string;
  originThreadId: string | null;
  originRunId: string | null;
  originMessageId: string | null;
};

export type InterventionPresentation = {
  presentationThreadId: string;
  origin: CollaborationOrigin;
};

type OriginRow = {
  threadId: string;
  originThreadId: string | null;
  originRunId: string | null;
  originMessageId: string | null;
};

type ResolvedOrigin = {
  threadId: string;
  originThreadId: string;
  originRunId: string;
  originMessageId: string;
};

function readOrigin(row: OriginRow): ResolvedOrigin | null {
  const originThreadId = row.originThreadId?.trim();
  const originRunId = row.originRunId?.trim();
  const originMessageId = row.originMessageId?.trim();
  if (!originThreadId || !originRunId || !originMessageId) return null;
  return { threadId: row.threadId, originThreadId, originRunId, originMessageId };
}

/** Hard stop for a corrupt origin chain; legitimate nesting is bounded by hops. */
const MAX_ORIGIN_WALK = 8;

/**
 * Resolve the user-visible Thread an execution's approval or input request must
 * be presented in. A delegated Run's own origin can itself be a pair Thread
 * (Agent-to-Agent delegation), so walk the persisted chain until it lands in a
 * Bot chat or a standard group. The returned origin is the one RT-04 binds the
 * Intervention to: its source Run really belongs to the presentation Thread.
 *
 * Returns null when the execution has no origin or no visible ancestor. The
 * caller then keeps the execution Thread, which is the ordinary same-thread
 * pause path.
 */
export async function resolveInterventionPresentation(
  prisma: PrismaClient,
  run: RunOriginFields,
): Promise<InterventionPresentation | null> {
  let current = readOrigin(run);
  for (let depth = 0; current && depth < MAX_ORIGIN_WALK; depth += 1) {
    const thread = await prisma.thread.findUnique({
      where: { id: current.originThreadId },
      select: { id: true, group: { select: { kind: true } } },
    });
    if (!thread) return null;
    if (thread.group?.kind !== CHAT_GROUP_KIND_AGENT_PAIR) {
      return {
        presentationThreadId: thread.id,
        origin: {
          sourceThreadId: thread.id as CollaborationOrigin["sourceThreadId"],
          sourceRunId: current.originRunId as CollaborationOrigin["sourceRunId"],
          sourceMessageId: current.originMessageId as NonNullable<
            CollaborationOrigin["sourceMessageId"]
          >,
        },
      };
    }
    const parent = await prisma.run.findUnique({
      where: { id: current.originRunId },
      select: {
        threadId: true,
        originThreadId: true,
        originRunId: true,
        originMessageId: true,
      },
    });
    current = parent ? readOrigin(parent) : null;
  }
  return null;
}

/**
 * Spread into `pauseRunForInput`: a delegated Run presents its wait in the
 * originating visible Thread; an ordinary Run keeps the same-Thread default.
 */
export async function interventionOriginForRun(
  prisma: PrismaClient,
  run: RunOriginFields,
): Promise<{ presentationThreadId?: string; origin?: CollaborationOrigin }> {
  if (!run.originThreadId || !run.originRunId) return {};
  const resolved = await resolveInterventionPresentation(prisma, run);
  if (!resolved) return {};
  return { presentationThreadId: resolved.presentationThreadId, origin: resolved.origin };
}
