import { describe, expect, it } from "vitest";
import {
  assertRoundtableFeatureEnabled,
  ROUNDTABLE_FEATURE_CONFIG_INVALID,
  ROUNDTABLE_FEATURE_DISABLED,
  ROUNDTABLE_FEATURE_ENV,
  ROUNDTABLE_FEATURES,
  RoundtableFeatureConfigError,
  RoundtableFeatureDisabledError,
  resolveRoundtableFeatureGates,
} from "./roundtable-feature-gates.js";

const allDisabled = {
  private_pair: false,
  public_collaboration: false,
  message_group: false,
  background_helper: false,
};

describe("resolveRoundtableFeatureGates", () => {
  it("keeps every capability disabled when nothing is configured", () => {
    expect(resolveRoundtableFeatureGates({})).toEqual(allDisabled);
  });

  it("enables each capability independently", () => {
    for (const enabledFeature of ROUNDTABLE_FEATURES) {
      const gates = resolveRoundtableFeatureGates({
        [ROUNDTABLE_FEATURE_ENV[enabledFeature]]: "true",
      });
      for (const feature of ROUNDTABLE_FEATURES) {
        expect(gates[feature], feature).toBe(feature === enabledFeature);
      }
    }
  });

  it("keeps explicitly disabled and blank capabilities off", () => {
    const explicitlyDisabled = Object.fromEntries(
      ROUNDTABLE_FEATURES.map((feature) => [ROUNDTABLE_FEATURE_ENV[feature], "false"]),
    );
    expect(resolveRoundtableFeatureGates(explicitlyDisabled)).toEqual(allDisabled);
    expect(
      resolveRoundtableFeatureGates({
        [ROUNDTABLE_FEATURE_ENV.public_collaboration]: "",
      }),
    ).toEqual(allDisabled);
  });

  it("rejects non-empty values other than true or false", () => {
    for (const value of ["1", "0", "yes", "on", "ture", "TRUE", " true", "true "]) {
      expect(() =>
        resolveRoundtableFeatureGates({
          [ROUNDTABLE_FEATURE_ENV.background_helper]: value,
        }),
      ).toThrow(RoundtableFeatureConfigError);
    }
  });

  it("identifies the offending deployment variable", () => {
    let error: unknown;
    try {
      resolveRoundtableFeatureGates({
        [ROUNDTABLE_FEATURE_ENV.message_group]: "yes",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RoundtableFeatureConfigError);
    expect(error).toMatchObject({
      code: ROUNDTABLE_FEATURE_CONFIG_INVALID,
      envVar: "ROUNDTABLE_MESSAGE_GROUP_ENABLED",
      value: "yes",
    });
  });
});

describe("assertRoundtableFeatureEnabled", () => {
  it("returns the stable disabled contract without leaking a permission or runtime error", () => {
    let error: unknown;
    try {
      assertRoundtableFeatureEnabled(resolveRoundtableFeatureGates({}), "message_group");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RoundtableFeatureDisabledError);
    expect(error).toMatchObject({
      code: ROUNDTABLE_FEATURE_DISABLED,
      feature: "message_group",
      retryable: false,
    });
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      code: "ROUNDTABLE_FEATURE_DISABLED",
      feature: "message_group",
      retryable: false,
    });
  });

  it("has no side effects when the gate is enabled", () => {
    const gates = resolveRoundtableFeatureGates({
      [ROUNDTABLE_FEATURE_ENV.private_pair]: "true",
    });
    const snapshot = { ...gates };
    expect(() => assertRoundtableFeatureEnabled(gates, "private_pair")).not.toThrow();
    expect(gates).toEqual(snapshot);
  });
});
