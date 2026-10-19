import type { ManualRetryPromptOp } from "./node/manual-retry-match.js";
import { renderPromptSegment } from "./prompt-segments.js";

export const MANUAL_RETRY_PROMPT_SEGMENT = "retry/manual-retry-context" as const;

function formatOperationSection(operations: readonly ManualRetryPromptOp[]): string {
  if (operations.length === 0) {
    return "No prior external operations were recovered from the previous attempt. Start new work with the original task. Omit retryOperationId.";
  }
  const lines = operations.map((op) => {
    const summary = op.summary.trim() || op.status;
    return `- retryOperationId=${op.operationId} (${op.tool}, ${op.status}): ${summary}`;
  });
  return `Prior operations in this retry chain. Continue one by passing retryOperationId in the tool arguments with that exact id. Omit retryOperationId only to start a new independent operation.\n${lines.join("\n")}`;
}

export function renderManualRetryPrompt(input: {
  originalTask: string;
  operations?: readonly ManualRetryPromptOp[];
}): string {
  const originalTask = input.originalTask.trim() || "(original task text is empty)";
  return renderPromptSegment(MANUAL_RETRY_PROMPT_SEGMENT, {
    originalTask,
    operationSection: formatOperationSection(input.operations ?? []),
  }).trim();
}
