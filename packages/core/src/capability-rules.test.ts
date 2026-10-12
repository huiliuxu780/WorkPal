import { describe, expect, it } from "vitest";
import {
  capabilityResourceForTool,
  capabilityResourcesForTool,
  parseCapabilityRules,
  resolveCapabilityRule,
} from "./capability-rules.js";

describe("capability rules", () => {
  it("applies defaults without expanding unmatched tool permissions", () => {
    expect(resolveCapabilityRule({ capability: "read_file", resource: "notes/a.txt", rules: [] }).decision).toBe("allow");
    expect(resolveCapabilityRule({ capability: "send_email", resource: "*", rules: [] }).decision).toBe("ask");
    expect(resolveCapabilityRule({ capability: "delete_record", resource: "production/customers", rules: [] }).decision).toBe("deny");
    expect(resolveCapabilityRule({ capability: "write_file", resource: "notes/a.txt", rules: [] }).decision).toBeNull();
  });

  it("keeps deny above ask above allow, even when a narrower scope asks for less", () => {
    const rules = parseCapabilityRules([
      { capability: "write_file", resource: "shared/**", scope: "bot", effect: "allow" },
      { capability: "write_file", resource: "shared/**", scope: "user", effect: "ask" },
      { capability: "write_file", resource: "shared/private/**", scope: "space", effect: "deny" },
    ]);
    expect(resolveCapabilityRule({ capability: "write_file", resource: "shared/report.txt", rules }).decision).toBe("ask");
    expect(resolveCapabilityRule({ capability: "write_file", resource: "shared/private/a.txt", rules }).decision).toBe("deny");
    expect(resolveCapabilityRule({
      capability: "send_email", resource: "*",
      rules: [{ capability: "send_email", resource: "**", scope: "bot", effect: "allow" }],
    }).decision).toBe("ask");
  });

  it("uses scope specificity for equal effects and enforces a read-only helper subset", () => {
    const rules = parseCapabilityRules([
      { capability: "read_file", resource: "**", scope: "bot", effect: "allow" },
    ]);
    expect(resolveCapabilityRule({ capability: "read_file", resource: "x", rules }).rule?.scope).toBe("bot");
    expect(resolveCapabilityRule({ capability: "write_file", resource: "x", rules, helperReadOnly: true, declaredReadOnly: false }).decision).toBe("deny");
    expect(resolveCapabilityRule({ capability: "read_file", resource: "x", rules, helperReadOnly: true, declaredReadOnly: true }).decision).toBe("allow");
  });

  it("extracts a bounded resource identity without serializing tool arguments", () => {
    expect(capabilityResourceForTool({ path: "shared\\report.txt", content: "secret" })).toBe("shared/report.txt");
    expect(capabilityResourceForTool({ environment: "production", resourceId: "customers" })).toBe("production/customers");
    expect(capabilityResourcesForTool({ path: "dev" }, "production/customers")).toEqual(["production/customers", "dev"]);
    expect(() => parseCapabilityRules([{ capability: "read_file", resource: "**", scope: "bot", effect: "allow", extra: true }])).toThrow();
  });
});
