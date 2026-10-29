import { describe, expect, it } from "vitest";
import { resumeAnswerFromAsk } from "./executor.js";

describe("resumeAnswerFromAsk", () => {
  it("resolves a choice id to the label the model must see", () => {
    expect(
      resumeAnswerFromAsk({
        status: "answered",
        answer: "choice-2",
        actions: [
          { id: "choice-1", label: "Berlin" },
          { id: "choice-2", label: "Seoul" },
        ],
      }),
    ).toBe("Seoul");
  });

  it("keeps free-text answers unchanged", () => {
    expect(resumeAnswerFromAsk({ status: "answered", answer: "Paris" })).toBe("Paris");
  });

  it("does not rewrite approval or plan action ids", () => {
    expect(
      resumeAnswerFromAsk({
        status: "answered",
        answer: "allow",
        actions: [{ id: "allow", label: "Allow once" }],
      }),
    ).toBe("allow");
    expect(
      resumeAnswerFromAsk({
        status: "answered",
        answer: "approve",
        actions: [{ id: "approve", label: "Approve plan" }],
      }),
    ).toBe("approve");
  });

  it("returns undefined until the ask is answered", () => {
    expect(
      resumeAnswerFromAsk({
        status: "pending",
        answer: "choice-1",
        actions: [{ id: "choice-1", label: "Berlin" }],
      }),
    ).toBeUndefined();
    expect(resumeAnswerFromAsk({ status: "answered" })).toBeUndefined();
  });
});
