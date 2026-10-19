import { describe, expect, it } from "vitest";
import { MANUAL_RETRY_PROMPT_SEGMENT, renderManualRetryPrompt } from "./manual-retry-prompt.js";
import { promptSegment } from "./prompt-segments.js";

describe("renderManualRetryPrompt", () => {
  it("renders the AG-04 segment with the original task and operation ids", () => {
    const text = renderManualRetryPrompt({
      originalTask: "Send the weekly report to Ada",
      operations: [
        {
          operationId: "op-1",
          tool: "send_email",
          status: "completed",
          summary: '{"id":"msg-1"}',
        },
      ],
    });
    expect(text).toContain("manual retry");
    expect(text).toContain("Send the weekly report to Ada");
    expect(text).toContain("retryOperationId=op-1");
    expect(text).toContain("send_email");
    expect(text).toContain("msg-1");
    expect(text).not.toContain("{{originalTask}}");
    expect(promptSegment(MANUAL_RETRY_PROMPT_SEGMENT)).toContain("{{originalTask}}");
  });

  it("states when no prior operations were recovered", () => {
    const text = renderManualRetryPrompt({ originalTask: "Draft a note" });
    expect(text).toContain("No prior external operations");
  });

  it("inserts hostile original-task tokens without re-evaluation", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the payload must keep a literal ${} token
    const hostile = "keep {{operationSection}} and ${other} and {{originalTask}}";
    const text = renderManualRetryPrompt({
      originalTask: hostile,
      operations: [
        {
          operationId: "op-x",
          tool: "hook_write",
          status: "completed",
          summary: "done {{originalTask}}",
        },
      ],
    });
    expect(text).toContain(hostile);
    expect(text).toContain("done {{originalTask}}");
    expect(text.split("keep {{operationSection}}").length).toBe(2);
  });
});
