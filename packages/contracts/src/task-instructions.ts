import * as z from "zod";
import { Id } from "./ids.js";

/** The immutable first instruction a Task was created with. */
export const TaskInstructionOriginalSchema = z
  .object({
    content: z.string(),
    /** Present when the trusted creation path already persisted a source Message. */
    messageId: Id.optional(),
  })
  .strict();
export type TaskInstructionOriginal = z.infer<typeof TaskInstructionOriginalSchema>;

/** One server-ordered natural-language revision. `seq` is unique within the Task. */
export const TaskInstructionAmendmentSchema = z
  .object({
    messageId: Id,
    seq: z.number().int().positive(),
    content: z.string(),
  })
  .strict();
export type TaskInstructionAmendment = z.infer<typeof TaskInstructionAmendmentSchema>;

/**
 * Complete execution input for one Task. The original is permanent and always
 * consumes revision 1; each amendment adds exactly one revision. This mirrors
 * the frozen `parseTaskInstructionEnvelope` contract in @rakazo/core, including
 * `revision === amendments.length + 1`.
 */
export const TaskInstructionEnvelopeSchema = z
  .object({
    taskId: Id,
    revision: z.number().int().positive(),
    original: TaskInstructionOriginalSchema,
    amendments: z.array(TaskInstructionAmendmentSchema),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    if (envelope.revision !== envelope.amendments.length + 1) {
      ctx.addIssue({
        code: "custom",
        path: ["revision"],
        message: "must equal the original revision plus all amendments",
      });
    }
    envelope.amendments.forEach((amendment, index) => {
      const previous = envelope.amendments[index - 1];
      if (previous && amendment.seq <= previous.seq) {
        ctx.addIssue({
          code: "custom",
          path: ["amendments", index, "seq"],
          message: "amendments must be ordered by strictly increasing seq",
        });
      }
    });
  });
export type TaskInstructionEnvelope = z.infer<typeof TaskInstructionEnvelopeSchema>;

/** Proof of which envelope revision a Run read when execution started. */
export const RunInstructionRefSchema = z
  .object({
    taskId: Id,
    consumedRevision: z.number().int().positive(),
  })
  .strict();
export type RunInstructionRef = z.infer<typeof RunInstructionRefSchema>;

export const TaskAmendmentSourceSchema = z.enum(["explicit", "ask_answer", "choice_answer"]);
export type TaskAmendmentSource = z.infer<typeof TaskAmendmentSourceSchema>;
