import type { TaskInstructionEnvelope } from "@rakazo/contracts";

/**
 * The single execution-input rendering of a Task envelope. Revision 1 renders
 * exactly the original prompt so unamended Tasks and existing model input stay
 * byte-identical; amended Tasks label the original and each server-ordered
 * revision explicitly. An incomplete envelope must fail rather than run a
 * silently truncated instruction.
 */
export function formatTaskInstructionEnvelope(envelope: TaskInstructionEnvelope): string {
  if (envelope.revision !== envelope.amendments.length + 1) {
    throw new Error(
      `Task instruction envelope ${envelope.taskId} is incomplete: revision ${envelope.revision} has ${envelope.amendments.length} amendments`,
    );
  }
  if (envelope.revision === 1) return envelope.original.content;

  const original = envelope.original.content.trim() || "(original task instruction is empty)";
  const amendments = [...envelope.amendments].sort((left, right) => left.seq - right.seq);
  return [
    `Task instruction revision ${envelope.revision}.`,
    "Original instruction:",
    original,
    "Server-ordered amendments:",
    amendments
      .map(
        (amendment) =>
          `[amendment ${amendment.seq}]\n${amendment.content.trim() || "(empty amendment)"}`,
      )
      .join("\n\n"),
  ].join("\n\n");
}
