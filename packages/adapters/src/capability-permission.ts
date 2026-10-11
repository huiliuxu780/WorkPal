import {
  capabilityResourcesForTool,
  parseCapabilityRules,
  resolveCapabilityRule,
  type CapabilityDecision,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** Check the current Bot policy at the same boundary as action approval. */
export async function evaluateBotToolCapability(
  prisma: PrismaClient,
  botId: string,
  toolName: string,
  args: Record<string, unknown>,
  routeResourceId?: string,
): Promise<{ decision: CapabilityDecision | null; error?: string }> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { capabilityRules: true, archivedAt: true },
  });
  if (!bot || bot.archivedAt) return { decision: "deny", error: "Bot is no longer active." };
  try {
    const rules = parseCapabilityRules(bot.capabilityRules);
    const decisions = capabilityResourcesForTool(args, routeResourceId).map((resource) =>
      resolveCapabilityRule({ capability: toolName, resource, rules }).decision,
    );
    const decision = decisions.includes("deny")
      ? "deny"
      : decisions.includes("ask")
        ? "ask"
        : decisions.includes("allow")
          ? "allow"
          : null;
    return { decision };
  } catch {
    return { decision: "deny", error: "Bot capability rules are invalid; tool execution is blocked." };
  }
}
