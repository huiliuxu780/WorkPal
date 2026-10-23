import type { Actor } from "@rakazo/contracts";
import { CHAT_GROUP_KIND_STANDARD } from "./agent-pairs.js";
import { lockThreadForBackgroundTask } from "./background-task-registration.js";
import type { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";

/**
 * Group and thread writes share one lock protocol: the Thread row first, then
 * the Group row. Send, follow-up, clear, handoff, public delegation, and group
 * mutations all use this boundary, so two transactions over the same pair can
 * only wait in one direction.
 */
export type LockedStandardGroupThread = Readonly<{
  groupId: string;
  threadId: string;
  name: string;
  leadBotId: string | null;
}>;

/**
 * Locks and revalidates one user-managed group plus its Thread.
 *
 * The Thread lock is the serialization point for every message write;
 * `createThreadMessageInTransaction` later increments the same row. All
 * authorization and binding checks run after both locks, so a caller's earlier
 * read is never the authorization basis.
 */
export async function lockOwnedStandardGroupThread(
  tx: Prisma.TransactionClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  input: {
    groupId: string;
    threadId: string;
    /** Archive/remove teardown may operate on an already archived group. */
    allowArchived?: boolean;
  },
): Promise<LockedStandardGroupThread> {
  const threadLocked = await lockThreadForBackgroundTask(tx, input.threadId);
  if (!threadLocked) throw new IsolationError("Group thread is no longer available");
  await lockOwnedGroup(tx, actor, input.groupId);

  const group = await tx.chatGroup.findFirst({
    where: {
      id: input.groupId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      kind: CHAT_GROUP_KIND_STANDARD,
      ...(input.allowArchived ? {} : { archivedAt: null }),
      thread: { id: input.threadId, spaceId: actor.spaceId },
    },
    select: {
      id: true,
      name: true,
      leadBotId: true,
      thread: { select: { id: true } },
    },
  });
  if (!group?.thread) throw new IsolationError("Group no longer matches its thread");
  return {
    groupId: group.id,
    threadId: group.thread.id,
    name: group.name,
    leadBotId: group.leadBotId,
  };
}

/**
 * Callers that only hold a group id need an unlocked preview to find the
 * Thread. The preview is scoped to the caller's Space, user, and standard kind
 * so a guessed foreign group id can never lock an unrelated Thread. It is still
 * not authorization: the locked helper re-reads and validates everything after
 * both row locks.
 */
export async function lockOwnedStandardGroupThreadByGroupId(
  tx: Prisma.TransactionClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  groupId: string,
  options?: { allowArchived?: boolean },
): Promise<LockedStandardGroupThread> {
  const preview = await tx.chatGroup.findFirst({
    where: {
      id: groupId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      kind: CHAT_GROUP_KIND_STANDARD,
    },
    select: { thread: { select: { id: true } } },
  });
  if (!preview?.thread) throw new IsolationError();
  return lockOwnedStandardGroupThread(tx, actor, {
    groupId,
    threadId: preview.thread.id,
    ...options,
  });
}

/** Group-row lock only. Pair it with the Thread lock helper for group writes. */
export async function lockOwnedGroup(
  prisma: Pick<Prisma.TransactionClient, "$queryRaw">,
  actor: Pick<Actor, "spaceId" | "userId">,
  groupId: string,
) {
  const locked = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM chat_groups
    WHERE id = ${groupId}
      AND "spaceId" = ${actor.spaceId}
      AND "userId" = ${actor.userId}
      AND "kind" = ${CHAT_GROUP_KIND_STANDARD}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new IsolationError();
}

/** Touch only a user-managed group; an agent_pair row is never a group mutation target. */
export async function touchGroupUpdatedAt(
  prisma: Pick<Prisma.TransactionClient, "chatGroup">,
  groupId: string,
) {
  const touched = await prisma.chatGroup.updateMany({
    where: { id: groupId, kind: CHAT_GROUP_KIND_STANDARD },
    data: { updatedAt: new Date() },
  });
  if (touched.count !== 1) throw new IsolationError();
}
