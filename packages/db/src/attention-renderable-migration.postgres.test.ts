import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-test-database.js";

const RENDERABLE_MIGRATION = "20261028230000_attention_renderable_projection";
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prisma/migrations",
);

function migrationNames() {
  return readdirSync(migrationsDir)
    .filter((name) => existsSync(path.join(migrationsDir, name, "migration.sql")))
    .sort();
}

async function applyMigrations(
  client: Client,
  shouldApply: (name: string) => boolean,
): Promise<void> {
  for (const name of migrationNames()) {
    if (!shouldApply(name)) continue;
    await client.query(readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8"));
  }
}

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

const VALID_PLAN_REVIEW = {
  content: {
    planId: "plan-1",
    contentVersion: 1,
    revision: 1,
    goal: "Ship the attention projection",
    items: [{ id: "item-1", title: "Persist eligibility", status: "pending" }],
    source: "publish_run_plan",
  },
};

describePostgres("attention renderable migration backfill (PostgreSQL)", () => {
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let databaseUrl: string;
  const ownerId = randomUUID();
  const spaceId = randomUUID();
  let botId: string;
  let threadId: string;
  const interventionIds: Record<string, string> = {};

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("attention_renderable_upgrade", {
      migrated: false,
    });
    prisma = isolated.db.prisma;
    databaseUrl = isolated.databaseUrl;
    const client = new Client({
      connectionString: databaseUrl,
      application_name: "wp_pre_renderable_migrate",
    });
    await client.connect();
    try {
      await applyMigrations(client, (name) => name < RENDERABLE_MIGRATION);
    } finally {
      await client.end();
    }
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
  }, 60_000);

  async function createRun(prompt: string) {
    const task = await prisma.task.create({
      data: {
        spaceId,
        botId,
        threadId,
        userId: ownerId,
        prompt,
        status: "waiting_input",
      },
    });
    return prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId: ownerId,
        status: "waiting_input",
        trigger: "user",
      },
    });
  }

  async function createPendingIntervention(
    key: string,
    kind: "input" | "approval" | "plan_review",
    extra: Record<string, unknown> = {},
  ) {
    const run = await createRun(key);
    const intervention = await prisma.intervention.create({
      data: {
        id: randomUUID(),
        revision: 1,
        kind,
        status: "pending",
        spaceId,
        threadId,
        runId: run.id,
        attemptId: "legacy",
        botId,
        messageId: randomUUID(),
        pendingRunKey: run.id,
        presentation: { text: key },
        ...extra,
      },
    });
    interventionIds[key] = intervention.id;
    return intervention;
  }

  it("recomputes renderable for every historical pending projection row", async () => {
    await prisma.user.create({
      data: {
        id: ownerId,
        name: "Renderable owner",
        email: `${ownerId}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id: ownerId, name: "Renderable org", slug: ownerId, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId: ownerId, name: "Renderable" },
    });
    await prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: ownerId,
        userId: ownerId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId,
        organizationId: ownerId,
        userId: ownerId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const bot = await prisma.bot.create({
      data: { spaceId, userId: ownerId, name: "Projection", color: "test" },
    });
    botId = bot.id;
    const thread = await prisma.thread.create({ data: { spaceId, userId: ownerId, botId } });
    threadId = thread.id;

    await createPendingIntervention("input", "input", { inputMode: "text" });
    await createPendingIntervention("valid-plan", "plan_review", {
      planReview: VALID_PLAN_REVIEW,
    });
    await createPendingIntervention("invalid-plan", "plan_review");
    const membership = await createPendingIntervention("invalid-membership", "approval");
    await prisma.groupMembershipRequest.create({
      data: {
        id: randomUUID(),
        spaceId,
        userId: ownerId,
        botId,
        groupId: randomUUID(),
        groupName: "Historical room",
        sourceThreadId: threadId,
        sourceRunId: membership.runId,
        cardMessageId: membership.messageId,
        interventionId: membership.id,
        deliveryKey: randomUUID(),
        requestRevision: 1,
        message: "Historical request",
        presentation: { text: "Add the Bot", extra: true } as never,
      },
    });

    const before = await prisma.$queryRaw<Array<{ interactionId: string }>>`
      SELECT "interactionId" FROM "attention_interventions"
      WHERE "interactionId" IN (${interventionIds["input"]}, ${interventionIds["valid-plan"]},
        ${interventionIds["invalid-plan"]}, ${interventionIds["invalid-membership"]})
    `;
    expect(before).toHaveLength(4);

    const client = new Client({
      connectionString: databaseUrl,
      application_name: "wp_renderable_migrate",
    });
    await client.connect();
    try {
      await applyMigrations(client, (name) => name === RENDERABLE_MIGRATION);
    } finally {
      await client.end();
    }

    const flags = await prisma.attentionIntervention.findMany({
      where: { interactionId: { in: Object.values(interventionIds) } },
      select: { interactionId: true, renderable: true },
    });
    const byId = new Map(flags.map((row) => [row.interactionId, row.renderable]));
    expect(byId.get(interventionIds["input"]!)).toBe(true);
    expect(byId.get(interventionIds["valid-plan"]!)).toBe(true);
    expect(byId.get(interventionIds["invalid-plan"]!)).toBe(false);
    expect(byId.get(interventionIds["invalid-membership"]!)).toBe(false);
  });
});
