/**
 * CARD-01 total feature gate. It is deliberately independent from the four
 * Roundtable gates: enabling private pairing or message groups must never turn
 * on the unified card projection.
 *
 * `cards_unified_v2` defaults off. The server resolves it once and projects a
 * capability to the Web; the Web never reads this environment variable itself.
 */
export const CARDS_UNIFIED_V2_GATE = "cards_unified_v2" as const;
export const CARDS_UNIFIED_V2_ENV = "CARDS_UNIFIED_V2_ENABLED" as const;

export interface CardsUnifiedFeatureGate {
  readonly cardsUnifiedV2: boolean;
}

export const CARDS_UNIFIED_FEATURE_CONFIG_INVALID = "CARDS_UNIFIED_FEATURE_CONFIG_INVALID" as const;

export class CardsUnifiedFeatureConfigError extends Error {
  override readonly name = "CardsUnifiedFeatureConfigError";
  readonly code = CARDS_UNIFIED_FEATURE_CONFIG_INVALID;
  readonly envVar: string;
  readonly value: string;

  constructor(envVar: string, value: string) {
    super(`${envVar} must be "true" or "false" when set; received ${JSON.stringify(value)}`);
    this.envVar = envVar;
    this.value = value;
  }
}

export function resolveCardsUnifiedFeatureGate(
  source: Readonly<Record<string, string | undefined>>,
): CardsUnifiedFeatureGate {
  const raw = source[CARDS_UNIFIED_V2_ENV];
  if (raw === undefined || raw === "" || raw === "false") {
    return Object.freeze({ cardsUnifiedV2: false });
  }
  if (raw !== "true") throw new CardsUnifiedFeatureConfigError(CARDS_UNIFIED_V2_ENV, raw);
  return Object.freeze({ cardsUnifiedV2: true });
}

export const CARDS_UNIFIED_V2_DISABLED = "CARDS_UNIFIED_V2_DISABLED" as const;

export class CardsUnifiedFeatureDisabledError extends Error {
  override readonly name = "CardsUnifiedFeatureDisabledError";
  readonly code = CARDS_UNIFIED_V2_DISABLED;
  readonly retryable = false;

  constructor() {
    super("The cards_unified_v2 feature gate is disabled");
  }
}

export function assertCardsUnifiedV2Enabled(gate: CardsUnifiedFeatureGate): void {
  if (!gate.cardsUnifiedV2) throw new CardsUnifiedFeatureDisabledError();
}
