import type {
  Actor,
  ArtifactPage,
  GroupMembers,
  GroupRoutineSummary as WireGroupRoutineSummary,
} from "@rakazo/contracts";
import {
  type ArtifactSummary,
  type GroupMembersSummary,
  type GroupPageQuery,
  type GroupQuery,
  type GroupRoutineSummary,
  type Page,
  parseGroupPageQuery,
  parseGroupQuery,
} from "@rakazo/core";

export type GroupArtifactListInput = {
  groupId: string;
  cursor?: string;
  limit?: number;
};

/** Wire strings become branded core IDs exactly once, at the RPC boundary. */
export function parseGroupArtifactListQuery(
  actor: Actor,
  input: GroupArtifactListInput,
): GroupPageQuery {
  return parseGroupPageQuery({
    actor: { kind: "user", userId: actor.userId, spaceId: actor.spaceId },
    groupId: input.groupId,
    cursor: input.cursor,
    limit: input.limit ?? 30,
  });
}

export function parseGroupPanelQuery(actor: Actor, groupId: string): GroupQuery {
  return parseGroupQuery({
    actor: { kind: "user", userId: actor.userId, spaceId: actor.spaceId },
    groupId,
  });
}

export function toWireArtifactPage(groupId: string, page: Page<ArtifactSummary>): ArtifactPage {
  return {
    items: page.items.map((item) => ({
      id: item.id,
      // The frozen group projection omits artifact authoring fields; keep the
      // wire contract's nullable slots without inventing values.
      botId: null,
      groupId,
      runId: null,
      name: item.name,
      description: item.description,
      mimeType: item.mimeType,
      size: item.size,
      version: item.version,
      versionCount: item.versionCount,
      createdAt: item.createdAt,
    })),
    nextCursor: page.nextCursor,
  };
}

export function toWireGroupRoutines(
  routines: readonly GroupRoutineSummary[],
): WireGroupRoutineSummary[] {
  return routines.map((routine) => ({
    ...routine,
    crons: [...routine.crons],
    executorBot: { ...routine.executorBot },
  }));
}

export function toWireGroupMembers(summary: GroupMembersSummary): GroupMembers {
  return {
    groupId: summary.groupId,
    threadId: summary.threadId,
    currentUser: { ...summary.currentUser },
    agents: summary.agents.map((agent) => ({ ...agent })),
    agentCount: summary.agentCount,
    memberCount: summary.memberCount,
  };
}
