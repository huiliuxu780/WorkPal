import type { DisplayBlock, MessageBlock } from "@rakazo/contracts";
import { cloudAgentBlockFromPayload, cloudAgentHttpsUrl } from "./cloud-agent.js";

/** Remove this run's live message and obsolete unscoped progress without reordering history. */
export function takeLiveMessage<Message extends { id: string; runId?: string | null }>(
  messages: readonly Message[],
  liveId: string,
): { previous: Message | undefined; remaining: Message[] } {
  let previous: Message | undefined;
  const remaining: Message[] = [];
  for (const message of messages) {
    if (message.id === liveId) previous = message;
    else if (!message.id.startsWith("progress:") || message.runId) remaining.push(message);
  }
  return { previous, remaining };
}

export function updateCloudAgentMessages<Message extends { id: string; blocks: MessageBlock[] }>(
  messages: readonly Message[],
  payload: Record<string, unknown>,
): Message[] {
  const agentId = String(payload.agentId ?? "");
  const messageId = String(payload.messageId ?? "");
  const block = cloudAgentBlockFromPayload(payload);
  return messages.map((message) => {
    if (
      (messageId && message.id === messageId) ||
      message.blocks.some(
        (existing) => existing.kind === "cloud_agent" && existing.agentId === agentId,
      )
    ) {
      return {
        ...message,
        blocks: message.blocks.map((existing) =>
          existing.kind === "cloud_agent" && existing.agentId === agentId ? block : existing,
        ),
      };
    }
    return message;
  });
}

const CLOUD_AGENT_TASK_STATUS = {
  running: "running",
  finished: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/**
 * Live cloud-agent events replace the legacy block in place but arrive
 * without a server re-projection, so the task_status card anchored to the
 * same block index would keep showing the old status and destination.
 * Rebuild those projections from the updated blocks; untouched blocks and
 * other kinds are returned unchanged.
 */
export function reconcileCloudAgentDisplayBlocks<
  Message extends { id: string; threadId: string; runId?: string | null; blocks: MessageBlock[] },
>(
  messages: readonly Message[],
  displayBlocks: DisplayBlock[] | undefined,
): DisplayBlock[] | undefined {
  if (!displayBlocks || displayBlocks.length === 0) return displayBlocks;
  const rebuilt = new Map<string, Extract<DisplayBlock, { kind: "task_status" }>>();
  for (const message of messages) {
    message.blocks.forEach((block, index) => {
      if (block.kind !== "cloud_agent") return;
      rebuilt.set(`${message.id}:${index}:task_status`, {
        kind: "task_status",
        blockId: `${message.id}:${index}:task_status`,
        status: CLOUD_AGENT_TASK_STATUS[block.status],
        title: block.title,
        summary: null,
        destination: cloudAgentHttpsUrl(block.prUrl) ?? cloudAgentHttpsUrl(block.url) ?? null,
        source: {
          threadId: message.threadId,
          messageId: message.id,
          runId: message.runId ?? null,
        },
      });
    });
  }
  if (rebuilt.size === 0) return displayBlocks;
  return displayBlocks.map((block) => rebuilt.get(block.blockId) ?? block);
}
