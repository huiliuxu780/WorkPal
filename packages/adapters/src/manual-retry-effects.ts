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

export type ManualRetryChain = Array<{ effects: ManualRetryChainEffect[] }>;

export async function loadManualRetryChain(
  prisma: PrismaClient,
  runId: string,
): Promise<ManualRetryChain> {
  const predecessorIds = await loadManualRetryPredecessorIds(prisma, runId);
  if (predecessorIds.length === 0) return [];
  const rows = await prisma.externalEffect.findMany({
    where: { runId: { in: predecessorIds } },
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
  return predecessorIds.map((id) => ({ effects: byRun.get(id) ?? [] }));
}

export function matchManualRetryEffect(
  chain: ManualRetryChain,
  tool: string,
  request: unknown,
  operationId?: string | null,
): ManualRetryEffectDecision {
  if (chain.length === 0) return { kind: "execute" };
  return decideManualRetryEffect({ tool, request, operationId, predecessors: chain });
}

export function manualRetryPromptPrefix(originalTask: string, chain: ManualRetryChain): string {
  return renderManualRetryPrompt({
    originalTask,
    operations: operationsForRetryPrompt(chain),
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
