export const ROUNDTABLE_FEATURES = [
  "private_pair",
  "public_collaboration",
  "message_group",
  "background_helper",
] as const;

export type RoundtableFeature = (typeof ROUNDTABLE_FEATURES)[number];

export const ROUNDTABLE_FEATURE_ENV: Readonly<Record<RoundtableFeature, string>> = {
  private_pair: "ROUNDTABLE_PRIVATE_PAIR_ENABLED",
  public_collaboration: "ROUNDTABLE_PUBLIC_COLLABORATION_ENABLED",
  message_group: "ROUNDTABLE_MESSAGE_GROUP_ENABLED",
  background_helper: "ROUNDTABLE_BACKGROUND_HELPER_ENABLED",
};

export type RoundtableFeatureGates = Readonly<Record<RoundtableFeature, boolean>>;

export type RoundtableEnv = Readonly<Record<string, string | undefined>>;

export const ROUNDTABLE_FEATURE_CONFIG_INVALID = "ROUNDTABLE_FEATURE_CONFIG_INVALID" as const;

export class RoundtableFeatureConfigError extends Error {
  override readonly name = "RoundtableFeatureConfigError";
  readonly code = ROUNDTABLE_FEATURE_CONFIG_INVALID;
  readonly envVar: string;
  readonly value: string;

  constructor(envVar: string, value: string) {
    super(`${envVar} must be "true" or "false" when set; received ${JSON.stringify(value)}`);
    this.envVar = envVar;
    this.value = value;
  }
}

export const ROUNDTABLE_FEATURE_DISABLED = "ROUNDTABLE_FEATURE_DISABLED" as const;

export interface RoundtableFeatureDisabledContract {
  readonly code: typeof ROUNDTABLE_FEATURE_DISABLED;
  readonly feature: RoundtableFeature;
  readonly retryable: false;
}

export class RoundtableFeatureDisabledError
  extends Error
  implements RoundtableFeatureDisabledContract
{
  override readonly name = "RoundtableFeatureDisabledError";
  readonly code = ROUNDTABLE_FEATURE_DISABLED;
  readonly retryable = false;

  constructor(readonly feature: RoundtableFeature) {
    super(`Roundtable feature is disabled: ${feature}`);
  }
}

/** Single source of truth for every process that reads roundtable gates. */
export function resolveRoundtableFeatureGates(source: RoundtableEnv): RoundtableFeatureGates {
  const gates: Record<RoundtableFeature, boolean> = {
    private_pair: false,
    public_collaboration: false,
    message_group: false,
    background_helper: false,
  };
  for (const feature of ROUNDTABLE_FEATURES) {
    const envVar = ROUNDTABLE_FEATURE_ENV[feature];
    const raw = source[envVar];
    if (raw === undefined) continue;
    if (raw === "" || raw === "false") continue;
    if (raw !== "true") throw new RoundtableFeatureConfigError(envVar, raw);
    gates[feature] = true;
  }
  return Object.freeze(gates);
}

export function assertRoundtableFeatureEnabled(
  gates: RoundtableFeatureGates,
  feature: RoundtableFeature,
): void {
  if (!gates[feature]) throw new RoundtableFeatureDisabledError(feature);
}
