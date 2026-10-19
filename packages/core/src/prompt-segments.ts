import { PROMPT_TEXTS, type PromptSegmentId } from "./prompt-texts.generated.js";

/**
 * AG-04 segment rendering.
 *
 * Fixed prompt bodies live in /prompts (one Markdown file per segment, ID =
 * path without extension) and are inlined into `prompt-texts.generated.ts`.
 * This function only fills `{{key}}` placeholders from typed callers:
 *
 * - Single pass over the TEMPLATE: dynamic values are inserted verbatim and
 *   are never re-scanned, so a value containing `{{...}}`, `${...}`, quotes,
 *   newlines or XML tags stays inert data (AG-04 acceptance #5).
 * - A placeholder without a supplied variable is a programming error, not an
 *   empty string.
 * - No template language, conditionals or nesting exists by design; the
 *   conditional selection and assembly logic stays in the typed callers.
 */
export function renderPromptSegment(
  id: PromptSegmentId,
  vars: Record<string, string> = {},
): string {
  const template: string = PROMPT_TEXTS[id];
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : undefined;
    if (value === undefined) {
      throw new Error(`prompt segment ${id} requires variable ${key}`);
    }
    return value;
  });
}

/** The fixed body of one segment, with no placeholder rendering. */
export function promptSegment(id: PromptSegmentId): string {
  return PROMPT_TEXTS[id];
}
