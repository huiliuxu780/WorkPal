import type { ActivityItem, ExecutionSummary, Run, ThreadMessage } from "@rakazo/contracts";

export type PublicDelegationStatus = Readonly<{
  kind: "queued" | "running" | "completed" | "failed" | "cancelled";
  detail?: string;
}>;

export type PublicDelegationDelivery = Readonly<{
  messageId: string;
  targetBotId: string;
  targetFallbackName: string;
  targetRunId: string;
  text: string;
  status: PublicDelegationStatus;
}>;

export type PublicDelegationGroup = Readonly<{
  sourceRunId: string;
  senderBotId: string;
  senderFallbackName: string;
  firstMessageId: string;
  messageIds: readonly string[];
  deliveries: readonly PublicDelegationDelivery[];
}>;

export type PublicDelegationProjection = Readonly<{
  groupsByFirstMessageId: ReadonlyMap<string, PublicDelegationGroup>;
  hiddenMessageIds: ReadonlySet<string>;
}>;

type PublicCollaborationFacts = Readonly<{
  runs: readonly Run[];
  executions?: readonly ExecutionSummary[];
  activity?: readonly ActivityItem[];
}>;

type Outbound = Readonly<{
  message: ThreadMessage;
  block: Extract<ThreadMessage["blocks"][number], { kind: "bot_message_sent" }>;
  sourceRunId: string;
  senderBotId: string;
}>;

type Inbound = Readonly<{
  message: ThreadMessage;
  block: Extract<ThreadMessage["blocks"][number], { kind: "bot_message_received" }>;
  targetRunId: string;
}>;

function outboundOf(message: ThreadMessage): Outbound | undefined {
  if (!message.runId || !message.botId) return undefined;
  const block = message.blocks.find(
    (
      candidate,
    ): candidate is Extract<ThreadMessage["blocks"][number], { kind: "bot_message_sent" }> =>
      candidate.kind === "bot_message_sent",
  );
  if (!block) return undefined;
  return {
    message,
    block,
    sourceRunId: message.runId,
    senderBotId: message.botId,
  };
}

function inboundOf(message: ThreadMessage): Inbound | undefined {
  if (!message.runId) return undefined;
  const block = message.blocks.find(
    (
      candidate,
    ): candidate is Extract<ThreadMessage["blocks"][number], { kind: "bot_message_received" }> =>
      candidate.kind === "bot_message_received" && Boolean(candidate.returnToMessageId),
  );
  if (!block?.returnToMessageId) return undefined;
  return { message, block, targetRunId: message.runId };
}

function statusFromRunStatus(
  status: Run["status"] | ExecutionSummary["status"],
  detail?: string,
): PublicDelegationStatus {
  switch (status) {
    case "queued":
      return { kind: "queued" };
    case "leased":
    case "running":
    case "waiting_input":
    case "waiting_takeover":
      return { kind: "running" };
    case "completed":
      return { kind: "completed" };
    case "failed":
      return detail ? { kind: "failed", detail } : { kind: "failed" };
    case "cancelled":
      return { kind: "cancelled" };
  }
}

function terminalActivityStatus(
  item: ActivityItem | undefined,
): PublicDelegationStatus | undefined {
  if (!item) return undefined;
  if (item.status === "completed") return { kind: "completed" };
  if (item.status === "failed") {
    return item.detail ? { kind: "failed", detail: item.detail } : { kind: "failed" };
  }
  if (item.status === "cancelled") return { kind: "cancelled" };
  return undefined;
}

/** Resolve one target delivery from durable Run facts without aggregating sibling outcomes. */
export function publicDelegationStatus(
  targetRunId: string,
  facts: PublicCollaborationFacts,
): PublicDelegationStatus {
  const run = facts.runs.find((candidate) => candidate.id === targetRunId);
  if (run && ["completed", "failed", "cancelled"].includes(run.status)) {
    return statusFromRunStatus(run.status, run.error ?? undefined);
  }

  const runActivity = facts.activity?.find((item) => item.id === `run:${targetRunId}`);
  const terminalActivity = terminalActivityStatus(runActivity);
  if (terminalActivity) return terminalActivity;

  const execution = facts.executions?.find((candidate) => candidate.runId === targetRunId);
  if (execution && ["completed", "failed", "cancelled"].includes(execution.status)) {
    return statusFromRunStatus(execution.status, execution.failure);
  }
  if (run) return statusFromRunStatus(run.status, run.error ?? undefined);
  if (execution) return statusFromRunStatus(execution.status, execution.failure);
  if (runActivity?.status === "running" || runActivity?.status === "waiting") {
    return { kind: "running" };
  }
  const collaboration = facts.activity?.find((item) => item.id === `collab:${targetRunId}`);
  if (collaboration?.status === "running" || collaboration?.status === "waiting") {
    return { kind: "running" };
  }

  // The public-delivery transaction creates the target Run as queued before
  // either Message becomes visible. Missing bounded status projections can
  // therefore fall back to the only state proven by the paired Messages.
  return { kind: "queued" };
}

/**
 * Project public group deliveries for display only.
 *
 * Pairing uses the persisted returnToMessageId relation. Visual grouping then
 * joins only adjacent deliveries with the same source Run and sender. Inbound
 * wake Messages are hidden because the outbound row already exposes the same
 * public body; their target Run ids remain attached to each delivery.
 */
export function projectPublicDelegations(
  messages: readonly ThreadMessage[],
  facts: PublicCollaborationFacts,
): PublicDelegationProjection {
  const inboundByOutboundId = new Map<string, Inbound>();
  for (const message of messages) {
    const inbound = inboundOf(message);
    if (inbound?.block.returnToMessageId) {
      inboundByOutboundId.set(inbound.block.returnToMessageId, inbound);
    }
  }

  const groups: PublicDelegationGroup[] = [];
  const hiddenMessageIds = new Set<string>();
  let current: {
    sourceRunId: string;
    senderBotId: string;
    senderFallbackName: string;
    firstMessageId: string;
    messageIds: string[];
    deliveries: PublicDelegationDelivery[];
  } | null = null;

  for (const message of messages) {
    const inbound = inboundOf(message);
    if (inbound) {
      hiddenMessageIds.add(message.id);
      continue;
    }

    const outbound = outboundOf(message);
    const pairedInbound = outbound ? inboundByOutboundId.get(message.id) : undefined;
    if (!outbound) {
      current = null;
      continue;
    }
    if (!pairedInbound) {
      // A bounded page can split the atomic outbound/inbound record pair. Do
      // not fall through to the private-receipt component while the target Run
      // relation is unavailable; a later history page can complete the pair.
      hiddenMessageIds.add(message.id);
      current = null;
      continue;
    }

    const delivery: PublicDelegationDelivery = {
      messageId: message.id,
      targetBotId: outbound.block.toBotId,
      targetFallbackName: outbound.block.toBotName,
      targetRunId: pairedInbound.targetRunId,
      text: outbound.block.text,
      status: publicDelegationStatus(pairedInbound.targetRunId, facts),
    };
    const sameVisualGroup =
      current?.sourceRunId === outbound.sourceRunId && current.senderBotId === outbound.senderBotId;

    if (current && sameVisualGroup) {
      current.messageIds.push(message.id, pairedInbound.message.id);
      current.deliveries.push(delivery);
      hiddenMessageIds.add(message.id);
      continue;
    }

    current = {
      sourceRunId: outbound.sourceRunId,
      senderBotId: outbound.senderBotId,
      senderFallbackName: pairedInbound.block.fromBotName,
      firstMessageId: message.id,
      messageIds: [message.id, pairedInbound.message.id],
      deliveries: [delivery],
    };
    groups.push(current);
  }

  return {
    groupsByFirstMessageId: new Map(groups.map((group) => [group.firstMessageId, group])),
    hiddenMessageIds,
  };
}
