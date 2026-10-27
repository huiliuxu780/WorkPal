/**
 * Full E2E runs need two gate-compatible batches: the unified-card and
 * private-pair specs require feature gates that make the legacy card specs
 * fail, so they cannot share one harness process with the rest of the suite.
 */
export const FULL_E2E_GATE_OFF_SPEC =
  "^(?!.*(?:card-ui-interactions\\.spec\\.ts|card-display-content\\.spec\\.ts|peer-messages\\.spec\\.ts)).*\\.spec\\.ts$";
export const FULL_E2E_GATED_SPEC =
  "card-ui-interactions.spec.ts|card-display-content.spec.ts|peer-messages.spec.ts";

/**
 * Specs that need a feature gate which changes legacy surfaces (unified
 * cards or private pairs). They must run in their own harness process.
 */
export const E2E_GATE_SPECS = [
  "card-ui-interactions.spec.ts",
  "card-display-content.spec.ts",
  "peer-messages.spec.ts",
  "card-attention.spec.ts",
  "group-membership.spec.ts",
  "message-group.spec.ts",
] as const;

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
