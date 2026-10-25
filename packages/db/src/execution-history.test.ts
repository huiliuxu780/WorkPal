import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { loadExecutionSummariesForMessages } from "./execution-history.js";

/**
 * PD-01P read shape: one page of messages must cost ONE Run query, and the
 * legacy `Message.runId` path is only an extra link, never the authority.
 */
describe("message → Runs projection query shape", () => {
  const fakeDb = () => {
    const findMany = vi.fn(async () => []);
    return { db: { run: { findMany } } as unknown as PrismaClient, findMany };
  };

  it("queries every page message and legacy run id in one batched read", async () => {
    const { db, findMany } = fakeDb();

    await expect(
      loadExecutionSummariesForMessages(db, {
        threadId: "thread-1",
        spaceId: "space-1",
        messageIds: ["message-2", "message-1", "message-2"],
        runIds: ["run-legacy", "run-legacy"],
      }),
    ).resolves.toEqual([]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        threadId: "thread-1",
        spaceId: "space-1",
        OR: [
          { sourceMessageId: { in: ["message-1", "message-2"] } },
          { id: { in: ["run-legacy"] } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: expect.objectContaining({ id: true, sourceMessageId: true }),
    });
  });

  it("still reads a page with only legacy run ids", async () => {
    const { db, findMany } = fakeDb();

    await loadExecutionSummariesForMessages(db, {
      threadId: "thread-1",
      spaceId: "space-1",
      messageIds: [],
      runIds: ["run-legacy"],
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          spaceId: "space-1",
          OR: [{ id: { in: ["run-legacy"] } }],
        },
      }),
    );
  });

  it("does not query at all when the page has no messages and no run links", async () => {
    const { db, findMany } = fakeDb();

    await expect(
      loadExecutionSummariesForMessages(db, {
        threadId: "thread-1",
        spaceId: "space-1",
        messageIds: [],
      }),
    ).resolves.toEqual([]);

    expect(findMany).not.toHaveBeenCalled();
  });
});
