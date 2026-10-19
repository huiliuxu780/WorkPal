import { describe, expect, it } from "vitest";
import type { MemoryFact } from "@rakazo/db";
import {
  assembleMemoryInjection,
  MIGRATION_MEMORY_BUDGETS,
  POST_MIGRATION_MEMORY_BUDGETS,
  scaleMemoryBudgetsToWindow,
  selectSupplementalFacts,
  truncateToEstimatedTokens,
} from "./memory-injection.js";
import { loadAgentMemoryContext } from "./memory-context.js";
import type { ScopedMemoryDocument } from "./memory-context.js";
import { estimatePromptTokens } from "@rakazo/core";

function fact(overrides: Partial<MemoryFact> & { id: string; text: string }): MemoryFact {
  return {
    spaceId: "space-1",
    ownerUserId: "user-1",
    botId: null,
    scopeKind: "user",
    scopeKey: "user:user-1",
    canonicalKey: `stable_fact:${overrides.id}`,
    kind: "stable_fact",
    language: null,
    literalValues: null,
    origin: "user_confirmed",
    state: "active",
    revision: 1,
    supersedesFactId: null,
    promotionSourceFactId: null,
    sourceDocumentId: null,
    learnedAt: new Date("2026-10-01T00:00:00Z"),
    validFrom: null,
    expiresAt: null,
    lastConfirmedAt: new Date("2026-10-01T00:00:00Z"),
    createdBy: "user-1",
    lastChangedBy: "user-1",
    sourceRunId: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  } as MemoryFact;
}

function doc(overrides: Partial<ScopedMemoryDocument> & { path: string }): ScopedMemoryDocument {
  return {
    id: `doc-${overrides.path}`,
    content: `content of ${overrides.path}`,
    revision: 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
    scope: "bot",
    ...overrides,
  } as ScopedMemoryDocument;
}

describe("migration budgets", () => {
  it("pins the card numbers: 4000 total, 2000 legacy, 1200 summary, 10 facts", () => {
    expect(MIGRATION_MEMORY_BUDGETS).toEqual({
      totalTokens: 4_000,
      legacyTokens: 2_000,
      summaryTokens: 1_200,
      factTokens: 800,
      maxFacts: 10,
    });
    expect(POST_MIGRATION_MEMORY_BUDGETS.totalTokens).toBe(2_000);
    expect(POST_MIGRATION_MEMORY_BUDGETS.legacyTokens).toBe(0);
  });

  it("shrinks proportionally for small windows and never grows", () => {
    const full = scaleMemoryBudgetsToWindow(MIGRATION_MEMORY_BUDGETS, 128_000);
    expect(full).toEqual(MIGRATION_MEMORY_BUDGETS);
    const small = scaleMemoryBudgetsToWindow(MIGRATION_MEMORY_BUDGETS, 16_000);
    // 16k * 0.05 = 800 allowance → scale 0.2
    expect(small.totalTokens).toBe(800);
    expect(small.legacyTokens).toBe(400);
    expect(small.summaryTokens).toBe(240);
    expect(small.maxFacts).toBe(2);
    const unknown = scaleMemoryBudgetsToWindow(MIGRATION_MEMORY_BUDGETS, undefined);
    expect(unknown).toEqual(MIGRATION_MEMORY_BUDGETS);
  });
});

describe("assembleMemoryInjection", () => {
  it("renders legacy-only input byte-identically to the legacy loader", async () => {
    const documents = [
      doc({ path: "MEMORY.md", scope: "bot", revision: 3, content: "Bot notes body" }),
      doc({ path: "prefs.md", scope: "user", revision: 1, content: "User prefs body" }),
    ];
    const memory = {
      read: async (request: { scope: string }) => ({
        documents:
          request.scope === "bot"
            ? documents.filter((d) => d.scope === "bot")
            : documents.filter((d) => d.scope === "user"),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const legacy = await loadAgentMemoryContext(memory, "bot-1", {
      operationId: "op",
      traceId: "tr",
      spaceId: "space-1",
      userId: "user-1",
      signal: new AbortController().signal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const assembled = assembleMemoryInjection(
      { legacyDocuments: documents, summary: null, facts: [] },
      MIGRATION_MEMORY_BUDGETS,
    );
    expect(assembled.content).toBe(legacy);
    expect(assembled.stats.selectedLegacyPaths).toEqual(["bot:MEMORY.md", "user:prefs.md"]);
  });

  it("orders summary, then confirmed facts, then legacy documents inside the fence", () => {
    const assembled = assembleMemoryInjection(
      {
        legacyDocuments: [doc({ path: "MEMORY.md", content: "legacy body" })],
        summary: { content: "The user prefers short answers." },
        facts: [fact({ id: "fact-1", text: "Deploy host is alpha" })],
      },
      MIGRATION_MEMORY_BUDGETS,
    );
    const content = assembled.content!;
    expect(content.startsWith("Durable memory saved by this user or bot follows.")).toBe(true);
    expect(content).toContain("<durable_memory>");
    const summaryIdx = content.indexOf("The user prefers short answers.");
    const factIdx = content.indexOf("Deploy host is alpha");
    const legacyIdx = content.indexOf("## bot: MEMORY.md (revision 1)");
    expect(summaryIdx).toBeGreaterThan(0);
    expect(factIdx).toBeGreaterThan(summaryIdx);
    expect(legacyIdx).toBeGreaterThan(factIdx);
    expect(content.endsWith("</durable_memory>")).toBe(true);
    expect(assembled.stats.summaryIncluded).toBe(true);
    expect(assembled.stats.selectedFactIds).toEqual(["fact-1"]);
  });

  it("escapes fact text and literals as data", () => {
    const assembled = assembleMemoryInjection(
      {
        legacyDocuments: [],
        summary: null,
        facts: [
          fact({
            id: "fact-x",
            text: "Run <script>alert(1)</script> & wait",
            literalValues: { command: "deploy --env=<prod>" },
          }),
        ],
      },
      MIGRATION_MEMORY_BUDGETS,
    );
    expect(assembled.content).toContain("&lt;script&gt;");
    expect(assembled.content).not.toContain("<script>");
    expect(assembled.content).toContain("command=deploy --env=&lt;prod&gt;");
    expect(assembled.content).toContain("[id: fact-x]");
  });

  it("caps supplemental facts at 10 and reports honest omission counts", () => {
    const facts = Array.from({ length: 14 }, (_, index) =>
      fact({ id: `fact-${index}`, text: `Preference number ${index} about topic ${index}` }),
    );
    const assembled = assembleMemoryInjection(
      { legacyDocuments: [], summary: null, facts },
      MIGRATION_MEMORY_BUDGETS,
    );
    expect(assembled.stats.selectedFactIds).toHaveLength(10);
    expect(assembled.stats.omittedFactCount).toBe(4);
  });

  it("enforces the fact token sub-budget without borrowing from legacy", () => {
    const facts = Array.from({ length: 10 }, (_, index) =>
      fact({ id: `fact-${index}`, text: `x`.repeat(2_000) + ` tail ${index}` }),
    );
    const assembled = assembleMemoryInjection(
      {
        legacyDocuments: [doc({ path: "MEMORY.md", content: "small legacy body" })],
        summary: null,
        facts,
      },
      MIGRATION_MEMORY_BUDGETS,
    );
    // The huge facts blow the 800-token fact sub-budget; the legacy document
    // still renders in full because sub-budgets do not borrow.
    expect(assembled.stats.selectedFactIds.length).toBeLessThan(10);
    expect(assembled.stats.omittedFactCount).toBeGreaterThan(0);
    expect(assembled.content).toContain("small legacy body");
  });

  it("truncates an oversized summary at its sub-budget and keeps rendering", () => {
    const assembled = assembleMemoryInjection(
      {
        legacyDocuments: [],
        summary: { content: "s".repeat(20_000) },
        facts: [],
      },
      MIGRATION_MEMORY_BUDGETS,
    );
    expect(assembled.stats.summaryIncluded).toBe(true);
    const body = assembled.content!;
    expect(estimatePromptTokens(body)).toBeLessThan(MIGRATION_MEMORY_BUDGETS.totalTokens + 200);
  });

  it("never injects a legacy document already confirmed-migrated to a fact", () => {
    const assembled = assembleMemoryInjection(
      {
        legacyDocuments: [
          doc({ path: "MEMORY.md", id: "doc-1", content: "migrated body" }),
          doc({ path: "keep.md", id: "doc-2", content: "kept body" }),
        ],
        summary: null,
        facts: [],
        legacyImportedDocumentIds: new Set(["doc-1"]),
      },
      MIGRATION_MEMORY_BUDGETS,
    );
    expect(assembled.content).not.toContain("migrated body");
    expect(assembled.content).toContain("kept body");
  });

  it("drops the legacy layer entirely after retirement", () => {
    const assembled = assembleMemoryInjection(
      {
        legacyDocuments: [doc({ path: "MEMORY.md", content: "legacy body" })],
        summary: null,
        facts: [fact({ id: "fact-1", text: "Only facts remain" })],
      },
      POST_MIGRATION_MEMORY_BUDGETS,
    );
    expect(assembled.content).not.toContain("legacy body");
    expect(assembled.content).toContain("Only facts remain");
    expect(assembled.stats.omittedLegacyCount).toBe(1);
  });

  it("returns undefined when there is nothing to inject", () => {
    const assembled = assembleMemoryInjection(
      { legacyDocuments: [], summary: null, facts: [] },
      MIGRATION_MEMORY_BUDGETS,
    );
    expect(assembled.content).toBeUndefined();
  });
});

describe("selectSupplementalFacts", () => {
  it("prefers task-relevant facts, then newest confirmation", () => {
    const facts = [
      fact({ id: "f-old", text: "Likes rust for services", lastConfirmedAt: new Date("2026-01-01") }),
      fact({ id: "f-rel", text: "Deploy window is Sunday", lastConfirmedAt: new Date("2026-02-01") }),
      fact({ id: "f-new", text: "Prefers tables", lastConfirmedAt: new Date("2026-03-01") }),
    ];
    const { selected, omitted } = selectSupplementalFacts(facts, "when is the deploy window?", 2);
    expect(selected.map((entry) => entry.id)).toEqual(["f-rel", "f-new"]);
    expect(omitted).toBe(1);
  });
});

describe("truncateToEstimatedTokens", () => {
  it("keeps short text intact and never splits a surrogate pair", () => {
    expect(truncateToEstimatedTokens("hello", 100)).toBe("hello");
    const emoji = "😀".repeat(100); // 2 code units each
    const truncated = truncateToEstimatedTokens(emoji, 10);
    expect(estimatePromptTokens(truncated)).toBeLessThanOrEqual(10);
    expect(truncated).not.toMatch(/[\uD800-\uDBFF]$/); // no dangling high surrogate
  });
});
