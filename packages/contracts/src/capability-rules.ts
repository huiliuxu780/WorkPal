import { z } from "zod";

export const CapabilityRuleSchema = z.strictObject({
  capability: z.string().min(1).max(128),
  resource: z.string().min(1).max(256),
  scope: z.enum(["space", "user", "bot"]),
  effect: z.enum(["allow", "ask", "deny"]),
});

export const CapabilityRulesSchema = z.array(CapabilityRuleSchema).max(100);
export type CapabilityRule = z.infer<typeof CapabilityRuleSchema>;
