import { createHash } from "node:crypto";

export interface AgentScopeChatSessionIdentity {
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  threadGeneration: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Stable identity for the two slots used by RuntimeEngine:
 * userSlot = sha256(userId NUL spaceId), sessionSlot = sha256(botId NUL threadId NUL generation).
 */
export function agentScopeChatSessionKey(input: AgentScopeChatSessionIdentity): string {
  if (!Number.isSafeInteger(input.threadGeneration) || input.threadGeneration < 0) {
    throw new Error("AgentScope chat session generation must be a non-negative safe integer");
  }
  const tenantSlot = sha256(`${input.userId}\0${input.spaceId}`);
  const sessionSlot = sha256(`${input.botId}\0${input.threadId}\0${input.threadGeneration}`);
  return `agentscope:chat:v1:${tenantSlot}:${sessionSlot}`;
}
