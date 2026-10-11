import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { evaluateBotToolCapability } from "./capability-permission.js";

describe("live Bot tool capability", () => {
  it("re-reads a changed deny rule before an approved tool replay", async () => {
    let rules: unknown = null;
    const findUnique = vi.fn(async () => ({ capabilityRules: rules, archivedAt: null }));
    const prisma = { bot: { findUnique } } as unknown as PrismaClient;
    expect((await evaluateBotToolCapability(prisma, "bot-1", "write_file", { path: "shared/x" })).decision).toBeNull();
    rules = [{ capability: "write_file", resource: "shared/**", scope: "bot", effect: "deny" }];
    expect((await evaluateBotToolCapability(prisma, "bot-1", "write_file", { path: "shared/x" })).decision).toBe("deny");
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("blocks malformed rules and archived Bots", async () => {
    const prisma = { bot: { findUnique: vi.fn(async () => ({ capabilityRules: [{}], archivedAt: null })) } } as unknown as PrismaClient;
    expect((await evaluateBotToolCapability(prisma, "bot-1", "read_file", { path: "x" })).error).toMatch(/invalid/);
    const archived = { bot: { findUnique: vi.fn(async () => ({ capabilityRules: null, archivedAt: new Date() })) } } as unknown as PrismaClient;
    expect((await evaluateBotToolCapability(archived, "bot-1", "read_file", { path: "x" })).decision).toBe("deny");
  });

  it("cannot hide a production connector target behind a benign argument", async () => {
    const prisma = { bot: { findUnique: vi.fn(async () => ({ capabilityRules: null, archivedAt: null })) } } as unknown as PrismaClient;
    const result = await evaluateBotToolCapability(
      prisma, "bot-1", "delete_record", { path: "dev" }, "production/customers",
    );
    expect(result.decision).toBe("deny");
  });
});
