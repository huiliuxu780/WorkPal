/** Backend-recorded entry path. It is not a claim that the content is true or authorized. */
export const MESSAGE_ORIGIN_KINDS = [
  "human_web",
  "human_messaging",
  "messaging_external",
  "webhook",
  "automation",
  "bot",
  "system",
  "unknown",
] as const;

export type MessageOriginKind = (typeof MESSAGE_ORIGIN_KINDS)[number];

export function isMessageOriginKind(value: string): value is MessageOriginKind {
  return (MESSAGE_ORIGIN_KINDS as readonly string[]).includes(value);
}

export type AgentHistoryProvenance =
  | { kind: "message"; originKind: MessageOriginKind; authorUserId?: string | null }
  | {
      kind: "application";
      contextKind: "compacted_summary" | "semantic_recall" | "durable_memory";
      generation: number;
      revision?: string;
    }
  | { kind: "unknown" };
