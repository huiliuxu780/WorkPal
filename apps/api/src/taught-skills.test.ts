import type { Actor, MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createTaughtSkillsService, type TaughtSkillsDeps } from "./taught-skills.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

function skillRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "skill-1",
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId: "bot-1",
    name: "Weekly digest",
    goal: "Summarize the week.",
    status: "draft",
    playbook: {},
    recording: {},
    startedAt: null,
    expiresAt: null,
    stoppedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function draftBlock(status: "draft" | "saved" | "discarded" = "draft"): MessageBlock {
  return {
    kind: "skill_draft",
    skillId: "skill-1",
    name: "Weekly digest",
    goal: "Summarize the week.",
    playbook: {
      whenToUse: "Friday",
      inputs: [],
      steps: ["Read"],
      howToCheck: "Bullets",
      whatToReturn: "Summary",
      approvalBoundaries: "None",
      failureHandling: "Stop",
    },
    status,
  };
}

function setup() {
  const rows = [skillRow()];
  const message = {
    id: "message-1",
    seq: 4,
    blocks: [draftBlock()] as MessageBlock[],
  };
  const operations: string[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const findFirst = vi.fn(
    async ({ where }: { where: { id: string; spaceId: string; userId: string } }) => {
      const found = rows.find(
        (row) =>
          row.id === where.id && row.spaceId === where.spaceId && row.userId === where.userId,
      );
      return found ?? null;
    },
  );
  const tx = {
    bot: {
      findUnique: vi.fn(async () => ({ id: "bot-1", thread: { id: "thread-1" } })),
    },
    message: {
      findMany: vi.fn(async () => [message]),
      update: vi.fn(async ({ data }: { data: { blocks: MessageBlock[] } }) => {
        operations.push("message.update");
        message.blocks = data.blocks;
        return message;
      }),
    },
    thread: {
      update: vi.fn(async () => ({ nextEventSeq: 2 })),
    },
    event: {
      create: vi.fn(async ({ data }: { data: { type: string; payload: unknown } }) => {
        operations.push("event.create");
        events.push({ type: data.type, payload: data.payload as Record<string, unknown> });
        return { ...data, seq: 1 };
      }),
    },
    taughtSkill: {
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        operations.push("taughtSkill.delete");
        const index = rows.findIndex((row) => row.id === where.id);
        if (index >= 0) rows.splice(index, 1);
        return { id: where.id };
      }),
    },
  };
  const prisma = {
    taughtSkill: { findFirst },
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    events: {
      append: vi.fn(),
      notify: vi.fn(async () => undefined),
    },
    jobs: { cancel: vi.fn(), enqueue: vi.fn() },
    sandbox: {},
    home: {},
    dataDir: "/tmp/taught-skills-test",
  } as unknown as TaughtSkillsDeps;
  return {
    service: createTaughtSkillsService(deps),
    rows,
    message,
    operations,
    events,
    findFirst,
    tx,
    deps,
    prisma,
  };
}

describe("taught skill discard", () => {
  it("marks the message block discarded, emits the update event, then deletes the skill", async () => {
    const fixture = setup();

    await expect(fixture.service.remove(actor, "skill-1")).resolves.toEqual({ ok: true });

    expect(fixture.message.blocks).toEqual([
      expect.objectContaining({ kind: "skill_draft", skillId: "skill-1", status: "discarded" }),
    ]);
    expect(fixture.events).toEqual([
      {
        type: "thread.message.updated",
        payload: expect.objectContaining({
          messageId: "message-1",
          role: "bot",
          blocks: [expect.objectContaining({ status: "discarded" })],
        }),
      },
    ]);
    expect(fixture.operations).toEqual(["message.update", "event.create", "taughtSkill.delete"]);
    expect(fixture.rows).toEqual([]);
    expect(fixture.deps.events.notify).toHaveBeenCalledWith("thread-1", 1);
  });

  it("rejects a repeated discard without a second block or event write", async () => {
    const fixture = setup();
    await fixture.service.remove(actor, "skill-1");
    const updateCalls = fixture.tx.message.update.mock.calls.length;
    const eventCalls = fixture.tx.event.create.mock.calls.length;

    await expect(fixture.service.remove(actor, "skill-1")).rejects.toThrow();

    expect(fixture.tx.message.update).toHaveBeenCalledTimes(updateCalls);
    expect(fixture.tx.event.create).toHaveBeenCalledTimes(eventCalls);
    expect(fixture.message.blocks).toEqual([expect.objectContaining({ status: "discarded" })]);
  });

  it("rejects a different user or Space before touching the message", async () => {
    const fixture = setup();

    await expect(
      fixture.service.remove({ ...actor, userId: "user-2" }, "skill-1"),
    ).rejects.toThrow();
    await expect(
      fixture.service.remove({ ...actor, spaceId: "space-2" }, "skill-1"),
    ).rejects.toThrow();

    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
    expect(fixture.message.blocks).toEqual([expect.objectContaining({ status: "draft" })]);
    expect(fixture.rows).toHaveLength(1);
  });
});
