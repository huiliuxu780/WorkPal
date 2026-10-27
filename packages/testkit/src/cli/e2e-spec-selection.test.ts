import { describe, expect, it } from "vitest";
import { specSelects, splitGateBatches } from "./e2e-spec-selection.js";

describe("e2e spec selection", () => {
  it("splits a mixed selective list into gate-off and gate-on batches", () => {
    expect(
      splitGateBatches(
        "card-attention.spec.ts|ui-appearance.spec.ts|login-card.spec.ts|card-display-content.spec.ts",
      ),
    ).toEqual({
      plain: ["ui-appearance.spec.ts", "login-card.spec.ts"],
      gated: ["card-attention.spec.ts", "card-display-content.spec.ts"],
    });
  });

  it("leaves homogeneous lists and regex filters alone", () => {
    expect(splitGateBatches("card-attention.spec.ts|message-group.spec.ts")).toBeNull();
    expect(splitGateBatches("login-card.spec.ts|settings-shell.spec.ts")).toBeNull();
    expect(splitGateBatches("^(?!.*card).*\\.spec\\.ts$")).toBeNull();
    expect(splitGateBatches(undefined)).toBeNull();
  });

  it("matches exact filenames but not regex filters", () => {
    expect(specSelects("a.spec.ts|card-attention.spec.ts", "card-attention.spec.ts")).toBe(true);
    expect(specSelects("^(?!.*card-attention).*\\.spec\\.ts$", "card-attention.spec.ts")).toBe(
      false,
    );
    expect(specSelects(undefined, "card-attention.spec.ts")).toBe(false);
  });
});
