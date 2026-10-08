import type { AgentRunModel, AgentRuntime } from "@rakazo/adapter-kit";
import type { EncryptedSecretStore } from "@rakazo/adapters";
import { runGroupRouter } from "@rakazo/adapters";
import {
  resolveExplicitTurnOwner,
  selectGroupLead,
  type GroupRouterReasonCode,
  type ResponseMode,
} from "@rakazo/core";
import { findModelCredential, type PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { resolveAuxJudgeModel, type AuxJudgeModelBot } from "./team-chat-judge.js";

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
  /** PRODUCT_HARNESS_ROUTER_MODEL ("provider/model") — priority 1 for routing. */
  routerModel?: string;
  /** PRODUCT_HARNESS_ROUTER_API_KEY — only needed for a remote router provider. */
  routerApiKey?: string;
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

      // Isolated auxiliary execution: the router resolves its model through
      // the ProductHarnessModelResolver priority chain (configured harness
      // model → deployment/default chain → lead), sends no tools, no skills,
      // no history, and never touches the chat session. Any failure —
      // unresolved model, timeout, malformed JSON, invented id — falls
      // through to the lead. A routing failure must never cost the send.
      try {
        const leadBot = members.find((member) => member.id === lead.botId) ?? members[0]!;
        const model = await resolveTurnRoutingModel(deps, leadBot);
        if (model) {
          const decision = await runGroupRouter({
            config: {
              runtime: deps.runtime,
              model,
              timeoutMs: deps.routerTimeoutMs,
              // Router tokens are real model spend: persist them through the
              // same usage accounting path normal runs and the engagement
              // judge use, or group-chat cost is systematically underreported.
              onUsage: async (usage) => {
                await deps.prisma.usageRecord
                  .create({
                    data: {
                      spaceId: input.spaceId,
                      botId: leadBot.id,
                      userId: input.userId,
                      provider: usage.provider,
                      model: usage.model,
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                      cacheReadTokens: usage.cacheReadTokens,
                      cacheWriteTokens: usage.cacheWriteTokens,
                    },
                  })
                  .catch((error) => getLogger().error("group router usage record", error));
              },
            },
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

/**
 * ProductHarnessModelResolver (Product Harness Phase 2, B11). Priority:
 *   1. PRODUCT_HARNESS_ROUTER_MODEL ("provider/model"), usable through its
 *      explicit key, a deployment-key match, or the lead space's connection
 *      for that provider;
 *   2. the deployment default model (with its key);
 *   3. the group lead's model connection via the shared auxiliary chain;
 *   4. null — the caller then routes deterministically to the lead.
 * Model selection must never change ownership semantics.
 */
export type TurnRoutingModelDeps = {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  deploymentProvider: string;
  deploymentModel: string;
  deploymentModelKey?: string;
  routerModel?: string;
  routerApiKey?: string;
};

export function parseProductHarnessRouterModel(
  value: string | undefined | null,
): { provider: string; id: string } | null {
  if (!value) return null;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return null;
  const provider = value.slice(0, separator).trim();
  const id = value.slice(separator + 1).trim();
  if (!provider || !id) return null;
  return { provider, id };
}

/**
 * The AgentScope runtime rejects subscription OAuth models before the request
 * is sent, so an OAuth result is unusable for routing: the priority chain
 * must continue to the next source instead of silently failing the model call.
 */
export function usableRouterModel(
  model: AgentRunModel | null | undefined,
): AgentRunModel | null {
  return model && !model.oauth ? model : null;
}

export async function resolveTurnRoutingModel(
  deps: TurnRoutingModelDeps,
  leadBot: AuxJudgeModelBot,
): Promise<AgentRunModel | null> {
  const configured = parseProductHarnessRouterModel(deps.routerModel);
  if (configured) {
    if (deps.routerApiKey) {
      return { provider: configured.provider, id: configured.id, apiKey: deps.routerApiKey };
    }
    if (configured.provider === deps.deploymentProvider && deps.deploymentModelKey) {
      return {
        provider: configured.provider,
        id: configured.id,
        apiKey: deps.deploymentModelKey,
      };
    }
    const credential = await findModelCredential(deps.prisma, {
      userId: leadBot.userId,
      spaceId: leadBot.spaceId,
    }, configured.provider).catch(() => null);
    if (credential) {
      // Decrypt through the shared auxiliary path (oauth/rotation intact).
      const overrideDeps = {
        ...deps,
        providerOverride: configured.provider,
        modelOverride: configured.id,
      };
      const resolved = await resolveAuxJudgeModel(overrideDeps, leadBot);
      const usable = usableRouterModel(resolved?.model);
      if (usable) return usable;
    }
    // An unusable configured model (missing key or OAuth-backed) must not
    // break routing nor short-circuit the chain; fall through.
  }

  if (deps.deploymentProvider && deps.deploymentModel && deps.deploymentModelKey) {
    return {
      provider: deps.deploymentProvider,
      id: deps.deploymentModel,
      apiKey: deps.deploymentModelKey,
    };
  }

  const resolved = await resolveAuxJudgeModel(deps, leadBot);
  return usableRouterModel(resolved?.model);
}
