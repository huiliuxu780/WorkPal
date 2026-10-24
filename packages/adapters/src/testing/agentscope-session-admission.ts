import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { agentScopeChatSessionKey } from "@rakazo/core/node/session-admission";

export function withAgentScopeTestAdmission(
  request: AgentRunRequest,
  identity: Readonly<{ userId: string; spaceId: string }>,
): AgentRunRequest {
  if ((request.executionScope ?? "chat") !== "chat" || request.sessionAdmission) return request;
  return {
    ...request,
    sessionAdmission: {
      sessionKey: agentScopeChatSessionKey({
        userId: identity.userId,
        spaceId: identity.spaceId,
        botId: request.botId,
        threadId: request.threadId,
        threadGeneration: request.sessionGeneration ?? 0,
      }),
      executionId: `execution-${request.runId}`,
      attemptId: `attempt-${request.runId}`,
      fence: 1,
      suspensionKey: `suspension-${request.runId}`,
    },
  };
}
