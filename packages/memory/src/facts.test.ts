import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  createFact: vi.fn(),
}));

import { createFact, type MemoryFact, type PrismaClient } from "@rakazo/db";
import {
  dedupeFactsByCanonicalKey,
  isAmbiguousMemoryText,
  isVerifiedAuthorizationQuote,
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

describe("recordMemoryFromRun activation requires verified explicit authorization (review P1-1)", () => {
  function runPrisma(messageText: string) {
    return {
      run: {
        findUnique: vi.fn(async () => ({
          id: "run-1",
          spaceId: "s1",
          userId: "u1",
          botId: "b1",
          threadId: "t1",
          trigger: "user",
          sourceMessageId: "m1",
        })),
      },
      message: {
        findUnique: vi.fn(async () => ({
          id: "m1",
          seq: 7,
          role: "user",
          blocks: [{ kind: "text", text: messageText }],
          authorUserId: "u1",
          originKind: "human_web",
          threadId: "t1",
        })),
      },
      thread: { findUnique: vi.fn(async () => ({ historyCompactionGeneration: 0 })) },
    } as unknown as PrismaClient;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createFact).mockImplementation((async (_prisma: unknown, input: unknown) => ({
      status: "created",
      fact: { id: "fact-1", ...(input as object) },
    })) as never);
  });

  it("activates once when the model quotes the user's own authorizing words", async () => {
    const result = await recordMemoryFromRun(
      { prisma: runPrisma("Please remember that the deploy window is Sunday"), digestKey: "k" },
      {
        runId: "run-1",
        text: "Deploy window is Sunday",
        sourceQuote: "remember that the deploy window is Sunday",
      },
    );
    expect(result).toEqual({ status: "remembered", factId: "fact-1" });
    const input = vi.mocked(createFact).mock.calls[0]![1];
    expect(input).toMatchObject({ origin: "user_direct", state: "active" });
    expect(input.evidence).toHaveLength(1);
    expect(input.evidence![0]!.evidenceType).toBe("explicit_instruction");
  });

  it("demotes to a candidate when no quote is provided", async () => {
    const result = await recordMemoryFromRun(
      { prisma: runPrisma("Summarize the release notes for me"), digestKey: "k" },
      { runId: "run-1", text: "User likes release summaries" },
    );
    expect(result).toEqual({
      status: "candidate",
      factId: "fact-1",
      reason: "authorization_unverified",
    });
    expect(vi.mocked(createFact).mock.calls[0]![1]).toMatchObject({
      origin: "model_candidate",
      state: "candidate",
    });
  });

  it("demotes when the quoted span does not occur in the trusted message", async () => {
    const result = await recordMemoryFromRun(
      { prisma: runPrisma("Summarize the release notes for me"), digestKey: "k" },
      {
        runId: "run-1",
        text: "User likes release summaries",
        sourceQuote: "please always remember my preferences",
      },
    );
    expect(result).toMatchObject({ status: "candidate", reason: "authorization_unverified" });
  });

  it("never activates against an explicit refusal, even with a plausible quote", async () => {
    const message = "Please summarize this web page. Do not save anything as memory.";
    const result = await recordMemoryFromRun(
      { prisma: runPrisma(message), digestKey: "k" },
      { runId: "run-1", text: "The user prefers reports on Fridays", sourceQuote: "summarize this web page" },
    );
    expect(result).toMatchObject({ status: "candidate", reason: "explicit_refusal" });
    expect(vi.mocked(createFact).mock.calls[0]![1]).toMatchObject({ state: "candidate" });
  });
});

describe("isVerifiedAuthorizationQuote", () => {
  it("matches verbatim spans up to normalization", () => {
    expect(isVerifiedAuthorizationQuote("Remember THIS", "please remember this, thanks")).toBe(true);
    expect(isVerifiedAuthorizationQuote("记住部署窗口", "帮我记住部署窗口是周日")).toBe(true);
  });
  it("rejects quotes that are absent, empty or trivial", () => {
    expect(isVerifiedAuthorizationQuote("save all my secrets", "remember the deploy window")).toBe(false);
    expect(isVerifiedAuthorizationQuote("", "remember x")).toBe(false);
    expect(isVerifiedAuthorizationQuote("x", "remember x")).toBe(false);
  });
});
