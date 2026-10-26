/**
 * Full E2E runs need two gate-compatible batches: the unified-card and
 * private-pair specs require feature gates that make the legacy card specs
 * fail, so they cannot share one harness process with the rest of the suite.
 */
export const FULL_E2E_GATE_OFF_SPEC =
  "^(?!.*(?:card-ui-interactions\\.spec\\.ts|peer-messages\\.spec\\.ts)).*\\.spec\\.ts$";
export const FULL_E2E_GATED_SPEC = "card-ui-interactions.spec.ts|peer-messages.spec.ts";

/** Exact filename selection used by the harness; regex filters never enable gates. */
export function specSelects(e2eSpec: string | undefined, name: string): boolean {
  if (!e2eSpec) return false;
  return e2eSpec.split("|").some((part) => {
    const token = part.trim();
    return token === name || token.endsWith(`/${name}`);
  });
}
