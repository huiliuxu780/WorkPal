import { describe, expect, it, vi } from "vitest";
import type { MemoryFact, PrismaClient } from "@rakazo/db";
import {
  buildFactProjectionContent,
  filterStaleFactProjections,
  formatFactForRecall,
} from "./memory-recall.js";

function fact(overrides: Partial<MemoryFact> & { id: string }): MemoryFact {
  return {
    text: "sample",
    literalValues: null,
    ...overrides,
  } as MemoryFact;
}

describe("formatFactForRecall", () => {
  it("renders text with restricted literals as data", () => {
    expect(formatFactForRecall(fact({ id: "f1", text: "Deploy host" }))).toBe("Deploy host");
    expect(
      formatFactForRecall(
        fact({ id: "f1", text: "Deploy command", literalValues: { cmd: "deploy --prod" } }),
      ),
    ).toBe("Deploy command [cmd=deploy --prod]");
  });
});

describe("buildFactProjectionContent", () => {
  it("embeds the fact id marker so recall can validate against first-party state", () => {
    expect(buildFactProjectionContent(fact({ id: "fact-9", text: "Likes tables" }))).toBe(
      "[wp-fact:fact-9] Likes tables",
    );
  });
});

describe("filterStaleFactProjections", () => {
  const prisma = (rows: Array<{ id: string; state: string; expiresAt: Date | null }>) =>
    ({
      memoryFact: { findMany: vi.fn(async () => rows) },
    }) as unknown as PrismaClient;

  it("drops projections whose fact was deleted or expired", async () => {
    const results = [
      { memory: "[wp-fact:gone] deleted proposition" },
      { memory: "[wp-fact:old] expired window", id: "x" },
      { memory: "[wp-fact:live] active proposition" },
      { memory: "legacy external memory without a marker" },
    ];
    const kept = await filterStaleFactProjections(
      prisma([
        { id: "live", state: "active", expiresAt: null },
        { id: "old", state: "active", expiresAt: new Date(Date.now() - 1000) },
        // "gone" is absent: tombstoned rows are purged from reads.
      ]),
      results,
      "space-1",
    );
    expect(kept.map((entry) => entry.memory)).toEqual([
      "[wp-fact:live] active proposition",
      "legacy external memory without a marker",
    ]);
  });

  it("passes unmarked entries through untouched and skips the query entirely", async () => {
    const findMany = vi.fn();
    const kept = await filterStaleFactProjections(
      { memoryFact: { findMany } } as unknown as PrismaClient,
      [{ memory: "plain legacy recall" }],
      "space-1",
    );
    expect(kept).toEqual([{ memory: "plain legacy recall" }]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
