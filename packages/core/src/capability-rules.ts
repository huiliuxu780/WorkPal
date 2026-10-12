import { CapabilityRulesSchema, type CapabilityRule } from "@rakazo/contracts";

/** Baseline policy. All other operations retain the existing executor approval gate. */
export const DEFAULT_CAPABILITY_RULES: readonly CapabilityRule[] = [
  { capability: "read_file", resource: "**", scope: "space", effect: "allow" },
  { capability: "send_email", resource: "**", scope: "space", effect: "ask" },
  { capability: "delete_*", resource: "production/**", scope: "space", effect: "deny" },
];

const EFFECT_RANK = { allow: 1, ask: 2, deny: 3 } as const;
const SCOPE_RANK = { space: 1, user: 2, bot: 3 } as const;

function matchesGlob(pattern: string, value: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index++;
    } else if (char === "*") {
      expression += "[^/]*";
    } else {
      expression += char.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "i").test(value);
}

/** A malformed persisted policy is an error, never a silent fallthrough to allow. */
export function parseCapabilityRules(value: unknown): CapabilityRule[] {
  if (value === null || value === undefined) return [];
  return CapabilityRulesSchema.parse(value);
}

export function capabilityResourceForTool(
  args: Record<string, unknown>,
  routeResourceId?: string,
): string {
  return capabilityResourcesForTool(args, routeResourceId)[0]!;
}

/** Keep the trusted connector route and model-supplied target as separate candidates. */
export function capabilityResourcesForTool(
  args: Record<string, unknown>,
  routeResourceId?: string,
): string[] {
  const environment = args.environment;
  const values = [routeResourceId, args.path, args.resource, args.resourceId]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.replaceAll("\\", "/"));
  const candidates = values.length ? values : ["*"];
  return [...new Set(candidates.map((value) =>
    environment === "production" || environment === "prod"
      ? value.startsWith("production/") ? value : `production/${value}`
      : value,
  ))];
}

export type CapabilityDecision = "allow" | "ask" | "deny";

export function resolveCapabilityRule(input: {
  capability: string;
  resource: string;
  rules: readonly CapabilityRule[];
  helperReadOnly?: boolean;
  declaredReadOnly?: boolean;
}): { decision: CapabilityDecision | null; rule: CapabilityRule | null } {
  if (input.helperReadOnly && input.declaredReadOnly !== true) {
    return { decision: "deny", rule: null };
  }
  const matches = [...DEFAULT_CAPABILITY_RULES, ...input.rules].filter(
    (rule) =>
      matchesGlob(rule.capability, input.capability) &&
      matchesGlob(rule.resource, input.resource),
  );
  if (matches.length === 0) return { decision: null, rule: null };
  matches.sort((left, right) =>
    EFFECT_RANK[right.effect] - EFFECT_RANK[left.effect] ||
    SCOPE_RANK[right.scope] - SCOPE_RANK[left.scope] ||
    right.capability.length + right.resource.length - left.capability.length - left.resource.length,
  );
  return { decision: matches[0]!.effect, rule: matches[0]! };
}
