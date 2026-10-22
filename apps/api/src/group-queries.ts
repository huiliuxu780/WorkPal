import { resolveAvatarIdentity } from "@rakazo/contracts";
import {
  type GroupMembersSummary,
  type GroupQueries,
  type GroupQuery,
  type GroupRoutineSummary,
  parseGroupMembersSummary,
  parseGroupRoutineSummary,
} from "@rakazo/core";
import { createGroupRepos, IsolationError, type PrismaClient } from "@rakazo/db";
import { listGroupArtifactSummaries } from "./artifacts.js";
import { mapRoutine } from "./routines.js";

type GroupTarget = Awaited<ReturnType<ReturnType<typeof createGroupRepos>["getGroupTarget"]>>;
type GroupTargetMember = GroupTarget["members"][number];

export class GroupQueryNotImplementedError extends Error {
  constructor(query: "listWork" | "getWork") {
    super(`GroupQueries.${query} is not implemented`);
    this.name = "GroupQueryNotImplementedError";
  }
}

function requireGroupThread(group: GroupTarget): string {
  if (!group.thread) throw new IsolationError("Group is missing its thread");
  return group.thread.id;
}

function agentIdentity(member: GroupTargetMember) {
  const avatar = resolveAvatarIdentity(
    member.bot.avatarMode,
    member.bot.avatarCharacter,
    member.bot.color,
  );
  return {
    kind: "agent" as const,
    botId: member.bot.id,
    name: member.bot.name,
    color: member.bot.color,
    avatarMode: avatar.avatarMode,
    avatarCharacter: avatar.avatarCharacter,
    avatarBodyColor: member.bot.avatarBodyColor ?? "ink",
  };
}

async function listGroupRoutines(
  deps: { prisma: PrismaClient },
  query: GroupQuery,
): Promise<readonly GroupRoutineSummary[]> {
  const group = await createGroupRepos(deps.prisma).getGroupTarget(query.actor, query.groupId);
  const threadId = requireGroupThread(group);
  const members = new Map(group.members.map((member) => [member.bot.id, member]));

  const rows = await deps.prisma.routine.findMany({
    where: {
      spaceId: query.actor.spaceId,
      userId: query.actor.userId,
      threadId,
      botId: { in: [...members.keys()] },
      bot: { archivedAt: null },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  return rows.map((row) => {
    const member = members.get(row.botId);
    if (!member) throw new IsolationError();
    return parseGroupRoutineSummary({
      ...mapRoutine(row),
      threadId,
      executorBot: agentIdentity(member),
    });
  });
}

async function listGroupMembers(
  deps: { prisma: PrismaClient },
  query: GroupQuery,
): Promise<GroupMembersSummary> {
  const group = await createGroupRepos(deps.prisma).getGroupTarget(query.actor, query.groupId);
  const threadId = requireGroupThread(group);
  const user = await deps.prisma.user.findFirst({
    where: { id: query.actor.userId },
    select: { id: true, name: true, image: true, avatarStyle: true },
  });
  if (!user) throw new IsolationError();

  const agents = group.members.map((member) => ({
    ...agentIdentity(member),
    status: member.bot.runs[0]?.status ?? "idle",
  }));

  return parseGroupMembersSummary({
    groupId: group.id,
    threadId,
    currentUser: {
      kind: "user",
      userId: user.id,
      name: user.name,
      image: user.image,
      avatarStyle: user.avatarStyle,
    },
    agents,
    agentCount: agents.length,
    memberCount: agents.length + 1,
  });
}

/** The single application implementation of the frozen roundtable GroupQueries port. */
export function createGroupQueries(deps: { prisma: PrismaClient }): GroupQueries {
  return {
    async listWork() {
      throw new GroupQueryNotImplementedError("listWork");
    },
    async getWork() {
      throw new GroupQueryNotImplementedError("getWork");
    },
    listArtifacts: (query) => listGroupArtifactSummaries(deps, query),
    listRoutines: (query) => listGroupRoutines(deps, query),
    listMembers: (query) => listGroupMembers(deps, query),
  };
}
