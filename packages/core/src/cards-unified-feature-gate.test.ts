import { describe, expect, it } from "vitest";
import {
  assertCardsUnifiedV2Enabled,
  CARDS_UNIFIED_FEATURE_CONFIG_INVALID,
  CARDS_UNIFIED_V2_DISABLED,
  CARDS_UNIFIED_V2_ENV,
  CardsUnifiedFeatureConfigError,
  CardsUnifiedFeatureDisabledError,
  resolveCardsUnifiedFeatureGate,
} from "./cards-unified-feature-gate.js";

describe("cards_unified_v2 gate", () => {
  it("defaults off and accepts only true/false", () => {
    expect(resolveCardsUnifiedFeatureGate({})).toEqual({ cardsUnifiedV2: false });
    expect(resolveCardsUnifiedFeatureGate({ [CARDS_UNIFIED_V2_ENV]: "" })).toEqual({
      cardsUnifiedV2: false,
    });
    expect(resolveCardsUnifiedFeatureGate({ [CARDS_UNIFIED_V2_ENV]: "false" })).toEqual({
      cardsUnifiedV2: false,
    });
    expect(resolveCardsUnifiedFeatureGate({ [CARDS_UNIFIED_V2_ENV]: "true" })).toEqual({
      cardsUnifiedV2: true,
    });
  });

  it("fails startup for illegal values", () => {
    for (const value of ["1", "0", "yes", "on", "TRUE", " true", "true "]) {
      let error: unknown;
      try {
        resolveCardsUnifiedFeatureGate({ [CARDS_UNIFIED_V2_ENV]: value });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(CardsUnifiedFeatureConfigError);
      expect(error).toMatchObject({
        code: CARDS_UNIFIED_FEATURE_CONFIG_INVALID,
        envVar: CARDS_UNIFIED_V2_ENV,
        value,
      });
    }
  });

  it("does not reuse any Roundtable gate", () => {
    expect(
      resolveCardsUnifiedFeatureGate({
        ROUNDTABLE_PRIVATE_PAIR_ENABLED: "true",
        ROUNDTABLE_PUBLIC_COLLABORATION_ENABLED: "true",
        ROUNDTABLE_MESSAGE_GROUP_ENABLED: "true",
        ROUNDTABLE_BACKGROUND_HELPER_ENABLED: "true",
      }),
    ).toEqual({ cardsUnifiedV2: false });
  });

  it("throws the stable disabled contract only while off", () => {
    let error: unknown;
    try {
      assertCardsUnifiedV2Enabled(resolveCardsUnifiedFeatureGate({}));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CardsUnifiedFeatureDisabledError);
    expect(error).toMatchObject({ code: CARDS_UNIFIED_V2_DISABLED, retryable: false });
    expect(() =>
      assertCardsUnifiedV2Enabled(
        resolveCardsUnifiedFeatureGate({ [CARDS_UNIFIED_V2_ENV]: "true" }),
      ),
    ).not.toThrow();
  });
});
