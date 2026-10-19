export const MANUAL_RETRY_PROMPT_FILE = "manual-retry-context.md";

const ORIGINAL_TOKEN = "{{originalTask}}";
const COMPLETED_TOKEN = "{{completedSection}}";

export type ManualRetryCompletedOp = {
  tool: string;
  summary: string;
};

export function renderManualRetryPrompt(
  template: string,
  input: {
    originalTask: string;
    completedOps?: readonly ManualRetryCompletedOp[];
  },
): string {
  const originalTask = input.originalTask.trim() || "(original task text is empty)";
  const completed = (input.completedOps ?? []).filter((op) => op.tool.trim());
  const completedSection =
    completed.length === 0
      ? "No confirmed completed external operations were recovered from the previous attempt."
      : `Completed operations from the previous attempt (reuse these real results; do not repeat the same external action):\n${completed
          .map((op) => `- ${op.tool}: ${op.summary.trim() || "completed"}`)
          .join("\n")}`;
  if (!template.includes(ORIGINAL_TOKEN) || !template.includes(COMPLETED_TOKEN)) {
    throw new Error("manual retry prompt template is missing required tokens");
  }
  return template
    .split(ORIGINAL_TOKEN)
    .join(originalTask)
    .split(COMPLETED_TOKEN)
    .join(completedSection)
    .trim();
}
