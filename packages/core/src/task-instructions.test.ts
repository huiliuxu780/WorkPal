import type { TaskInstructionEnvelope } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { formatTaskInstructionEnvelope } from "./task-instructions.js";

function envelope(overrides: Partial<TaskInstructionEnvelope> = {}): TaskInstructionEnvelope {
  return {
    taskId: "task-1",
    revision: 1,
    original: { content: "Original instructions" },
    amendments: [],
    ...overrides,
  };
}

describe("formatTaskInstructionEnvelope", () => {
  it("renders the unamended revision 1 byte-identical to the original prompt", () => {
    expect(formatTaskInstructionEnvelope(envelope())).toBe("Original instructions");
  });

  it("labels the original and sorts amendments by server seq", () => {
    const formatted = formatTaskInstructionEnvelope(
      envelope({
        revision: 3,
        amendments: [
          { messageId: "message-2", seq: 2, content: "Second amendment" },
          { messageId: "message-1", seq: 1, content: "First amendment" },
        ],
      }),
    );
    expect(formatted).toContain("Task instruction revision 3.");
    expect(formatted).toContain("Original instructions");
    expect(formatted.indexOf("[amendment 1]")).toBeLessThan(formatted.indexOf("[amendment 2]"));
    expect(formatted.indexOf("First amendment")).toBeLessThan(
      formatted.indexOf("Second amendment"),
    );
  });

  it("rejects an envelope whose revision does not count every amendment", () => {
    expect(() => formatTaskInstructionEnvelope(envelope({ revision: 3 }))).toThrow(
      /envelope task-1 is incomplete/,
    );
  });
});
