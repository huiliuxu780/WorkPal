import { describe, expect, it, vi } from "vitest";
import type { MemoryFact, PrismaClient } from "@rakazo/db";
import {
  dedupeFactsByCanonicalKey,
  isAmbiguousMemoryText,
  recordMemoryFromEdit,
  recordMemoryFromRun,
  SecretLikeContentError,
} from "./facts.js";

function fact(overrides: Partial<MemoryFact> & { id: string }): MemoryFact {
  return {
    canonicalKey: "stable_fact:shared",
    scopeKind: "user",
    origin: "user_confirmed",
    lastConfirmedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  } as MemoryFact;
}

describe("dedupeFactsByCanonicalKey", () => {
  it("applies the user's explicit entry before any scope precedence", () => {
    // Card rule: explicit corrections/direct edits first; only equally-sourced
    // copies fall through to bot > space > user.
    const explicitUser = fact({
      id: "user-explicit",
      scopeKind: "user",
      origin: "user_direct",
      lastConfirmedAt: new Date("2026-09-01T00:00:00Z"), // OLDER
    });
    const legacyBot = fact({
      id: "bot-legacy",
      scopeKind: "bot",
      origin: "legacy_import",
      lastConfirmedAt: new Date("2026-10-01T00:00:00Z"), // NEWER
    });
    const deduped = dedupeFactsByCanonicalKey([legacyBot, explicitUser]);
    expect(deduped.map((entry) => entry.id)).toEqual(["user-explicit"]);
  });

  it("among equally-sourced copies the explicit bot scope wins over space and user", () => {
    const userCopy = fact({ id: "u", scopeKind: "user", origin: "user_confirmed" });
    const spaceCopy = fact({ id: "s", scopeKind: "space", origin: "user_confirmed" });
    const botCopy = fact({ id: "b", scopeKind: "bot", origin: "user_confirmed" });
    const deduped = dedupeFactsByCanonicalKey([userCopy, spaceCopy, botCopy]);
    expect(deduped.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("breaks remaining ties by newest confirmation", () => {
    const older = fact({ id: "old", lastConfirmedAt: new Date("2026-01-01T00:00:00Z") });
    const newer = fact({ id: "new", lastConfirmedAt: new Date("2026-06-01T00:00:00Z") });
    const deduped = dedupeFactsByCanonicalKey([older, newer]);
    expect(deduped.map((entry) => entry.id)).toEqual(["new"]);
  });

  it("keeps distinct canonical identities untouched", () => {
    const a = fact({ id: "a", canonicalKey: "k:a" });
    const b = fact({ id: "b", canonicalKey: "k:b" });
    expect(dedupeFactsByCanonicalKey([a, b])).toHaveLength(2);
  });
});

describe("explicit memory entries refuse secret-like content (M-A03)", () => {
  // Fresh poisoned stub per test: any database access means the gate failed.
  const poisoned = () =>
    ({
      $transaction: vi.fn(() => {
        throw new Error("database must not be reached for refused content");
      }),
    }) as unknown as PrismaClient & { $transaction: ReturnType<typeof vi.fn> };

  it("recordMemoryFromEdit rejects an API key instead of storing it", async () => {
    const poisonedPrisma = poisoned();
    await expect(
      recordMemoryFromEdit(
        { prisma: poisonedPrisma, digestKey: "k" },
        {
          actor: { userId: "u1", spaceId: "s1" },
          scopeKind: "user",
          scopeId: "u1",
          text: "My api key is sk-abcdefghijklmnopqrstuvwxyz123456",
        },
      ),
    ).rejects.toBeInstanceOf(SecretLikeContentError);
  });

  it("recordMemoryFromEdit rejects one-time codes in any language", async () => {
    await expect(
      recordMemoryFromEdit(
        { prisma: poisoned(), digestKey: "k" },
        {
          actor: { userId: "u1", spaceId: "s1" },
          scopeKind: "user",
          scopeId: "u1",
          text: "门禁验证码 483921 长期有效",
        },
      ),
    ).rejects.toBeInstanceOf(SecretLikeContentError);
  });

  it("recordMemoryFromRun returns an invalid result before any database read", async () => {
    const poisonedPrisma = poisoned();
    const result = await recordMemoryFromRun(
      { prisma: poisonedPrisma, digestKey: "k" },
      { runId: "run-1", text: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456" },
    );
    expect(result).toEqual({ status: "invalid", reason: "secret_like_content" });
    expect(poisonedPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("isAmbiguousMemoryText", () => {
  it("treats a single clear proposition as unambiguous", () => {
    expect(isAmbiguousMemoryText("Deploy window is Sunday")).toBe(false);
  });
  it("demotes multi-statement blobs and overlong text to candidates", () => {
    expect(isAmbiguousMemoryText("First do this. Then do that. Finally rest.")).toBe(true);
    expect(isAmbiguousMemoryText("x".repeat(201))).toBe(true);
  });
});
