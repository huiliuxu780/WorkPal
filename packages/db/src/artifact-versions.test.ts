import { describe, expect, it, vi } from "vitest";
import {
  deleteArtifactRowWithDetachEvent,
  resolveNextArtifactVersion,
  withResolvedArtifactVersion,
} from "./artifact-versions.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

function versionConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

const params = {
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  name: "Q3 Content Calendar",
};

describe("resolveNextArtifactVersion", () => {
  it("starts a new family at version 1 when nothing matches", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { artifact: { findFirst } } as unknown as Pick<PrismaClient, "artifact">;

    const result = await resolveNextArtifactVersion(prisma, params);

    expect(result).toEqual({ rootArtifactId: null, version: 1 });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "space-1",
          userId: "user-1",
          botId: "bot-1",
          groupId: null,
          name: { equals: "Q3 Content Calendar", mode: "insensitive" },
        }),
      }),
    );
  });

  it("versions off the root when the only prior match is itself the root", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "artifact-root",
      rootArtifactId: null,
      version: 1,
    });
    const prisma = { artifact: { findFirst } } as unknown as Pick<PrismaClient, "artifact">;

    const result = await resolveNextArtifactVersion(prisma, params);

    expect(result).toEqual({ rootArtifactId: "artifact-root", version: 2 });
  });

  it("keeps pointing at the same root for a later version, not the previous version's own id", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "artifact-v2",
      rootArtifactId: "artifact-root",
      version: 2,
    });
    const prisma = { artifact: { findFirst } } as unknown as Pick<PrismaClient, "artifact">;

    const result = await resolveNextArtifactVersion(prisma, params);

    expect(result).toEqual({ rootArtifactId: "artifact-root", version: 3 });
  });

  it("matches by name case-insensitively and scopes to the group when given one", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { artifact: { findFirst } } as unknown as Pick<PrismaClient, "artifact">;

    await resolveNextArtifactVersion(prisma, { ...params, groupId: "group-1" });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ groupId: "group-1" }),
      }),
    );
  });
});

function versioningClient(findFirst: (...args: unknown[]) => unknown) {
  const order: string[] = [];
  const queryRaw = vi.fn().mockImplementation(async () => {
    order.push("lock");
    return [{ lock: "1" }];
  });
  const reading = vi.fn(async (...args: unknown[]) => {
    order.push("read");
    return findFirst(...args);
  });
  const tx = { artifact: { findFirst: reading }, $queryRaw: queryRaw };
  const transaction = vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
  return {
    prisma: { $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">,
    order,
    queryRaw,
    transaction,
    tx,
  };
}

describe("withResolvedArtifactVersion", () => {
  it("locks the name, then resolves and writes inside that transaction", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const client = versioningClient(findFirst);
    const attempt = vi.fn().mockImplementation(async () => {
      client.order.push("write");
      return "created-row";
    });

    const result = await withResolvedArtifactVersion(client.prisma, params, attempt);

    expect(result).toBe("created-row");
    expect(client.order).toEqual(["lock", "read", "write"]);
    expect(attempt).toHaveBeenCalledWith(client.tx, { rootArtifactId: null, version: 1 });
    const lockSql = client.queryRaw.mock.calls[0]?.[0] as { strings: string[]; values: unknown[] };
    expect(lockSql.strings.join(" ")).toContain("pg_advisory_xact_lock");
    expect(lockSql.values).toContain(
      ["space-1", "user-1", "bot-1", "", "q3 content calendar"].join("\u001f"),
    );
  });

  it("re-resolves and retries on a version-uniqueness conflict, seeing the winner's row", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "artifact-root", rootArtifactId: null, version: 1 });
    const client = versioningClient(findFirst);
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(versionConflict())
      .mockResolvedValueOnce("row-v2");

    const result = await withResolvedArtifactVersion(client.prisma, params, attempt);

    expect(result).toBe("row-v2");
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(client.transaction).toHaveBeenCalledTimes(2);
    expect(attempt).toHaveBeenNthCalledWith(1, client.tx, { rootArtifactId: null, version: 1 });
    expect(attempt).toHaveBeenNthCalledWith(2, client.tx, {
      rootArtifactId: "artifact-root",
      version: 2,
    });
  });

  it("propagates a non-conflict error without retrying", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const client = versioningClient(findFirst);
    const boom = new Error("storage put failed");
    const attempt = vi.fn().mockRejectedValue(boom);

    await expect(withResolvedArtifactVersion(client.prisma, params, attempt)).rejects.toBe(boom);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(client.transaction).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting its retry budget on persistent conflicts", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const client = versioningClient(findFirst);
    const attempt = vi.fn().mockRejectedValue(versionConflict());

    await expect(withResolvedArtifactVersion(client.prisma, params, attempt)).rejects.toThrow(
      "Unique constraint failed",
    );
    expect(attempt).toHaveBeenCalledTimes(5);
  });
});

describe("deleteArtifactRowWithDetachEvent", () => {
  const artifact = {
    id: "artifact-1",
    runId: "run-1",
    name: "report.pdf",
    mimeType: "application/pdf",
    size: 12,
  };

  it("propagates an event write failure so the caller's transaction rolls the deletion back", async () => {
    const tx = {
      artifact: { delete: vi.fn().mockResolvedValue({}) },
      run: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ threadId: "thread-1", botId: "bot-1", spaceId: "space-1" }),
      },
      thread: { update: vi.fn().mockRejectedValue(new Error("event write failed")) },
      event: { create: vi.fn() },
    };
    await expect(deleteArtifactRowWithDetachEvent(tx as never, artifact)).rejects.toThrow(
      "event write failed",
    );
    // The delete was attempted inside the same transaction; a real tx rolls it
    // back with the failed event — the row cannot outlive a missing event.
    expect(tx.artifact.delete).toHaveBeenCalledOnce();
  });

  it("deletes without an event when the Artifact belongs to no Run", async () => {
    const tx = {
      artifact: { delete: vi.fn().mockResolvedValue({}) },
      run: { findUnique: vi.fn() },
      thread: { update: vi.fn() },
    };
    expect(await deleteArtifactRowWithDetachEvent(tx as never, { ...artifact, runId: null })).toBe(
      true,
    );
    expect(tx.run.findUnique).not.toHaveBeenCalled();
    expect(tx.thread.update).not.toHaveBeenCalled();
  });

  it("treats an already-gone row as a no-op", async () => {
    const gone = new Prisma.PrismaClientKnownRequestError("not found", {
      code: "P2025",
      clientVersion: "test",
    });
    const tx = {
      artifact: { delete: vi.fn().mockRejectedValue(gone) },
      run: { findUnique: vi.fn() },
    };
    expect(await deleteArtifactRowWithDetachEvent(tx as never, artifact)).toBe(false);
    expect(tx.run.findUnique).not.toHaveBeenCalled();
  });
});
