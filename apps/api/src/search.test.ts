import type { Actor } from "@rakazo/contracts";
import { CHAT_GROUP_KIND_STANDARD, type PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { querySpaceSearch } from "./search.js";

const actor: Actor = { spaceId: "space-test", userId: "user-test" };

function fixture(count: number) {
  const artifacts = Array.from({ length: count }, (_, index) => ({
    id: `artifact-${index}`,
    botId: `bot-${index}`,
    bot: { name: "Bot" },
    name: "report.txt",
    mimeType: "text/plain",
    size: 10,
  }));
  const groupArtifacts = artifacts.map((artifact) => ({
    ...artifact,
    id: `group-${artifact.id}`,
    botId: null,
    bot: null,
    groupId: "group-test",
    group: { name: "Group" },
  }));
  const prisma = {
    bot: { findMany: vi.fn().mockResolvedValue([]) },
    chatGroup: { findMany: vi.fn().mockResolvedValue([]) },
    artifact: {
      findMany: vi.fn().mockResolvedValueOnce(artifacts).mockResolvedValueOnce(groupArtifacts),
    },
    routine: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  return { prisma, artifacts, groupArtifacts };
}

describe("artifact search batching", () => {
  it.each([1, 25])("uses one lookup per destination for %i matching artifacts", async (count) => {
    const { prisma } = fixture(count);
    await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report");
    // Two artifact batches and the existing direct/group message searches.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    const direct = prisma.$queryRaw.mock.calls[0]?.[0];
    const group = prisma.$queryRaw.mock.calls[1]?.[0];
    expect(direct.text).toContain('t."botId" = candidate."targetId"');
    expect(group.text).toContain('t."groupId" = candidate."targetId"');
    for (const query of [direct, group]) {
      expect(query.values).toContain(actor.spaceId);
      expect(query.values).toContain(actor.userId);
      expect(query.text).toContain('ORDER BY m."createdAt" DESC');
    }
  });

  it("preserves artifact priority and skips missing messages regardless of batch row order", async () => {
    const { prisma } = fixture(3);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { artifactId: "artifact-2", id: "message-2", seq: 8 },
        { artifactId: "artifact-0", id: "message-0", seq: 6 },
      ])
      .mockResolvedValueOnce([{ artifactId: "group-artifact-1", id: "group-message", seq: 3 }]);
    const hits = await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report");
    expect(hits.map(({ artifactId, messageId, seq }) => ({ artifactId, messageId, seq }))).toEqual([
      { artifactId: "artifact-0", messageId: "message-0", seq: 6 },
      { artifactId: "artifact-2", messageId: "message-2", seq: 8 },
      { artifactId: "group-artifact-1", messageId: "group-message", seq: 3 },
    ]);
  });

  it("does not issue artifact queries for empty batches", async () => {
    const { prisma } = fixture(0);
    expect(await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report")).toEqual([]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("hidden agent_pair exclusion", () => {
  /** Tagged-template `$queryRaw` calls receive the literal parts, not a Prisma.sql object. */
  function rawSql(call: unknown[] | undefined): string {
    return (call?.[0] as string[] | undefined)?.join("?") ?? "";
  }

  it("keeps pair groups, pair messages and pair files out of search", async () => {
    const { prisma } = fixture(1);
    await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report");

    expect(prisma.chatGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ kind: CHAT_GROUP_KIND_STANDARD }),
      }),
    );

    // The second artifact batch is the group-scoped one.
    const groupArtifactQuery = prisma.artifact.findMany.mock.calls[1]?.[0];
    expect(groupArtifactQuery.where.group).toEqual({ is: { kind: CHAT_GROUP_KIND_STANDARD } });

    // Raw batches: 0-1 artifact messages, 2 bot messages, 3 group messages.
    const groupMessages = prisma.$queryRaw.mock.calls[3];
    expect(rawSql(groupMessages)).toContain("g.kind =");
    expect(groupMessages?.slice(1)).toContain(CHAT_GROUP_KIND_STANDARD);
  });

  it("leaves the Bot message search alone, since pair threads have no botId", async () => {
    const { prisma } = fixture(0);
    await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report");

    const botMessages = rawSql(prisma.$queryRaw.mock.calls[0]);
    expect(botMessages).toContain('INNER JOIN bots b ON b.id = t."botId"');
    expect(botMessages).not.toContain("g.kind");
  });
});
