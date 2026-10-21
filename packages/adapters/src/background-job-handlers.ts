import type {
  AgentHomeStore,
  AgentRuntime,
  BackgroundJobHandlers,
  JobPublisher,
  MessagingSurface,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { messagingDeliverJob } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import { expireComputerControl } from "./computer-control.js";
import { scheduleComputerSleep, sleepComputerIfIdle } from "./computer-idle.js";
import { performComputerUpdate } from "./computer-update.js";
import type { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import { runMemoryExtraction } from "./memory-extraction.js";
import { memoryJobsConfigFromEnv, type MemoryJobsConfig } from "./memory-jobs-config.js";
import { drainMemoryOutbox, type MemoryOutboxDrainResult } from "./memory-outbox.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { generateRecipientSummary } from "./memory-summary.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import { dispatchOneDeliveryBatch, settleDeliveryRun } from "./result-delivery.js";
import type { EncryptedSecretStore } from "./secrets.js";
import { expireTaughtSkillTeaching } from "./teaching-session.js";

export function createBackgroundJobHandlers(deps: {
  executor: ReturnType<typeof createRunExecutor>;
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  workerId: string;
  runtime: AgentRuntime;
  secretStore: EncryptedSecretStore;
  memoryProviders: MemoryProviderResolver;
  deploymentModelKey?: string;
  /** ME-01/ME-02: server-keyed HMAC key for memory evidence digests. */
  memoryDigestKey: string;
  /** Memory job config; defaults to memoryJobsConfigFromEnv(). */
  memoryConfig?: MemoryJobsConfig;
  messaging?: MessagingSurface;
  cloudAgent?: CloudAgentConnection | null;
}): BackgroundJobHandlers {
  const memoryConfig = deps.memoryConfig ?? memoryJobsConfigFromEnv();
  const deliverMessaging = async (runId?: string) => {
    if (!deps.messaging) return;
    await deliverMessagingOutbound(
      { prisma: deps.prisma, messaging: deps.messaging, events: deps.events, jobs: deps.jobs },
      { runId },
      {
        operationId: `messaging.deliver:${runId ?? "drain"}`,
        traceId: `messaging.deliver:${runId ?? "drain"}`,
        spaceId: "",
        userId: "",
        signal: new AbortController().signal,
      },
    );
  };

  return {
    "run.continue": async (payload) => {
      await deps.executor.continueRun(payload.runId, deps.workerId);
      await settleDeliveryRun(deps, payload.runId);
      // Automatic messaging mirror: once the run's bot messages are durable,
      // copy them into the outbox. Never let mirror failures fail the run.
      if (deps.messaging) {
        await mirrorMessagingOutbound(
          { prisma: deps.prisma, messaging: deps.messaging, events: deps.events, jobs: deps.jobs },
          payload.runId,
        );
        await deps.jobs.enqueue(messagingDeliverJob()).catch(async (error) => {
          getLogger().error("messaging.deliver enqueue error", error);
          await deliverMessaging();
        });
      }
    },
    "messaging.deliver": async (payload) => {
      await deliverMessaging(payload.runId);
    },
    "delivery.dispatch": async () => {
      for (let drained = 0; drained < 20; drained += 1) {
        if (!(await dispatchOneDeliveryBatch(deps))) break;
      }
    },
    "routine.wakeup": async (payload) => {
      await deps.executor.wakeRoutine(payload.routineId, payload.scheduledFor);
    },
    "computer.update": async ({ updateId }) => {
      await performComputerUpdate(deps, updateId);
    },
    "computer.sleep": async (payload) => {
      await sleepComputerIfIdle(deps, payload.computerId);
    },
    "computer.control-expire": async (payload) => {
      if (await expireComputerControl(deps, payload.computerId, payload.leaseId)) {
        scheduleComputerSleep(deps.jobs, payload.computerId);
      }
    },
    "skill.teaching-expire": async (payload) => {
      await expireTaughtSkillTeaching(deps, payload.skillId);
    },
    "cloud_agent.poll": async (payload) => {
      await pollCloudAgent(
        {
          prisma: deps.prisma,
          jobs: deps.jobs,
          events: deps.events,
          cloudAgent: deps.cloudAgent,
        },
        payload,
      );
    },
    "history.compact": async (payload) => {
      await compactHistory(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          jobs: deps.jobs,
          memoryProviders: deps.memoryProviders,
          deploymentModelKey: deps.deploymentModelKey,
          memoryDigestKey: deps.memoryDigestKey,
          pinnedModel:
            payload.modelProvider && payload.modelId
              ? {
                  modelProvider: payload.modelProvider,
                  modelId: payload.modelId,
                  ...(payload.sourceRunId ? { sourceRunId: payload.sourceRunId } : {}),
                }
              : undefined,
          // #93: a pinned job must resolve through the executor's exact
          // pinned-identity resolver — the user-connected credential chain
          // first, then only an EXACT deployment-key / deployment-settings
          // local-model match (never a substitute). Without this the shared
          // handler — both the API in-process sweep and the standalone
          // Worker — could only fail the job closed
          // (pinned_model_resolver_missing), which is the production default
          // background path. Absent resolver still means fail-closed.
          ...(deps.executor.resolvePinnedModel
            ? { resolvePinnedModel: deps.executor.resolvePinnedModel }
            : {}),
          ...(deps.executor.resolveModel ? { resolveModel: deps.executor.resolveModel } : {}),
        },
        payload.threadId,
      );
    },
    "memory.extract": async (payload) => {
      await runMemoryExtraction(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          config: memoryConfig,
          digestKey: deps.memoryDigestKey,
        },
        payload,
      );
    },
    "memory.summary": async (payload) => {
      await generateRecipientSummary(
        { prisma: deps.prisma, runtime: deps.runtime, config: memoryConfig },
        payload,
      );
    },
    "memory.outbox": async () => {
      let result: MemoryOutboxDrainResult;
      let drained = 0;
      do {
        result = await drainMemoryOutbox({
          prisma: deps.prisma,
          jobs: deps.jobs,
          memoryProviders: deps.memoryProviders,
          config: memoryConfig,
          workerId: deps.workerId,
        });
        drained += 1;
        // Bound one job's work; the worker sweep re-enqueues the drain.
      } while (result.remaining && drained < 10);
    },
  };
}
