import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { enrichFileArtifactBlocks } from "./artifact-families.js";

function message(id: string, blocks: ThreadMessage["blocks"]): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    blocks,
    botId: "bot-1",
    createdAt: "2026-10-30T00:00:00.000Z",
  };
}

const fileBlock: Extract<ThreadMessage["blocks"][number], { kind: "file" }> = {
  kind: "file",
  artifactId: "artifact-2",
  mimeType: "text/html",
  name: "report.html",
  size: 12,
};

describe("enrichFileArtifactBlocks", () => {
  it("backfills family id, version and latest published version", async () => {
    const prisma = {
      artifact: {
        findMany: vi.fn(async () => [
          { id: "artifact-2", rootArtifactId: "artifact-1", version: 2 },
        ]),
      },
      $queryRaw: vi.fn(async () => [{ familyId: "artifact-1", latestVersion: 3 }]),
    };
    const result = await enrichFileArtifactBlocks(
      prisma as unknown as Parameters<typeof enrichFileArtifactBlocks>[0],
      [message("m1", [fileBlock])],
    );
    expect(result[0].blocks[0]).toEqual({
      ...fileBlock,
      rootArtifactId: "artifact-1",
      version: 2,
      latestVersion: 3,
    });
  });

  it("keeps blocks whose artifact no longer exists", async () => {
    const prisma = {
      artifact: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn(async () => []),
    };
    const result = await enrichFileArtifactBlocks(
      prisma as unknown as Parameters<typeof enrichFileArtifactBlocks>[0],
      [message("m1", [fileBlock])],
    );
    expect(result[0].blocks[0]).toEqual(fileBlock);
  });

  it("does not touch messages without file blocks", async () => {
    const prisma = {
      artifact: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn(async () => []),
    };
    const text = message("m1", [{ kind: "text", text: "hello" }]);
    const result = await enrichFileArtifactBlocks(
      prisma as unknown as Parameters<typeof enrichFileArtifactBlocks>[0],
      [text],
    );
    expect(result).toEqual([text]);
  });
});
