/**
 * Specs that need a feature gate which changes legacy surfaces (unified
 * cards or private pairs). They must run in their own harness process.
 */
export const E2E_GATE_SPECS = [
  "card-ui-interactions.spec.ts",
  "card-display-content.spec.ts",
  "four-shells-visual.spec.ts",
  "peer-messages.spec.ts",
  "card-attention.spec.ts",
  "group-membership.spec.ts",
  "message-group.spec.ts",
] as const;

// Full runs select by these two constants only, so both are derived from the
// list above: a gate-dependent spec left in the gate-off batch would be skipped
// by its own gate check and silently lose its coverage.
const GATE_SPEC_PATTERN = E2E_GATE_SPECS.map((name) => name.replace(/[.]/g, "\\.")).join("|");

export const FULL_E2E_GATE_OFF_SPEC = `^(?!.*(?:${GATE_SPEC_PATTERN})).*\\.spec\\.ts$`;
export const FULL_E2E_GATED_SPEC = E2E_GATE_SPECS.join("|");

/**
 * A selective CI run can union gate-on and gate-off specs from different
 * path rules. Running them in one process would leak the gates into the
 * legacy specs, so split exact-name lists into two batches.
 */
export function splitGateBatches(
  e2eSpec: string | undefined,
): { plain: string[]; gated: string[] } | null {
  if (!e2eSpec) return null;
  const specs = e2eSpec
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  const gatedNames = new Set<string>(E2E_GATE_SPECS);
  const gated = specs.filter((spec) => gatedNames.has(spec));
  const plain = specs.filter((spec) => !gatedNames.has(spec));
  if (gated.length === 0 || plain.length === 0) return null;
  return { plain, gated };
}

/** Exact filename selection used by the harness; regex filters never enable gates. */
export function specSelects(e2eSpec: string | undefined, name: string): boolean {
  if (!e2eSpec) return false;
  return e2eSpec.split("|").some((part) => {
    const token = part.trim();
    return token === name || token.endsWith(`/${name}`);
  });
}
