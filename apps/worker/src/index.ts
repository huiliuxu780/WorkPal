import { randomUUID } from "node:crypto";
import type { JobPublisher, JobWorkerHost } from "@rakazo/adapter-kit";
import { deliveryDispatchJob, memoryOutboxJob, runJobKey } from "@rakazo/adapter-kit";
import {
  compactionMarginsFromEnv,
  compactionModeFromEnv,
  ComposioConnector,
  enqueueLaggingMemoryExtractions,
  IntegrationProviderSettings,
  memoryJobsConfigFromEnv,
} from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";

loadRootEnv();

import {
  AgentlyMailService,
  AgentScopeAgentRuntime,
  ChatSdkMessagingSurface,
  CodexCatalogCache,
  createBackgroundJobHandlers,
  createCloudAgentConnection,
  createConnectorStack,
  createJobReconciler,
  createMessagingContextLoader,
  createPostgresReconciliationLeadership,
  createRunExecutor,
  createRunSandbox,
  deliverRunAborts,
  retryPendingBackgroundRevocations,
  retryPendingRunAborts,
  revokeCancellingBackgroundTasks,
  createRunSecretWriter,
  createWebProvider,
  databaseCapacityBackoffMs,
  EncryptedSecretStore,
  enforceRunBudgets,
  ExpoPushProvider,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
  InMemoryJobQueue,
  InstalledConnectorProvider,
  isComposioEnabled,
  isMessagingSurfaceEnabled,
  isPipedreamEnabled,
  LocalAgentHomeStore,
  LocalArtifactStore,
  McpConnector,
  McpOAuthBroker,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  PipedreamConnector,
  PostgresRealtimeFanout,
  pipedreamConfigFromEnv,
  reconcileCloudAgents,
  reconcileComputerUpdates,
  resolveDeploymentModel,
  resolveSandboxProvider,
  ScriptedAgentRuntime,
  SpaceMemoryProviderResolver,
  sandboxProviderOptionsFromEnv,
} from "@rakazo/adapters";
import {
  resolveEncryptionKey,
  resolveRoundtableFeatureGates,
  resolveSupervisorToken,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  cancelChildrenOfCancelledRuns,
  createDb,
  listDescendantRunIds,
  createThreadEvents,
  currentThreadGeneration,
  deriveMemoryDigestKey,
  enqueueDeliveryInTransaction,
  expireWaitingRuns,
  isTooManyDatabaseConnections,
  parsePositiveInteger,
} from "@rakazo/db";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { reconcileSessionAdmissions } from "./session-admission-reconciler.js";

const logger = createRootLogger(SERVICE_NAMES.worker);

async function main() {
  // Fail fast on invalid deployment gates. Consumed by the Intervention pause
  // path, which is the only roundtable entry point the Worker drives today.
  const roundtableFeatures = resolveRoundtableFeatureGates(process.env);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  // Shared by Prisma, the reconciliation leadership lock, and both graphile-worker
  // components (see GraphileJobPublisher/GraphileJobWorkerHost) — one pool instead
  // of four separate ones. Keep this modest: graphile holds a LISTEN client and
  // leadership holds an advisory-lock client for the process lifetime, and a
  // larger max just competes for Postgres max_connections (53300).
  const { prisma, pool } = createDb(databaseUrl, {
    poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 8),
    applicationName: "rakazo-worker",
  });
  const realtime = new PostgresRealtimeFanout({
    connectionString: process.env.REALTIME_DATABASE_URL ?? databaseUrl,
    publisher: pool,
  });
  const secrets = new EncryptedSecretStore(resolveEncryptionKey(process.env));
  const events = createThreadEvents(prisma, realtime, {
    runSecretWriter: createRunSecretWriter(secrets),
    roundtableFeatures,
  });
  // Task credentials and callbacks live in the Worker process. A stopped Worker cannot
  // resume a native local supplier; expire its projection after missed heartbeats.
  const reconcileBackgroundTasks = async () => {
    const now = new Date();
    const missedHeartbeat = new Date(now.getTime() - 120_000);
    const stale = await prisma.backgroundAgentTask.findMany({
      where: {
        status: "running",
        OR: [{ heartbeatAt: { lt: missedHeartbeat } }, { expiresAt: { lt: now } }],
      },
      take: 100,
    });
    for (const task of stale) {
      const eventSeq = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "threads" WHERE "id" = ${task.threadId} FOR UPDATE`;
        const updated = await tx.backgroundAgentTask.updateMany({
          where: {
            taskId: task.taskId,
            status: "running",
            OR: [{ heartbeatAt: { lt: missedHeartbeat } }, { expiresAt: { lt: now } }],
          },
          data: {
            status: "failed",
            finishedAt: now,
            error: "Runtime worker stopped or task credential expired; execution cannot resume",
          },
        });
        if (!updated.count) return null;
        if (task.threadGeneration !== (await currentThreadGeneration(tx, task.threadId)))
          return null;
        const parent = await tx.run.findUnique({
          where: { id: task.parentRunId },
          select: { status: true },
        });
        if (!parent || parent.status === "cancelled") return null;
        await appendEventInTransaction(tx, {
          spaceId: task.spaceId,
          threadId: task.threadId,
          botId: task.botId,
          runId: task.parentRunId,
          type: "subagent.failed",
          payload: {
            taskId: task.taskId,
            agentId: task.agentId,
            error: "Runtime worker stopped or task credential expired",
          },
        });
        await appendEventInTransaction(tx, {
          spaceId: task.spaceId,
          threadId: task.threadId,
          botId: task.botId,
          runId: task.parentRunId,
          type: "thread.subagent",
          payload: {
            agentId: task.taskId,
            name: task.agentId,
            task: "delegated task",
            status: "failed",
            result: "Runtime worker stopped or task credential expired",
          },
        });
        const delivery = await enqueueDeliveryInTransaction(tx, {
          runId: task.parentRunId,
          backgroundTaskId: task.taskId,
          threadId: task.threadId,
          threadGeneration: task.threadGeneration,
          kind: "background_task",
          idempotencyKey: `${task.taskId}:background_task`,
          createdAt: now,
        });
        if (!delivery) return null;
        const event = await appendEventInTransaction(tx, {
          spaceId: task.spaceId,
          threadId: task.threadId,
          botId: task.botId,
          runId: task.parentRunId,
          type: "delivery.created",
          payload: { deliveryId: delivery.id, sourceRunId: task.parentRunId },
        });
        return event.seq;
      });
      if (eventSeq !== null) await events.notify(task.threadId, eventSeq);
    }
  };
  const taskSweep = setInterval(() => {
    void reconcileBackgroundTasks().catch((error) =>
      logger.error("background task reconciliation", error),
    );
  }, 60_000);
  taskSweep.unref?.();
  void reconcileBackgroundTasks().catch((error) =>
    logger.error("background task reconciliation", error),
  );
  const dataDir = process.env.DATA_DIR ?? "./data";
  if (process.env.NODE_ENV === "production" && process.env.AGENT_RUNTIME === "scripted") {
    throw new Error("The scripted agent runtime is reserved for deterministic tests");
  }
  const runtime =
    process.env.AGENT_RUNTIME === "scripted"
      ? new ScriptedAgentRuntime()
      : (process.env.AGENT_RUNTIME ?? "agentscope") === "agentscope"
        ? new AgentScopeAgentRuntime({
            baseUrl: process.env.AGENTSCOPE_URL,
            toolBridgeBindHost: process.env.AGENTSCOPE_TOOL_BRIDGE_BIND_HOST,
            toolBridgePort: process.env.AGENTSCOPE_TOOL_BRIDGE_PORT
              ? Number(process.env.AGENTSCOPE_TOOL_BRIDGE_PORT)
              : undefined,
            toolBridgeUrl: process.env.AGENTSCOPE_TOOL_BRIDGE_URL,
          })
        : (() => {
            throw new Error(
              `Unsupported AGENT_RUNTIME=${process.env.AGENT_RUNTIME}; use agentscope (production) or scripted (tests)`,
            );
          })();
  const budgetSweep = setInterval(() => {
    void enforceRunBudgets({ prisma, events, runtime }).catch((error) =>
      logger.error("Run budget reconciliation", error),
    );
  }, 10_000);
  budgetSweep.unref?.();
  void enforceRunBudgets({ prisma, events, runtime }).catch((error) =>
    logger.error("Run budget reconciliation", error),
  );
  // Same resolver the API uses, so both processes agree on provider, model and key.
  const { key: deploymentModelKey } = resolveDeploymentModel();
  // ME-01/ME-02: one config object for every memory job, resolved once so the
  // worker never reads these knobs inline mid-job.
  const memoryConfig = memoryJobsConfigFromEnv();
  const memoryDigestKey = deriveMemoryDigestKey(resolveEncryptionKey(process.env));
  const sandboxProvider = resolveSandboxProvider(process.env);
  const sandbox = createRunSandbox(sandboxProvider, {
    ...sandboxProviderOptionsFromEnv(process.env),
    supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    supervisorToken: sandboxProvider === "docker" ? resolveSupervisorToken(process.env) : undefined,
    dataDir,
    prisma,
  });
  const allowPrivateEndpoint = process.env.MCP_ALLOW_PRIVATE_ENDPOINT === "true";
  const mcpOAuth = new McpOAuthBroker(prisma, secrets, {}, allowPrivateEndpoint);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: process.env.MCP_STDIO_ENABLED === "true",
      allowedCommands: (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      events,
      allowPrivateEndpoint,
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv({
    pipedreamClientId: process.env.PIPEDREAM_CLIENT_ID,
    pipedreamClientSecret: process.env.PIPEDREAM_CLIENT_SECRET,
    pipedreamProjectId: process.env.PIPEDREAM_PROJECT_ID,
    pipedreamEnvironment: process.env.PIPEDREAM_ENVIRONMENT,
    encryptionKey: resolveEncryptionKey(process.env),
  });
  const pipedream = isPipedreamEnabled(pipedreamConfig)
    ? new PipedreamConnector(pipedreamConfig)
    : undefined;
  // pollInboundMessages stays false (the default) here: this process
  // only ever sends outbound (messaging.deliver jobs). It must never poll
  // Telegram — that would steal the single getUpdates slot away from the
  // API process, which is the one with the inbound sink actually wired up.
  const messagingPlatforms = messagingPlatformsFromEnv(messagingEnvFromProcess(process.env));
  const messaging = isMessagingSurfaceEnabled(messagingPlatforms, {
    deploymentModelKey,
    openSignup: process.env.MESSAGING_OPEN_SIGNUP === "true",
  })
    ? new ChatSdkMessagingSurface(messagingPlatforms)
    : undefined;
  const integrationSettings = new IntegrationProviderSettings(
    prisma,
    secrets,
    resolveEncryptionKey(process.env),
    {
      composio: isComposioEnabled(process.env.COMPOSIO_API_KEY)
        ? new ComposioConnector(process.env.COMPOSIO_API_KEY)
        : undefined,
      pipedream,
    },
  );
  const stack = createConnectorStack(false, undefined, [
    new InstalledConnectorProvider(prisma, secrets, {}, allowPrivateEndpoint),
    ...integrationSettings.providers(),
    mcp,
  ]);
  const connector = stack.destination;
  await connector.start();
  integrationSettings.warmDirectories();
  const memoryProviders = new SpaceMemoryProviderResolver(prisma, secrets);
  const home = new LocalAgentHomeStore(dataDir);
  const artifacts = new LocalArtifactStore(dataDir);
  const inMemoryJobs = process.env.WAKEUP_DRIVER === "memory" ? new InMemoryJobQueue() : undefined;
  const jobs: JobPublisher = inMemoryJobs ?? new GraphileJobPublisher(pool);
  const admissionSweep =
    runtime instanceof AgentScopeAgentRuntime
      ? setInterval(() => {
          void reconcileSessionAdmissions(prisma, jobs).catch((error) =>
            logger.error("session admission reconciliation", error),
          );
        }, 10_000)
      : null;
  admissionSweep?.unref?.();
  if (admissionSweep) {
    void reconcileSessionAdmissions(prisma, jobs).catch((error) =>
      logger.error("session admission reconciliation", error),
    );
  }
  const reconcileWaitingRuns = async () => {
    const expired = await expireWaitingRuns(prisma);
    const descendantIds = await listDescendantRunIds(
      prisma,
      expired.map((run) => run.runId),
    );
    const runIds = [...new Set([...expired.map((run) => run.runId), ...descendantIds])];
    await Promise.all([
      ...runIds.map(async (runId) => {
        await jobs.cancel(runJobKey(runId)).catch(() => undefined);
      }),
      ...expired.map(async (run) => {
        await events.notify(run.threadId, run.seq);
      }),
    ]);
    const abortResult = await deliverRunAborts(prisma, (runId) => runtime.abort(runId), runIds);
    if (abortResult.pending.length) {
      logger.error("run abort pending retry", { pending: abortResult.pending });
    }
    if (runtime instanceof AgentScopeAgentRuntime) {
      const parentIds = [...expired.map((run) => run.runId), ...descendantIds];
      if (parentIds.length) {
        await revokeCancellingBackgroundTasks(
          prisma,
          (taskId, identity) => runtime.cancelBackgroundTask(taskId, identity),
          { parentRunIds: parentIds },
        ).catch((error) => {
          logger.error("wait-timeout background revocation failed; sweep will retry", error);
        });
      }
    }
    if (descendantIds.length === 0) return;
    const notices = await prisma.event.findMany({
      where: { runId: { in: descendantIds }, type: "run.cancelled" },
      select: { threadId: true, seq: true },
    });
    await Promise.all(
      notices.map((notice) =>
        events.notify(notice.threadId, notice.seq).catch((error) => {
          logger.error("wait-timeout descendant realtime notification", error);
        }),
      ),
    );
  };
  const waitSweep = setInterval(() => {
    void reconcileWaitingRuns().catch((error) =>
      logger.error("waiting run timeout reconciliation", error),
    );
  }, 60_000);
  waitSweep.unref?.();
  void reconcileWaitingRuns().catch((error) =>
    logger.error("waiting run timeout reconciliation", error),
  );
  const reconcileCancelledChildren = async () => {
    const cancelledRuns = await cancelChildrenOfCancelledRuns(prisma);
    for (const cancelled of cancelledRuns) {
      await Promise.all([
        jobs.cancel(runJobKey(cancelled.id)).catch(() => undefined),
        events.notify(cancelled.threadId, cancelled.seq),
      ]);
    }
    const abortResult = await deliverRunAborts(
      prisma,
      (runId) => runtime.abort(runId),
      cancelledRuns.map((cancelled) => cancelled.id),
    );
    if (abortResult.pending.length) {
      logger.error("child run abort pending retry", { pending: abortResult.pending });
    }
    if (runtime instanceof AgentScopeAgentRuntime && cancelledRuns.length) {
      await revokeCancellingBackgroundTasks(
        prisma,
        (taskId, identity) => runtime.cancelBackgroundTask(taskId, identity),
        { parentRunIds: cancelledRuns.map((run) => run.id) },
      ).catch((error) => {
        logger.error("child cancellation background revocation failed; sweep will retry", error);
      });
    }
  };
  const childCancellationSweep = setInterval(() => {
    void reconcileCancelledChildren().catch((error) =>
      logger.error("child Run cancellation reconciliation", error),
    );
  }, 10_000);
  childCancellationSweep.unref?.();
  void reconcileCancelledChildren().catch((error) =>
    logger.error("child Run cancellation reconciliation", error),
  );
  const revokeCancelledBackgroundTasks = async () => {
    const abortResult = await retryPendingRunAborts(prisma, (runId) => runtime.abort(runId));
    if (abortResult.pending.length) {
      logger.error("run abort retry", { pending: abortResult.pending });
    }
    if (!(runtime instanceof AgentScopeAgentRuntime)) return;
    const tombstones = await retryPendingBackgroundRevocations(prisma, (taskId, identity) =>
      runtime.cancelBackgroundTask(taskId, identity),
    );
    if (tombstones.pending.length) {
      logger.error("background tombstone retry", { pending: tombstones.pending });
    }
    const { pending } = await revokeCancellingBackgroundTasks(prisma, (taskId, identity) =>
      runtime.cancelBackgroundTask(taskId, identity),
    );
    if (pending.length) {
      logger.error("background task cancellation retry", { pending });
    }
  };
  const cancellationSweep = setInterval(() => {
    void revokeCancelledBackgroundTasks().catch((error) =>
      logger.error("background task cancellation reconciliation", error),
    );
  }, 10_000);
  cancellationSweep.unref?.();
  void revokeCancelledBackgroundTasks().catch((error) =>
    logger.error("background task cancellation reconciliation", error),
  );
  const jobHost: JobWorkerHost =
    inMemoryJobs ??
    new GraphileJobWorkerHost(pool, {
      concurrency: parsePositiveInteger(process.env.GRAPHILE_WORKER_CONCURRENCY, 4),
    });
  // One provider instance so emulator launches and polls share the same Map.
  const cloudAgent = createCloudAgentConnection();
  const executor = createRunExecutor({
    prisma,
    runtime,
    // Live per-account Codex catalog; never refreshes or writes credentials.
    codexCatalog: new CodexCatalogCache(),
    sandbox,
    memory: new MarkdownMemoryStore(prisma),
    memoryProviders,
    memoryDigestKey: memoryDigestKey,
    memoryFactsEnabled: memoryConfig.factsEnabled,
    memoryLegacyInjectionRetired:
      process.env.WORKPAL_MEMORY_LEGACY_INJECTION_RETIRED === "true",
    historyCompaction: {
      modeOverride: compactionModeFromEnv(),
      margins: compactionMarginsFromEnv(),
    },
    home,
    artifacts,
    roundtableFeatures,
    connector: stack.connector,
    connectors: stack.connector,
    listConnectedPluginSlugs: async (userId) => {
      const provider = await integrationSettings.resolve("composio");
      if (!provider) return [];
      return provider.listConnectedExternalIds({
        userId,
        spaceId: "",
        operationId: "connections.sync",
        traceId: "connections.sync",
        signal: AbortSignal.timeout(15_000),
      });
    },
    secrets: [
      deploymentModelKey ?? "",
      process.env.COMPOSIO_API_KEY ?? "",
      process.env.CURSOR_API_KEY ?? "",
      process.env.TYPESAFE_API_KEY ?? "",
    ].filter(Boolean),
    secretStore: secrets,
    mcpAllowPrivateEndpoint: process.env.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
    deploymentModelKey,
    dataDir,
    notifications: new ExpoPushProvider(dataDir),
    jobs,
    events,
    messaging: messaging ? createMessagingContextLoader(prisma) : undefined,
    web: createWebProvider(),
    cloudAgent,
    mail:
      process.env.AGENTLY_MAIL_ENABLED === "true"
        ? new AgentlyMailService({
            bin: (process.env.AGENTLY_MAIL_BIN ?? "").trim() || "agently-cli",
          })
        : null,
  });

  const jobHandlers = createBackgroundJobHandlers({
    executor,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    workerId: `${process.pid}-${randomUUID()}`,
    runtime,
    secretStore: secrets,
    memoryProviders,
    deploymentModelKey,
    memoryDigestKey,
    memoryConfig,
    messaging,
    cloudAgent,
  });
  // graphile-worker run() connects through the shared pool. createPool already
  // retries connect() on 53300 a finite number of times. Keep retrying start
  // until Postgres has capacity: exhausting then returning from main().catch
  // left a live process that held connections but never ran jobs or registered
  // signal handlers, even after capacity returned. Do not exit(1) here; that
  // crash-loops into the same saturated Postgres. GraphileJobWorkerHost also
  // observes runner.promise after start and restarts with the same backoff if
  // the runner dies later on 53300 (unhandledRejection still swallows that
  // code so we do not Docker crash-loop on transient completeJob failures).
  for (let attempt = 0; ; attempt += 1) {
    try {
      await jobHost.start(jobHandlers);
      break;
    } catch (error) {
      if (!isTooManyDatabaseConnections(error)) throw error;
      logger.error("worker job host start waiting on database capacity", error);
      await new Promise((resolve) => setTimeout(resolve, databaseCapacityBackoffMs(attempt)));
    }
  }
  const deliverySweep = setInterval(() => {
    void jobs
      .enqueue(deliveryDispatchJob())
      .catch((error) => logger.error("delivery dispatch scheduling", error));
  }, 10_000);
  deliverySweep.unref?.();
  void jobs
    .enqueue(deliveryDispatchJob())
    .catch((error) => logger.error("delivery dispatch scheduling", error));
  // ME-02: durable memory outbox drain (shard profiles, summary fan-out,
  // external index projection/cleanup) and the periodic extraction gap-filler.
  // Both stay off while the rollback switch disables the new memory layer.
  const memoryOutboxSweep = memoryConfig.factsEnabled
    ? setInterval(() => {
        void jobs
          .enqueue(memoryOutboxJob())
          .catch((error) => logger.error("memory.outbox scheduling", error));
      }, memoryConfig.outboxSweepMs)
    : null;
  memoryOutboxSweep?.unref?.();
  if (memoryOutboxSweep) {
    void jobs
      .enqueue(memoryOutboxJob())
      .catch((error) => logger.error("memory.outbox scheduling", error));
  }
  const memoryScanSweep = memoryConfig.factsEnabled
    ? setInterval(() => {
        void enqueueLaggingMemoryExtractions(prisma, jobs).catch((error) =>
          logger.error("memory.extract scan scheduling", error),
        );
      }, memoryConfig.scanSweepMs)
    : null;
  memoryScanSweep?.unref?.();
  const reconciler = createJobReconciler({
    prisma,
    jobs,
    events,
    leadership: createPostgresReconciliationLeadership(pool),
    reconcileCloudAgents: () => reconcileCloudAgents({ prisma, jobs, cloudAgent }),
    reconcileComputerUpdates: () => reconcileComputerUpdates({ prisma, jobs }),
  });
  reconciler.start();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(deliverySweep);
    clearInterval(taskSweep);
    clearInterval(waitSweep);
    clearInterval(cancellationSweep);
    clearInterval(childCancellationSweep);
    clearInterval(budgetSweep);
    if (admissionSweep) clearInterval(admissionSweep);
    if (memoryOutboxSweep) clearInterval(memoryOutboxSweep);
    if (memoryScanSweep) clearInterval(memoryScanSweep);
    try {
      await reconciler.stop();
      await jobHost.stop();
      await jobs.close();
      await realtime.close();
      await connector.stop();
      await mcp.close();
      await prisma.$disconnect().catch(() => undefined);
      await pool.end().catch(() => undefined);
    } finally {
      await logger.flush({ timeoutMs: 2_000 });
    }
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  // graphile-worker fires completeJob() without awaiting it. When pool.connect()
  // then hits Postgres 53300, that rejection is unhandled. Exiting here is the
  // crash loop: Docker restarts the process before Postgres has reaped the old
  // backends, so the next boot cannot connect either. Stay up on that rejection
  // only — do not resume after uncaughtException (Node leaves the process in an
  // undefined state).
  process.on("uncaughtException", (error) => {
    logger.error("uncaughtException", error);
    void stop().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", reason);
    if (isTooManyDatabaseConnections(reason)) return;
    void stop().finally(() => process.exit(1));
  });

  logger.info("worker ready", { roundtableFeatures });
}

main().catch(async (error) => {
  logger.error("worker startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  // jobHost.start retries 53300 without bound above, so a saturated Postgres at
  // that step does not reach here. Other startup failures still exit.
  process.exit(1);
});
