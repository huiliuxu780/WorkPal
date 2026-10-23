import { describe, expect, it } from "vitest";
import { RunInstructionRefSchema, TaskInstructionEnvelopeSchema } from "./task-instructions.js";

const originalOnly = {
  taskId: "task-1",
  revision: 1,
  original: { content: "Original task" },
  amendments: [],
};

const amended = {
  taskId: "task-1",
  revision: 2,
  original: { content: "Original task" },
  amendments: [{ messageId: "message-1", seq: 1, content: "Amended task" }],
};

describe("TaskInstructionEnvelopeSchema", () => {
  it("accepts revision 1 with only the original and revision 2 with one amendment", () => {
    expect(TaskInstructionEnvelopeSchema.parse(originalOnly)).toEqual(originalOnly);
    expect(TaskInstructionEnvelopeSchema.parse(amended)).toEqual(amended);
  });

  it("rejects revision 0 and a revision that does not count every amendment", () => {
    expect(TaskInstructionEnvelopeSchema.safeParse({ ...originalOnly, revision: 0 }).success).toBe(
      false,
    );
    expect(TaskInstructionEnvelopeSchema.safeParse({ ...amended, revision: 3 }).success).toBe(
      false,
    );
  });

  it("rejects amendments that are not strictly ordered by seq", () => {
    expect(
      TaskInstructionEnvelopeSchema.safeParse({
        ...amended,
        revision: 3,
        amendments: [
          { messageId: "message-2", seq: 2, content: "Second" },
          { messageId: "message-1", seq: 1, content: "First" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("RunInstructionRefSchema", () => {
  it("requires a consumed revision of at least 1", () => {
    expect(
      RunInstructionRefSchema.safeParse({ taskId: "task-1", consumedRevision: 1 }).success,
    ).toBe(true);
    expect(
      RunInstructionRefSchema.safeParse({ taskId: "task-1", consumedRevision: 0 }).success,
    ).toBe(false);
  });
});
