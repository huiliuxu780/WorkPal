import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { createThreadMessage, createThreadMessageInTransaction } from "./messages.js";

function transaction() {
  return {
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1 }) },
    run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
    message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
  };
}

describe("createThreadMessageInTransaction", () => {
  it("defaults unclassified legacy-style writes to unknown and records explicit trusted provenance", async () => {
    const tx = transaction();
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      threadId: "thread-1", role: "user", blocks: [{ kind: "text", text: "old" }],
    });
    expect(tx.message.create).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ originKind: "unknown", authorUserId: null }),
    }));
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      threadId: "thread-1", role: "user", blocks: [{ kind: "text", text: "new" }],
      originKind: "human_web", authorUserId: "user-1",
    });
    expect(tx.message.create).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ originKind: "human_web", authorUserId: "user-1" }),
    }));
  });

  it("rejects an author claim on a nonhuman entry before advancing sequence", async () => {
    const tx = transaction();
    await expect(createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      threadId: "thread-1", role: "user", blocks: [{ kind: "text", text: "forged" }],
      originKind: "webhook", authorUserId: "user-1",
    })).rejects.toThrow("Message author and origin are inconsistent");
    await expect(createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      threadId: "thread-1", role: "user", blocks: [{ kind: "text", text: "unowned" }],
      originKind: "human_web",
    })).rejects.toThrow("Message author and origin are inconsistent");
    expect(tx.thread.update).not.toHaveBeenCalled();
  });

  it("allows an automated bot message to opt out of unread without changing the default", async () => {
    const silent = transaction();
    await createThreadMessageInTransaction(silent as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "steps", steps: [{ label: "Checked status", count: 1 }] }],
      markUnread: false,
    });
    expect(silent.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: undefined }) }),
    );

    const visible = transaction();
    await createThreadMessageInTransaction(visible as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "text", text: "Daily report ready" }],
    });
    expect(visible.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: true }) }),
    );
  });
});

describe("createThreadMessage", () => {
  it("reruns the whole transaction after a mid-write deadlock", async () => {
    const deadlock = Object.assign(new Error("write conflict or a deadlock"), { code: "P2034" });
    const tx = transaction();
    // The sequence already advanced when the insert deadlocks; Postgres rolls both back.
    tx.message.create.mockRejectedValueOnce(deadlock);
    const run = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));

    await expect(
      createThreadMessage({ $transaction: run } as unknown as PrismaClient, {
        threadId: "thread-1",
        role: "bot",
        blocks: [{ kind: "text", text: "Done" }],
      }),
    ).resolves.toEqual({ id: "message-1" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(tx.thread.update).toHaveBeenCalledTimes(2);
    expect(tx.message.create).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", async () => {
    const run = vi.fn().mockRejectedValue(new Error("unique constraint"));

    await expect(
      createThreadMessage({ $transaction: run } as unknown as PrismaClient, {
        threadId: "thread-1",
        role: "user",
        blocks: [{ kind: "text", text: "hi" }],
      }),
    ).rejects.toThrow("unique constraint");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
