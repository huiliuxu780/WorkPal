import {
  type ManualRetryChainEffect,
  type ManualRetryEffectDecision,
  renderManualRetryPrompt,
} from "@rakazo/core";
import {
  decideManualRetryEffect,
  operationsForRetryPrompt,
} from "@rakazo/core/node/manual-retry-match";
import { loadManualRetryPredecessorIds, type PrismaClient } from "@rakazo/db";

export type ManualRetryChain = {
  current: ManualRetryChainEffect[];
  predecessors: Array<{ effects: ManualRetryChainEffect[] }>;
};

export function emptyManualRetryChain(): ManualRetryChain {
  return { current: [], predecessors: [] };
}

export function rememberCurrentRetryEffect(
  chain: ManualRetryChain,
  effect: {
    id: string;
    runId?: string;
    kind: string;
    status: string;
    request: unknown;
    result?: unknown;
    reviewDecision?: string | null;
    createdAt?: Date;
    operationId?: string | null;
  },
) {
  const mapped: ManualRetryChainEffect = {
    id: effect.id,
    runId: effect.runId ?? "",
    kind: effect.kind,
    status: effect.status,
    request: effect.request,
    result: effect.result ?? null,
    reviewDecision: effect.reviewDecision ?? null,
    createdAt: effect.createdAt ?? new Date(),
    operationId: effect.operationId ?? effect.id,
  };
  const index = chain.current.findIndex((row) => row.id === mapped.id);
  if (index >= 0) chain.current[index] = { ...chain.current[index]!, ...mapped };
  else chain.current.push(mapped);
}

export async function loadManualRetryChain(
  prisma: PrismaClient,
  runId: string,
): Promise<ManualRetryChain> {
  const predecessorIds = await loadManualRetryPredecessorIds(prisma, runId);
  const runIds = [runId, ...predecessorIds];
  const rows = await prisma.externalEffect.findMany({
    where: { runId: { in: runIds } },
    select: {
      id: true,
      runId: true,
      kind: true,
      status: true,
      request: true,
      result: true,
      reviewDecision: true,
      createdAt: true,
      operationId: true,
    },
  });
  const byRun = new Map<string, ManualRetryChainEffect[]>();
  for (const row of rows) {
    const list = byRun.get(row.runId) ?? [];
    list.push(row);
    byRun.set(row.runId, list);
  }
  return {
    current: byRun.get(runId) ?? [],
    predecessors: predecessorIds.map((id) => ({ effects: byRun.get(id) ?? [] })),
  };
}

export function matchManualRetryEffect(
  chain: ManualRetryChain,
  tool: string,
  request: unknown,
  operationId?: string | null,
): ManualRetryEffectDecision {
  return decideManualRetryEffect({
    tool,
    request,
    operationId,
    current: chain.current,
    predecessors: chain.predecessors,
  });
}

export function manualRetryPromptPrefix(originalTask: string, chain: ManualRetryChain): string {
  return renderManualRetryPrompt({
    originalTask,
    operations: operationsForRetryPrompt(chain.predecessors),
  });
}

export const MANUAL_RETRY_UNCERTAIN_ACTIONS = [
  { id: "confirm_completed", label: "It already completed" },
  { id: "authorize_retry", label: "Try this operation again" },
  { id: "cancel", label: "Skip this operation" },
] as const;

export function manualRetryUncertainAsk(toolName: string, sourceEffectId: string) {
  return {
    text: `The previous attempt of ${toolName} did not record a confirmed result. How should this retry handle it?`,
    detail: `This choice applies only to ${toolName}.`,
    sourceEffectId,
    actions: MANUAL_RETRY_UNCERTAIN_ACTIONS.map((action) => ({ ...action })),
  };
}
