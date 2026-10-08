import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { EncryptedSecretStore } from "@rakazo/adapters";
import { runGroupRouter } from "@rakazo/adapters";
import {
  resolveExplicitTurnOwner,
  selectGroupLead,
  type GroupRouterReasonCode,
  type ResponseMode,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { resolveAuxJudgeModel } from "./team-chat-judge.js";

/**
 * Product Harness Phase 1 — Turn Routing.
 *
 * Resolves "who answers" for one group user turn, in strict precedence:
 * explicit mention > reply target > Group Router (only model call, only when
 * nothing explicit) > group lead. Runs before the send transaction: the
 * serializable retry may re-run the transaction body, and a re-routed retry
 * would make ownership unpredictable — so the router answer is computed once
 * and re-validated (not re-consulted) inside the transaction.
 */

export type GroupTurnPreRouting = {
  routeKind: "group_router" | "fallback_lead";
  ownerBotIds: string[];
  responseMode: ResponseMode;
  reasonCode: GroupRouterReasonCode;
};

export type TurnRoutingProvider = {
  /** Returns null when explicit targeting resolves the owner deterministically
   *  (the transaction path owns that) or when no group members are available. */
  preRoute(input: {
    spaceId: string;
    userId: string;
    groupId: string;
    threadId: string;
    text: string;
    explicitMentionIds: readonly string[];
    replyToMessageId?: string;
  }): Promise<GroupTurnPreRouting | null>;
};

export function createTurnRoutingProvider(deps: {
  prisma: PrismaClient;
  runtime?: AgentRuntime;
  secrets: EncryptedSecretStore;
  deploymentProvider: string;
  deploymentModel: string;
  deploymentModelKey?: string;
  routerTimeoutMs?: number;
}): TurnRoutingProvider {
  return {
    async preRoute(input) {
      const group = await deps.prisma.chatGroup.findFirst({
        where: {
          id: input.groupId,
          spaceId: input.spaceId,
          userId: input.userId,
          archivedAt: null,
          thread: { id: input.threadId },
        },
        include: {
          members: {
            where: { bot: { archivedAt: null } },
            include: {
              bot: {
                select: {
                  id: true,
                  name: true,
                  title: true,
                  description: true,
                  userId: true,
                  spaceId: true,
                  modelProvider: true,
                  modelId: true,
                },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      });
      if (!group || group.members.length === 0) return null;
      const members = group.members.map((member) => member.bot);

      let replyTargetBotId: string | null = null;
      if (input.replyToMessageId) {
        const reply = await deps.prisma.message.findFirst({
          where: { id: input.replyToMessageId, threadId: input.threadId },
          select: { role: true, botId: true },
        });
        if (reply && reply.role === "bot" && reply.botId) replyTargetBotId = reply.botId;
      }

      // Explicit targets belong to the transaction path (authoritative against
      // locked membership) — no router call, no model spend.
      const explicit = resolveExplicitTurnOwner({
        text: input.text,
        members: members.map((member) => ({ id: member.id, name: member.name })),
        explicitMentionIds: input.explicitMentionIds,
        replyTargetBotId,
      });
      if (!("unresolved" in explicit)) return null;

      const lead = selectGroupLead(
        group.leadBotId,
        members.map((member) => member.id),
      );
      if (!lead) return null;
      let routed: GroupTurnPreRouting = {
        routeKind: "fallback_lead",
        ownerBotIds: [lead.botId],
        responseMode: "single",
        reasonCode: "fallback_lead",
      };
      if (!deps.runtime) return routed;

      // Isolated auxiliary execution: the router resolves its model against
      // the lead bot (its deployment-level default), sends no tools, no
      // skills, no history, and never touches the chat session. Any failure
      // — unresolved model, timeout, malformed JSON, invented id — falls
      // through to the lead. A routing failure must never cost the send.
      try {
        const leadBot = members.find((member) => member.id === lead.botId) ?? members[0]!;
        const resolved = await resolveAuxJudgeModel(deps, leadBot);
        if (resolved) {
          const decision = await runGroupRouter({
            config: { runtime: deps.runtime, model: resolved.model, timeoutMs: deps.routerTimeoutMs },
            routing: {
              message: input.text,
              members,
              leadBotId: lead.botId,
            },
            identity: { spaceId: input.spaceId, userId: input.userId, botId: leadBot.id },
          });
          if (decision) {
            routed = {
              routeKind: "group_router",
              ownerBotIds: [decision.ownerBotId],
              responseMode: "single",
              reasonCode: decision.reasonCode,
            };
          }
        }
      } catch (error) {
        getLogger().error("group turn routing failed", error);
      }
      return routed;
    },
  };
}
