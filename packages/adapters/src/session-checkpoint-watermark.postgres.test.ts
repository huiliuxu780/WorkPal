import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeEvent, AgentSessionCheckpointProof } from "@rakazo/adapter-kit";
import { MarkdownMemoryStore } from "@rakazo/memory";
import {
  agentScopeChatSessionKey,
  computerHomeKey,
  computerScopeKey,
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  createThreadEvents,
  loadThreadContextAfterCheckpoint,
  type PrismaClient,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentScopeAgentRuntime } from "./agentscope-runtime.js";
import { LocalArtifactStore } from "./artifacts.js";
import { createRunExecutor } from "./executor.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";
import { SpaceMemoryProviderResolver } from "./memory-provider-factory.js";
import { EncryptedSecretStore } from "./secrets.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

/**
 * PR #126 review P2 ④: a suspended Run's checkpoint watermark is the highest
 * Thread message ACTUALLY ingested into its native state — never the newest
 * PostgreSQL row. Otherwise a parallel messaging Run B that wrote after Run A
 * loaded its history would be marked covered while absent from A's state, and
 * A's next resume would drop B's user message (possibly keeping only B's
 * reply, an answer without a question).
 */
describePostgres("checkpoint ingested watermark (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let dataDir: string;
  let computerId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("watermark");
    prisma = isolated.db.prisma;
    dataDir = await mkdtemp(path.join(tmpdir(), "wp-watermark-"));
    await prisma.user.create({
      data: { id, name: "Watermark test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Watermark test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Watermark test" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: { id, spaceId: id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const computer = await prisma.computer.create({
      data: {
        spaceId: id,
        userId: id,
        scope: "team",
        scopeKey: computerScopeKey("team", id),
        homeKey: computerHomeKey("team", id),
        kind: "sandbox",
      },
    });
    computerId = computer.id;
  }, 180_000);

  afterAll(async () => {
    await isolated?.drop();
    await rm(dataDir, { recursive: true, force: true });
  }, 60_000);

  class FakeAgentScopeRuntime extends AgentScopeAgentRuntime {
    constructor(
      private readonly scripted: {
        beforeEvents?: () => Promise<void>;
        events: AgentRuntimeEvent[];
      },
    ) {
      super({ baseUrl: "http://127.0.0.1:9" });
    }

    override run(): AsyncIterableIterator<AgentRuntimeEvent> {
      const scripted = this.scripted;
      return (async function* () {
        if (scripted.beforeEvents) await scripted.beforeEvents();
        for (const event of scripted.events) yield event;
      })();
    }

    override inspectAndDetach(
      ...args: Parameters<AgentScopeAgentRuntime["inspectAndDetach"]>
    ): Promise<AgentSessionCheckpointProof> {
      const [request] = args;
      return Promise.resolve({
        kind: "detached",
        checkpointId: request.checkpointId,
        digest: "a".repeat(64),
        pendingCalls: [{ id: "call-ask", name: "ask_user", state: "asking" }],
      });
    }
  }

  function executor(runtime: AgentScopeAgentRuntime) {
    const secretStore = new EncryptedSecretStore("watermark-fixture-encryption-key");
    return createRunExecutor({
      prisma,
      events: createThreadEvents(prisma),
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
      runtime,
      sandbox: new FakeSandboxProvider(),
      memory: new MarkdownMemoryStore(prisma),
      memoryProviders: new SpaceMemoryProviderResolver(prisma, secretStore),
      memoryDigestKey: "watermark-digest-key",
      home: new LocalAgentHomeStore(dataDir),
      artifacts: new LocalArtifactStore(dataDir),
      dataDir,
      secrets: [],
      secretStore,
      deploymentModelKey: "test-deployment-key",
    } as unknown as Parameters<typeof createRunExecutor>[0]);
  }

  it("covers only the messages the paused Run actually ingested, leaving the parallel Run's rows to the next resume", async () => {
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Watermark bot", color: "test", computerId },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Check the deploy",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "queued",
        trigger: "user",
      },
    });
    const trigger = await prisma.message.create({
      data: {
        threadId: thread.id,
        seq: 1,
        role: "user",
        originKind: "user",
        authorUserId: id,
        botId: bot.id,
        runId: run.id,
        blocks: [{ kind: "text", text: "Check the deploy" }],
      },
    });
    await prisma.run.update({ where: { id: run.id }, data: { sourceMessageId: trigger.id } });
    await prisma.thread.update({ where: { id: thread.id }, data: { nextMessageSeq: 2 } });

    // Run B posts a new user message AFTER Run A claimed and loaded its
    // history window (inside the stream turn), then A pauses on an ask card.
    const runtime = new FakeAgentScopeRuntime({
      beforeEvents: async () => {
        await prisma.message.create({
          data: {
            threadId: thread.id,
            seq: 2,
            role: "user",
            originKind: "user",
            authorUserId: id,
            blocks: [{ kind: "text", text: "The staging deploy, please" }],
          },
        });
        await prisma.thread.update({ where: { id: thread.id }, data: { nextMessageSeq: 3 } });
      },
      events: [
        {
          type: "ask",
          text: "Which environment: staging or production?",
          actions: [
            { id: "staging", label: "Staging" },
            { id: "production", label: "Production" },
          ],
        },
      ],
    });

    await executor(runtime).continueRun(run.id, "worker-wm-1");

    const checkpoint = await prisma.agentSessionCheckpoint.findFirstOrThrow({
      where: { runId: run.id },
    });
    const sessionKey = agentScopeChatSessionKey({
      userId: id,
      spaceId: id,
      botId: bot.id,
      threadId: thread.id,
      threadGeneration: 0,
    });
    expect(checkpoint).toMatchObject({
      sessionKey,
      status: "recorded",
      proofKind: "detached",
    });
    // The watermark stops at the newest message A ingested (seq 1); B's
    // seq-2 row and A's own pause card (seq 3+) stay uncovered.
    expect(checkpoint.coveredMessageSeq).toBe(1);

    // The next resume therefore still merges B's message into A's context.
    await expect(
      loadThreadContextAfterCheckpoint(prisma, {
        threadId: thread.id,
        afterSeq: checkpoint.coveredMessageSeq ?? 0,
        excludeRunId: run.id,
      }),
    ).resolves.toEqual([
      { seq: 2, role: "user", content: "The staging deploy, please" },
    ]);

    // The pause proof released the admission normally.
    const admission = await prisma.agentSessionAdmission.findUniqueOrThrow({
      where: { sessionKey },
    });
    expect(admission.state).toBe("available");
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "waiting_input",
    });
  }, 120_000);
});
