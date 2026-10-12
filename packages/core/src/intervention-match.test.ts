import { describe, expect, it } from "vitest";
import { matchFreeTextFromSnapshot, matchFreeTextIntervention } from "./intervention-match.js";

const text = {
  id: "input-1",
  status: "pending",
  kind: "input",
  runId: "run-1",
  messageId: "message-1",
  input: { mode: "text" },
};

describe("free-text intervention matching", () => {
  it("answers the only ordinary text input", () => {
    expect(matchFreeTextIntervention([text])).toEqual({
      action: "answer",
      interventionId: "input-1",
      runId: "run-1",
      messageId: "message-1",
    });
  });

  it("does not guess among several text inputs or auto-submit protected asks", () => {
    expect(matchFreeTextIntervention([text, { ...text, id: "input-2", runId: "run-2" }])).toEqual({
      action: "refuse",
      reason: "ambiguous",
    });
    expect(
      matchFreeTextIntervention([{ ...text, id: "secret-1", input: { mode: "secret" } }]),
    ).toEqual({ action: "refuse", reason: "secret" });
    expect(matchFreeTextIntervention([{ ...text, id: "approval-1", kind: "approval", input: undefined }])).toEqual({
      action: "refuse",
      reason: "approval",
    });
    expect(
      matchFreeTextIntervention([{ ...text, id: "choice-1", input: { mode: "choice" } }]),
    ).toEqual({ action: "refuse", reason: "choice" });
  });

  it("uses the projection and does not scan messages when it is present", () => {
    expect(
      matchFreeTextFromSnapshot({
        interventions: [],
        messages: [
          {
            id: "message-1",
            runId: "run-1",
            blocks: [{ kind: "ask", status: "pending" }],
          },
        ],
        run: { id: "run-1", status: "waiting_input" },
      }),
    ).toEqual({ action: "none" });
  });

  it("derives every pending ask when the projection is absent", () => {
    expect(
      matchFreeTextFromSnapshot({
        messages: [
          {
            id: "message-1",
            runId: "run-1",
            blocks: [{ kind: "ask", status: "pending" }],
          },
          {
            id: "message-2",
            runId: "run-2",
            blocks: [{ kind: "ask", status: "pending", input: "secret" }],
          },
        ],
        activeRuns: [
          { id: "run-1", status: "waiting_input" },
          { id: "run-2", status: "waiting_input" },
        ],
      }),
    ).toEqual({
      action: "answer",
      interventionId: "legacy_message-1",
      runId: "run-1",
      messageId: "message-1",
    });
  });
});
