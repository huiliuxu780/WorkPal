import {
  type Actor,
  AvatarBodyColorSchema,
  AvatarStyleSchema,
  type GroupAgentIdentity,
  type GroupMembers,
  type GroupRoutineSummary,
  resolveAvatarIdentity,
} from "@rakazo/contracts";
import { createGroupRepos, IsolationError, type PrismaClient } from "@rakazo/db";
import { mapRoutine } from "./routines.js";

type GroupTarget = Awaited<ReturnType<ReturnType<typeof createGroupRepos>["getGroupTarget"]>>;
type GroupTargetMember = GroupTarget["members"][number];

function requireGroupThread(group: GroupTarget): string {
  if (!group.thread) throw new IsolationError("Group is missing its thread");
  return group.thread.id;
}

function agentIdentity(member: GroupTargetMember): GroupAgentIdentity {
  const avatar = resolveAvatarIdentity(
    member.bot.avatarMode,
    member.bot.avatarCharacter,
    member.bot.color,
  );
  return {
    kind: "agent",
    botId: member.bot.id,
    name: member.bot.name,
    color: member.bot.color,
    avatarMode: avatar.avatarMode,
    avatarCharacter: avatar.avatarCharacter,
    avatarBodyColor: AvatarBodyColorSchema.parse(member.bot.avatarBodyColor ?? "ink"),
  };
}

/** Routines stay owned by a concrete Bot; the group only scopes which ones are visible. */
export async function listGroupRoutines(
  deps: { prisma: PrismaClient },
  actor: Actor,
  groupId: string,
): Promise<GroupRoutineSummary[]> {
  const group = await createGroupRepos(deps.prisma).getGroupTarget(actor, groupId);
  const threadId = requireGroupThread(group);
  const members = new Map(group.members.map((member) => [member.bot.id, member]));

  const rows = await deps.prisma.routine.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      threadId,
      botId: { in: [...members.keys()] },
      bot: { archivedAt: null },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  return rows.map((row) => {
    const member = members.get(row.botId);
    if (!member) throw new IsolationError();
    return {
      ...mapRoutine(row),
      threadId,
      executorBot: agentIdentity(member),
    };
  });
}

export async function listGroupMembers(
  deps: { prisma: PrismaClient },
  actor: Actor,
  groupId: string,
): Promise<GroupMembers> {
  const group = await createGroupRepos(deps.prisma).getGroupTarget(actor, groupId);
  const threadId = requireGroupThread(group);
  const user = await deps.prisma.user.findFirst({
    where: { id: actor.userId },
    select: { id: true, name: true, image: true, avatarStyle: true },
  });
  if (!user) throw new IsolationError();

  const agents = group.members.map((member) => ({
    ...agentIdentity(member),
    status: member.bot.runs[0]?.status ?? "idle",
  }));

  return {
    groupId: group.id,
    threadId,
    currentUser: {
      kind: "user",
      userId: user.id,
      name: user.name,
      image: user.image,
      avatarStyle: AvatarStyleSchema.parse(user.avatarStyle),
    },
    agents,
    agentCount: agents.length,
    memberCount: agents.length + 1,
  };
}
