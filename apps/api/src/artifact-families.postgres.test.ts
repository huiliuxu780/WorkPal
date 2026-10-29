import { randomUUID } from "node:crypto";
import type { ThreadMessage } from "@rakazo/contracts";
import { createIsolatedPostgresDatabase, type IsolatedPostgresDatabase } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  enrichFileArtifactBlocks,
  findLatestPublishedArtifactRow,
  latestPublishedFamilyVersions,
} from "./artifact-families.js";
import { loadMessagePage } from "./thread-message-pages.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

type Owner = { userId: string; spaceId: string; botId: string; threadId: string; runId: string };

describePostgres("artifact families (PostgreSQL)", () => {
  let isolated: IsolatedPostgresDatabase;
  let prisma: IsolatedPostgresDatabase["db"]["prisma"];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("artifact_families");
    prisma = isolated.db.prisma;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  async function createOwner(label: string): Promise<Owner> {
    const id = `af-${label}-${randomUUID().slice(0, 8)}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    await prisma.user.create({
      data: { id: userId, name: "Owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Artifact families", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId: id, name: "Artifacts" } });
    await prisma.member.create({
      data: {
        id: `${id}-member`,
        organizationId: id,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: `${id}-sm`,
        spaceId,
        organizationId: id,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Chief", color: "#111111" },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId,
        prompt: "Publish a page",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId,
        status: "completed",
        trigger: "user",
      },
    });
    return { userId, spaceId, botId: bot.id, threadId: thread.id, runId: run.id };
  }

  async function createArtifact(
    owner: Owner,
    input: {
      version: number;
      rootArtifactId?: string;
      runId?: string | null;
    },
  ) {
    return prisma.artifact.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: owner.botId,
        runId: input.runId === undefined ? owner.runId : input.runId,
        name: "report.html",
        mimeType: "text/html",
        size: 12,
        hash: `hash-${randomUUID()}`,
        storageKey: `key-${randomUUID()}`,
        rootArtifactId: input.rootArtifactId,
        version: input.version,
      },
    });
  }

  async function publishMessage(owner: Owner, seq: number, artifactId: string) {
    return prisma.message.create({
      data: {
        threadId: owner.threadId,
        seq,
        role: "bot",
        botId: owner.botId,
        runId: owner.runId,
        blocks: [
          {
            kind: "file",
            artifactId,
            mimeType: "text/html",
            name: "report.html",
            size: 12,
          },
        ],
      },
    });
  }

  async function publishText(owner: Owner, seq: number, text: string) {
    return prisma.message.create({
      data: {
        threadId: owner.threadId,
        seq,
        role: "bot",
        botId: owner.botId,
        runId: owner.runId,
        blocks: [{ kind: "text", text }],
      },
    });
  }

  it("ignores artifact rows without a message and resolves the latest published row", async () => {
    const owner = await createOwner("latest");
    const first = await createArtifact(owner, { version: 1 });
    const unpublished = await createArtifact(owner, {
      version: 2,
      rootArtifactId: first.id,
    });
    const latest = await createArtifact(owner, { version: 3, rootArtifactId: first.id });
    const upload = await createArtifact(owner, {
      version: 4,
      rootArtifactId: first.id,
      runId: null,
    });
    await publishMessage(owner, 1, first.id);
    await publishMessage(owner, 2, latest.id);

    expect(await latestPublishedFamilyVersions(prisma, [first.id])).toEqual(
      new Map([[first.id, 3]]),
    );
    const resolved = await findLatestPublishedArtifactRow(
      prisma,
      { spaceId: owner.spaceId, userId: owner.userId, botId: owner.botId },
      first.id,
    );
    expect(resolved?.id).toBe(latest.id);
    expect(resolved?.id).not.toBe(unpublished.id);
    expect(resolved?.id).not.toBe(upload.id);
  });

  it("backfills family fields on old message blocks from the same read", async () => {
    const owner = await createOwner("enrich");
    const first = await createArtifact(owner, { version: 1 });
    const latest = await createArtifact(owner, { version: 2, rootArtifactId: first.id });
    const oldMessage = await publishMessage(owner, 1, first.id);
    await publishMessage(owner, 2, latest.id);

    const messages: ThreadMessage[] = [
      {
        id: oldMessage.id,
        threadId: owner.threadId,
        seq: oldMessage.seq,
        role: "bot",
        blocks: oldMessage.blocks as ThreadMessage["blocks"],
        botId: owner.botId,
        runId: owner.runId,
        createdAt: oldMessage.createdAt.toISOString(),
      },
    ];
    const enriched = await enrichFileArtifactBlocks(prisma, messages);
    expect(enriched[0].blocks[0]).toMatchObject({
      kind: "file",
      rootArtifactId: first.id,
      version: 1,
      latestVersion: 2,
    });
  });

  it("keeps the update state when history paging returns only the old card", async () => {
    const owner = await createOwner("page");
    const first = await createArtifact(owner, { version: 1 });
    const latest = await createArtifact(owner, { version: 2, rootArtifactId: first.id });
    await publishMessage(owner, 1, first.id);
    await publishText(owner, 2, "filler");
    await publishMessage(owner, 3, latest.id);
    await publishText(owner, 4, "tail");

    const page = await loadMessagePage(prisma, owner.threadId, 3, 2);
    expect(
      page.messages.some((message) =>
        message.blocks.some((block) => block.kind === "file" && block.artifactId === latest.id),
      ),
    ).toBe(false);
    const enriched = await enrichFileArtifactBlocks(prisma, page.messages);
    const oldCard = enriched
      .flatMap((message) => message.blocks)
      .find((block) => block.kind === "file" && block.artifactId === first.id);
    expect(oldCard).toMatchObject({
      rootArtifactId: first.id,
      version: 1,
      latestVersion: 2,
    });
  });
});
