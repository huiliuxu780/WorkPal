import { describe, expect, it } from "vitest";
import { PublicShareViewSchema, ShareExpirySchema, ShareLinkSchema } from "./share.js";

describe("share expiry", () => {
  it("accepts the three presets and a custom day count", () => {
    expect(ShareExpirySchema.parse({ preset: "24h" })).toEqual({ preset: "24h" });
    expect(ShareExpirySchema.parse({ preset: "7d" })).toEqual({ preset: "7d" });
    expect(ShareExpirySchema.parse({ preset: "30d" })).toEqual({ preset: "30d" });
    expect(ShareExpirySchema.parse({ preset: "custom", customDays: 1 })).toEqual({
      preset: "custom",
      customDays: 1,
    });
    expect(ShareExpirySchema.parse({ preset: "custom", customDays: 90 })).toEqual({
      preset: "custom",
      customDays: 90,
    });
  });

  it("rejects a foreeevr option, missing custom days and out-of-range days", () => {
    expect(() => ShareExpirySchema.parse({ preset: "forever" })).toThrow();
    expect(() => ShareExpirySchema.parse({ preset: "custom" })).toThrow();
    expect(() => ShareExpirySchema.parse({ preset: "custom", customDays: 0 })).toThrow();
    expect(() => ShareExpirySchema.parse({ preset: "custom", customDays: 91 })).toThrow();
    expect(() => ShareExpirySchema.parse({ preset: "7d", customDays: 7 })).toThrow();
    expect(() => ShareExpirySchema.parse({ preset: "7d", expiresAt: "2030-01-01" })).toThrow();
  });
});

describe("public share view", () => {
  it("never carries html on a dead link", () => {
    expect(PublicShareViewSchema.parse({ state: "revoked", name: "Board" })).toEqual({
      state: "revoked",
      name: "Board",
    });
    expect(PublicShareViewSchema.parse({ state: "expired", name: "Board" })).toEqual({
      state: "expired",
      name: "Board",
    });
    expect(() =>
      PublicShareViewSchema.parse({ state: "revoked", name: "Board", html: "<p>x</p>" }),
    ).toThrow();
  });

  it("requires a token-shaped link", () => {
    const now = new Date().toISOString();
    expect(
      ShareLinkSchema.parse({ token: "t".repeat(43), expiresAt: now, createdAt: now }),
    ).toBeTruthy();
    expect(() =>
      ShareLinkSchema.parse({ token: "short", expiresAt: now, createdAt: now }),
    ).toThrow();
  });
});
