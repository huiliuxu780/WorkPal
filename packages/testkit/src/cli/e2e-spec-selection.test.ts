import { describe, expect, it } from "vitest";
import {
  E2E_GATE_SPECS,
  FULL_E2E_GATE_OFF_SPEC,
  FULL_E2E_GATED_SPEC,
  specSelects,
  splitGateBatches,
} from "./e2e-spec-selection.js";

describe("e2e spec selection", () => {
  it("puts every gate-dependent spec in the full gate-on batch", () => {
    // A full run selects by these two constants only. A gated spec left in the
    // gate-off batch is skipped by its own gate check, so the full run would
    // silently lose its coverage.
    for (const name of E2E_GATE_SPECS) {
      expect(FULL_E2E_GATED_SPEC.split("|"), `${name} must be in the full gate-on batch`).toContain(
        name,
      );
      expect(new RegExp(FULL_E2E_GATE_OFF_SPEC).test(`e2e/${name}`)).toBe(false);
    }
    // Legacy specs stay in the gate-off batch.
    expect(new RegExp(FULL_E2E_GATE_OFF_SPEC).test("e2e/login-card.spec.ts")).toBe(true);
    expect(FULL_E2E_GATED_SPEC.split("|")).not.toContain("login-card.spec.ts");
  });

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
