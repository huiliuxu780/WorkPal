import type {
  AgentHomeStore,
  AgentRuntime,
  JobPublisher,
  MessagingSurface,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import { dispatchOneDeliveryBatch, settleDeliveryRun } from "./result-delivery.js";
import type { EncryptedSecretStore } from "./secrets.js";

vi.mock("./history-compaction.js", () => ({ compactHistory: vi.fn(async () => undefined) }));
vi.mock("./messaging-delivery.js", () => ({
  deliverMessagingOutbound: vi.fn(async () => undefined),
  mirrorMessagingOutbound: vi.fn(async () => undefined),
}));
vi.mock("./result-delivery.js", () => ({
  dispatchOneDeliveryBatch: vi.fn(async () => false),
  settleDeliveryRun: vi.fn(async () => undefined),
}));

describe("createBackgroundJobHandlers", () => {
  it("delivers directly when shutdown rejects a completed run's mirror job", async () => {
    const enqueueError = new Error("Background job publisher is closing");
    const jobs = {
      enqueue: vi.fn(async () => {
        throw enqueueError;
      }),
    } as unknown as JobPublisher;
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const handlers = createBackgroundJobHandlers({
      executor: {
        continueRun: vi.fn(async () => undefined),
      } as unknown as ReturnType<typeof createRunExecutor>,
      prisma: {} as unknown as PrismaClient,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime: {} as unknown as AgentRuntime,
      secretStore: {} as unknown as EncryptedSecretStore,
      memoryProviders: { resolve: vi.fn(async () => null) },
      memoryDigestKey: "test-digest-key",
      messaging: {} as unknown as MessagingSurface,
    });

    await handlers["run.continue"]({ runId: "run-1" });

    expect(settleDeliveryRun).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), jobs }),
      "run-1",
    );

    expect(mirrorMessagingOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), messaging: expect.anything(), jobs }),
      "run-1",
    );
    expect(deliverMessagingOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), messaging: expect.anything(), jobs }),
      { runId: undefined },
      expect.objectContaining({ operationId: "messaging.deliver:drain" }),
    );
    expect(sink.events.some((event) => event.message === "messaging.deliver enqueue error")).toBe(
      true,
    );
    installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
  });

  it("compacts the requested thread with the runtime, job publisher, and model key it was given", async () => {
    const prisma = {} as unknown as PrismaClient;
    const runtime = {} as unknown as AgentRuntime;
    const jobs = {} as unknown as JobPublisher;
    const secretStore = {} as unknown as EncryptedSecretStore;
    const memoryProviders = { resolve: vi.fn(async () => null) };
    const resolveModel = vi.fn();
    const handlers = createBackgroundJobHandlers({
      executor: { resolveModel } as unknown as ReturnType<typeof createRunExecutor>,
      prisma,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime,
      secretStore,
      memoryProviders,
      memoryDigestKey: "test-digest-key",
      deploymentModelKey: "openrouter-key",
    });

    await handlers["history.compact"]({ threadId: "thread-1" });

    expect(compactHistory).toHaveBeenCalledWith(
      {
        prisma,
        runtime,
        jobs,
        memoryProviders,
        deploymentModelKey: "openrouter-key",
        memoryDigestKey: "test-digest-key",
        resolveModel,
      },
      "thread-1",
    );
  });

  it("passes the pinned model identity from the job payload to compactHistory", async () => {
    const prisma = {} as unknown as PrismaClient;
    const runtime = {} as unknown as AgentRuntime;
    const jobs = {} as unknown as JobPublisher;
    const memoryProviders = { resolve: vi.fn(async () => null) };
    const resolveModel = vi.fn();
    const handlers = createBackgroundJobHandlers({
      executor: { resolveModel } as unknown as ReturnType<typeof createRunExecutor>,
      prisma,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime,
      secretStore: {} as unknown as EncryptedSecretStore,
      memoryProviders,
      memoryDigestKey: "test-digest-key",
    });

    await handlers["history.compact"]({
      threadId: "thread-1",
      sourceRunId: "run-9",
      modelProvider: "openrouter",
      modelId: "pinned/model",
    });

    expect(compactHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        pinnedModel: {
          modelProvider: "openrouter",
          modelId: "pinned/model",
          sourceRunId: "run-9",
        },
      }),
      "thread-1",
    );
  });

  it("passes the executor's connected-model resolver as the pinned resolver", async () => {
    const resolveModel = vi.fn();
    const resolveConnectedModel = vi.fn();
    const handlers = createBackgroundJobHandlers({
      executor: { resolveModel, resolveConnectedModel } as unknown as ReturnType<
        typeof createRunExecutor
      >,
      prisma: {} as unknown as PrismaClient,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs: {} as unknown as JobPublisher,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime: {} as unknown as AgentRuntime,
      secretStore: {} as unknown as EncryptedSecretStore,
      memoryProviders: { resolve: vi.fn(async () => null) },
      memoryDigestKey: "test-digest-key",
    });

    await handlers["history.compact"]({
      threadId: "thread-1",
      sourceRunId: "run-9",
      modelProvider: "openrouter",
      modelId: "pinned/model",
    });

    // The pinned identity must resolve through the same connected-model chain
    // (validation + user/Space credential lookup) the executor's inline
    // compaction path uses — never a separate or wider credential read (#93).
    expect(compactHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        pinnedModel: {
          modelProvider: "openrouter",
          modelId: "pinned/model",
          sourceRunId: "run-9",
        },
        resolvePinnedModel: resolveConnectedModel,
      }),
      "thread-1",
    );
  });

  it("stays fail-closed when the executor exposes no pinned-model resolver", async () => {
    const resolveModel = vi.fn();
    const handlers = createBackgroundJobHandlers({
      executor: { resolveModel } as unknown as ReturnType<typeof createRunExecutor>,
      prisma: {} as unknown as PrismaClient,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs: {} as unknown as JobPublisher,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime: {} as unknown as AgentRuntime,
      secretStore: {} as unknown as EncryptedSecretStore,
      memoryProviders: { resolve: vi.fn(async () => null) },
      memoryDigestKey: "test-digest-key",
    });

    await handlers["history.compact"]({
      threadId: "thread-1",
      modelProvider: "openrouter",
      modelId: "pinned/model",
    });

    const deps = vi.mocked(compactHistory).mock.calls.at(-1)![0];
    // No resolver → compactHistory keeps failing the pinned job closed
    // (pinned_model_resolver_missing); the unpinned fallback chain is
    // untouched for jobs without a pin.
    expect(deps.resolvePinnedModel).toBeUndefined();
    expect(deps.resolveModel).toBe(resolveModel);
  });

  it("drains due delivery batches", async () => {
    vi.mocked(dispatchOneDeliveryBatch).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const handlers = createBackgroundJobHandlers({
      executor: {} as ReturnType<typeof createRunExecutor>,
      prisma: {} as PrismaClient,
      sandbox: {} as SandboxProvider,
      home: {} as AgentHomeStore,
      jobs: {} as JobPublisher,
      events: {} as ThreadEvents,
      workerId: "worker-1",
      runtime: {} as AgentRuntime,
      secretStore: {} as EncryptedSecretStore,
      memoryProviders: { resolve: vi.fn(async () => null) },
      memoryDigestKey: "test-digest-key",
    });
    await handlers["delivery.dispatch"]({});
    expect(dispatchOneDeliveryBatch).toHaveBeenCalledTimes(2);
  });

  it("resolves the deployment model when no user credential is configured", async () => {
    const prisma = {
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      deploymentModelKey: "deployment-key",
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "workspace-1" }),
    ).resolves.toEqual({
      provider: "openrouter",
      id: "openai/gpt-5.6-luna",
      apiKey: "deployment-key",
      baseUrl: undefined,
      thinkingLevel: null,
      oauth: undefined,
    });
  });

  it("preserves a configured local model when resolving background compaction", async () => {
    const prisma = {
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          defaultModelProvider: "local",
          defaultModelId: "qwen3:4b",
        })),
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "workspace-1" }),
    ).resolves.toEqual({
      provider: "local",
      id: "qwen3:4b",
      apiKey: undefined,
      baseUrl: undefined,
      thinkingLevel: null,
      oauth: undefined,
    });
  });
});
