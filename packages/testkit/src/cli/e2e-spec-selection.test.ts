import { describe, expect, it } from "vitest";
import { FULL_E2E_GATE_OFF_SPEC, FULL_E2E_GATED_SPEC, specSelects } from "./e2e-spec-selection.js";

const legacy = "apps/web/e2e/mcp-approval-card.spec.ts";
const card = "apps/web/e2e/card-ui-interactions.spec.ts";
const display = "apps/web/e2e/card-display-content.spec.ts";
const pair = "apps/web/e2e/peer-messages.spec.ts";

describe("full E2E gate batches", () => {
  it("routes the gated specs to the gate-on batch only", () => {
    const gateOff = new RegExp(FULL_E2E_GATE_OFF_SPEC);
    const gated = new RegExp(FULL_E2E_GATED_SPEC);
    expect(gateOff.test(legacy)).toBe(true);
    expect(gated.test(legacy)).toBe(false);
    expect(gateOff.test(card)).toBe(false);
    expect(gated.test(card)).toBe(true);
    expect(gateOff.test(display)).toBe(false);
    expect(gated.test(display)).toBe(true);
    expect(gateOff.test(pair)).toBe(false);
    expect(gated.test(pair)).toBe(true);
  });

  it("only enables gates for exact spec selections", () => {
    expect(specSelects(card, "card-ui-interactions.spec.ts")).toBe(true);
    expect(
      specSelects("ui-appearance.spec.ts|peer-messages.spec.ts", "peer-messages.spec.ts"),
    ).toBe(true);
    expect(
      specSelects("apps/web/e2e/card-ui-interactions.spec.ts", "card-ui-interactions.spec.ts"),
    ).toBe(true);
    expect(specSelects(FULL_E2E_GATE_OFF_SPEC, "card-ui-interactions.spec.ts")).toBe(false);
    expect(specSelects(FULL_E2E_GATE_OFF_SPEC, "peer-messages.spec.ts")).toBe(false);
    expect(specSelects("ui-appearance.spec.ts", "card-ui-interactions.spec.ts")).toBe(false);
    expect(specSelects(undefined, "card-ui-interactions.spec.ts")).toBe(false);
  });
});
