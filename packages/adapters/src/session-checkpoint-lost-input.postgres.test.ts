import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeEvent, AgentSessionCheckpointProof } from "@rakazo/adapter-kit";
import { MarkdownMemoryStore } from "@rakazo/memory";
import {
  acknowledgeSessionCheckpoint,
  agentScopeChatSessionKey,
  computerHomeKey,
  computerScopeKey,
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  createThreadEvents,
  recordCheckpointProof,
  sessionCheckpointId,
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
 * PR #126 review P2 ③: the lost-input-request rebuild pauses the Run on a fresh
 * card BEFORE this Attempt ever enters the Runtime. It must therefore release
 * the admission like every other pre-runtime path; parking it in recovering
 * under a binding no Java checkpoint can prove kept the session blocked even
 * after the user answered, and dragged other Runs on the same session in.
 */
describePostgres("lost input request rebuild (PostgreSQL)", () => {
  const id = randomUUID();
  let isolated: IsolatedPostgresDatabase | undefined;
  let prisma: PrismaClient;
  let dataDir: string;
  let computerId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase("lost_input");
    prisma = isolated.db.prisma;
    dataDir = await mkdtemp(path.join(tmpdir(), "wp-lost-input-"));
    await prisma.user.create({
      data: { id, name: "Lost input test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Lost input test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Lost input test" } });
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
    constructor(private readonly events: AgentRuntimeEvent[] = []) {
      super({ baseUrl: "http://127.0.0.1:9" });
    }

    // The rebuild returns before any model turn; a later claim streams the
    // scripted events instead of talking to a Java process.
    override run(): AsyncIterableIterator<AgentRuntimeEvent> {
      const scripted = this.events;
      return (async function* () {
        for (const event of scripted) yield event;
      })();
    }

    public override inspectAndDetach(): Promise<AgentSessionCheckpointProof> {
      throw new Error("the Runtime must not be probed for the lost-request rebuild");
    }
  }

  function executor(runtime: AgentScopeAgentRuntime) {
    const secretStore = new EncryptedSecretStore("lost-input-fixture-encryption-key");
    return createRunExecutor({
      prisma,
      events: createThreadEvents(prisma),
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
      runtime,
      sandbox: new FakeSandboxProvider(),
      memory: new MarkdownMemoryStore(prisma),
      memoryProviders: new SpaceMemoryProviderResolver(prisma, secretStore),
      memoryDigestKey: "lost-input-digest-key",
      home: new LocalAgentHomeStore(dataDir),
      artifacts: new LocalArtifactStore(dataDir),
      dataDir,
      secrets: [],
      secretStore,
      deploymentModelKey: "test-deployment-key",
    } as unknown as Parameters<typeof createRunExecutor>[0]);
  }

  /**
   * The exact crash-window state: an acknowledged detached checkpoint whose
   * pending call is ask_user, its admission already released, the Run requeued,
   * and NO Intervention — the card was lost with the worker.
   */
  async function lostAskRun(label: string) {
    const bot = await prisma.bot.create({
      data: {
        spaceId: id,
        userId: id,
        name: `Lost ${label}`,
        color: "test",
        computerId,
      },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const task = await prisma.task.create({
      data: { spaceId: id, userId: id, botId: bot.id, threadId: thread.id, prompt: "Resume me", status: "running" },
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
    const sessionKey = agentScopeChatSessionKey({
      userId: id,
      spaceId: id,
      botId: bot.id,
      threadId: thread.id,
      threadGeneration: 0,
    });
    const binding = {
      sessionKey,
      runId: run.id,
      attemptId: `attempt-lost-${randomUUID()}`,
      executionId: `exec-lost-${randomUUID()}`,
      admissionFence: 1,
      suspensionKey: `susp-lost-${randomUUID()}`,
    };
    const proof: AgentSessionCheckpointProof = {
      kind: "detached",
      checkpointId: sessionCheckpointId(binding),
      digest: "f".repeat(64),
      pendingCalls: [{ id: "call-ask", name: "ask_user", state: "asking" }],
    };
    await recordCheckpointProof(prisma, { binding, proof, threadGeneration: 0 });
    const acknowledged = await acknowledgeSessionCheckpoint(prisma, {
      binding,
      proof,
      pendingInterventionId: null,
      coveredMessageSeq: 0,
    });
    expect(acknowledged).toBe(true);
    return { bot, thread, run, sessionKey, binding, proof };
  }

  it("releases the admission after rebuilding the lost input request, and the answered card still resumes the checkpoint", async () => {
    const fixture = await lostAskRun("rebuild");
    const { run, sessionKey, binding } = fixture;
    const checkpointId = sessionCheckpointId(binding);

    // Phase 1: the claim rebuilds the ask card and returns without entering the
    // Runtime. The admission must come back to available, not recovering.
    await executor(new FakeAgentScopeRuntime()).continueRun(run.id, "worker-lost-1");

    const admission = await prisma.agentSessionAdmission.findUniqueOrThrow({
      where: { sessionKey },
    });
    expect(admission.state).toBe("available");
    expect(admission.state).not.toBe("recovering");

    const rebuilt = await prisma.intervention.findFirstOrThrow({
      where: { runId: run.id, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "waiting_input",
      leaseOwner: null,
    });
    // The checkpoint stays unconsumed and is bound to the replacement card.
    expect(
      await prisma.agentSessionCheckpoint.findUniqueOrThrow({ where: { id: checkpointId } }),
    ).toMatchObject({ status: "recorded", pendingInterventionId: rebuilt.id });

    // Phase 2: the user answers (card settled, Run requeued) and the next claim
    // resumes through the normal checkpoint path and consumes it.
    await prisma.intervention.update({
      where: { id: rebuilt.id },
      data: {
        status: "answered",
        revision: { increment: 1 },
        resolvedByUserId: id,
        decision: "yes, continue",
        pendingRunKey: null,
      },
    });
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: "queued",
        waitKind: null,
        waitStartedAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });

    const resumed = new FakeAgentScopeRuntime([
      { type: "text", text: "Resumed with your answer." },
      { type: "done", text: "Resumed with your answer." },
    ]);
    await executor(resumed).continueRun(run.id, "worker-lost-2");

    expect(
      await prisma.agentSessionCheckpointResume.count({ where: { checkpointId } }),
    ).toBeGreaterThan(0);
    expect(
      await prisma.agentSessionCheckpoint.findUniqueOrThrow({ where: { id: checkpointId } }),
    ).toMatchObject({ status: "consumed" });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "completed",
    });
    expect(
      (await prisma.agentSessionAdmission.findUniqueOrThrow({ where: { sessionKey } })).state,
    ).not.toBe("recovering");
  }, 120_000);
});
