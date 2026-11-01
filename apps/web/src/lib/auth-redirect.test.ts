import { describe, expect, it } from "vitest";
import { safeNextPath } from "./auth-redirect.js";

describe("safeNextPath", () => {
  it("keeps same-origin absolute paths", () => {
    expect(safeNextPath("/app/shared/space-1/family-1")).toBe("/app/shared/space-1/family-1");
    expect(safeNextPath("/integrations/setup")).toBe("/integrations/setup");
  });

  it("rejects protocol-relative, absolute and empty destinations", () => {
    expect(safeNextPath("//evil.example/app")).toBeNull();
    expect(safeNextPath("https://evil.example")).toBeNull();
    expect(safeNextPath("app/shared")).toBeNull();
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });
});
