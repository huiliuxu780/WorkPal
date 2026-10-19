import { describe, expect, it } from "vitest";
import { MANUAL_RETRY_PROMPT_FILE, renderManualRetryPrompt } from "./manual-retry-prompt.js";
import { loadPromptFile } from "./node/prompt-file.js";

describe("renderManualRetryPrompt", () => {
  it("renders the shipped template with the original task and completed ops", () => {
    const template = loadPromptFile(MANUAL_RETRY_PROMPT_FILE);
    const text = renderManualRetryPrompt(template, {
      originalTask: "Send the weekly report to Ada",
      completedOps: [{ tool: "send_email", summary: '{"id":"msg-1"}' }],
    });
    expect(text).toContain("manual retry");
    expect(text).toContain("Send the weekly report to Ada");
    expect(text).toContain("send_email");
    expect(text).toContain("msg-1");
    expect(text).not.toContain("{{originalTask}}");
  });

  it("states when no completed operations were recovered", () => {
    const template = loadPromptFile(MANUAL_RETRY_PROMPT_FILE);
    const text = renderManualRetryPrompt(template, { originalTask: "Draft a note" });
    expect(text).toContain("No confirmed completed external operations");
  });

  it("rejects a prompt path that leaves the prompts directory", () => {
    expect(() => loadPromptFile("../package.json")).toThrow(/escapes/);
  });
});
