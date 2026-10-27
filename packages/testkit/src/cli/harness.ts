import { execSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { deliveryDispatchJob } from "@rakazo/adapter-kit";
import { enforceRunBudgets } from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createThreadEvents, pauseRunForInput } from "@rakazo/db";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { createApp } from "../../../../apps/api/src/app.ts";
import {
  allocateResources,
  handoffPorts,
  releaseResources,
  requirePort,
} from "../resources/leases.js";
import { assertWorkpalE2eDatabaseUrl, taskSlugFrom } from "../resources/plan.js";
import { FULL_E2E_GATE_OFF_SPEC, FULL_E2E_GATED_SPEC, specSelects } from "./e2e-spec-selection.js";
import { startJavaRuntime } from "./java-runtime.js";
import { runProcess } from "./process.js";

loadRootEnv();

const integration = process.argv.includes("--integration");
const e2e = process.argv.includes("--e2e");
const sandboxArg = process.argv.find((arg) => arg.startsWith("--sandbox="));
const specArg = process.argv.find((arg) => arg.startsWith("--spec="));
const grepArg = process.argv.find((arg) => arg.startsWith("--grep="));
const runtimeArg = process.argv.find((arg) => arg.startsWith("--runtime="));
const sandboxProvider = sandboxArg?.slice("--sandbox=".length) ?? "fake";
const e2eSpec = specArg?.slice("--spec=".length);
const e2eGrep = grepArg?.slice("--grep=".length);
const agentRuntime = runtimeArg?.slice("--runtime=".length) ?? "scripted";

if (Number(integration) + Number(e2e) !== 1) {
  throw new Error("Pass exactly one of --integration or --e2e");
}
if (!["fake", "e2b", "daytona", "box"].includes(sandboxProvider)) {
  throw new Error('Sandbox must be "fake", "e2b", "daytona", or "box"');
}
if (integration && sandboxProvider !== "fake") {
  throw new Error("Integration tests only support the fake sandbox");
}
if (agentRuntime !== "agentscope" && agentRuntime !== "scripted") {
  throw new Error('Runtime must be "agentscope" or "scripted"');
}

if (sandboxProvider === "e2b" && !process.env.E2B_API_KEY) {
  throw new Error("E2B_API_KEY is required when --sandbox=e2b");
}
if (sandboxProvider === "daytona" && !process.env.DAYTONA_API_KEY) {
  throw new Error("DAYTONA_API_KEY is required when --sandbox=daytona");
}
if (sandboxProvider === "box" && !process.env.BOX_API_KEY) {
  throw new Error("BOX_API_KEY is required when --sandbox=box");
}

async function main() {
  if (e2e && !e2eSpec) {
    // The unified-card and private-pair specs require gates the rest of the
    // suite must run without. A full run is therefore two gate-compatible
    // batches, each with its own API/Web/DB lifecycle.
    const baseArgs = process.argv
      .slice(2)
      .filter((arg) => arg !== "--e2e" && !arg.startsWith("--spec="));
    console.log("Full E2E: gate-off batch");
    await runProcess("pnpm", ["test:e2e", ...baseArgs, `--spec=${FULL_E2E_GATE_OFF_SPEC}`], {
      ...process.env,
      WORKPAL_E2E_FULL_BATCH: "gate-off",
    });
    console.log("Full E2E: gate-on batch");
    await runProcess("pnpm", ["test:e2e", ...baseArgs, `--spec=${FULL_E2E_GATED_SPEC}`], process.env);
    return;
  }
  const mode = integration ? "integration" : "e2e";
  const reportDir = path.resolve("test-report", mode);
  await mkdir(reportDir, { recursive: true });
  // Local Web acceptance can use an explicitly named disposable PostgreSQL database
  // when a container runtime is unavailable. Integration suites still need clones.
  const externalDatabaseUrl = process.env.WORKPAL_E2E_DATABASE_URL;
  if (externalDatabaseUrl) {
    assertWorkpalE2eDatabaseUrl(externalDatabaseUrl, integration ? "integration" : "e2e");
  }
  // Lease the ports before starting Postgres so a conflict fails closed.
  const resources = await allocateResources({
    purpose: "e2e",
    cwd: process.cwd(),
    taskSlug: taskSlugFrom(process.argv, process.env),
    env: process.env,
  });
  const apiPort = requirePort(resources, "api");
  const webPort = requirePort(resources, "web");
  let container: Awaited<ReturnType<PostgreSqlContainer["start"]>> | undefined;
  let javaRuntime: Awaited<ReturnType<typeof startJavaRuntime>> | undefined;
  let javaRuntimeDirectory: string | undefined;
  try {
    container = externalDatabaseUrl
      ? undefined
      : await new PostgreSqlContainer("postgres:16-alpine").start();
    const databaseUrl = externalDatabaseUrl ?? container!.getConnectionUri();
    const webOrigin = `http://127.0.0.1:${webPort}`;

    process.env.DATABASE_URL = databaseUrl;
    process.env.REALTIME_DATABASE_URL = databaseUrl;
    process.env.VERIFY_DATABASE = "1";
    process.env.WAKEUP_DRIVER = "memory";
    process.env.SANDBOX_PROVIDER = sandboxProvider;
    process.env.AGENT_RUNTIME = agentRuntime;
    // Playwright/E2E force the offline cloud-agent emulator; clear Cursor keys so cards never hit a live VM.
    process.env.CLOUD_AGENT_PROVIDER = "emulator";
    delete process.env.CURSOR_API_KEY;
    process.env.COMPOSIO_API_KEY = "";
    process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-32chars!";
    process.env.ENCRYPTION_KEY = "test-encryption-key-test-encryption-key";
    process.env.SANDBOX_SUPERVISOR_TOKEN = "test-supervisor-token-test-32chars";
    process.env.SCREEN_PROXY_SECRET = "test-screen-proxy-secret-test-32chars";
    process.env.BETTER_AUTH_URL = webOrigin;
    process.env.WEB_ORIGIN = webOrigin;
    process.env.API_PORT = String(apiPort);
    process.env.API_URL = `http://127.0.0.1:${apiPort}`;
    process.env.API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`;
    process.env.WEB_PORT = String(webPort);
    process.env.PLAYWRIGHT_BASE_URL = webOrigin;
    process.env.DATA_DIR = path.join(reportDir, "data");
    process.env.SIGNUPS_ENABLED = "true";
    process.env.SIGNUP_ALLOWLIST = "";
    // The in-process E2E API exercises the gated cross-session handoff when
    // that spec runs; the production default stays closed. Integration suites
    // opt in themselves.
    if (
      !integration &&
      (process.env.WORKPAL_E2E_FULL_BATCH === "gate-off" ||
        specSelects(e2eSpec, "message-group.spec.ts"))
    ) {
      process.env.ROUNDTABLE_MESSAGE_GROUP_ENABLED = "true";
    }
    // RT-09 private pair receipts only carry a pair locator when the pair
    // delivery is on; these specs assert the bound private history instead of
    // the legacy destination-chat fallback.
    if (
      !integration &&
      (specSelects(e2eSpec, "peer-messages.spec.ts") ||
        specSelects(e2eSpec, "card-ui-interactions.spec.ts"))
    ) {
      process.env.ROUNDTABLE_PRIVATE_PAIR_ENABLED = "true";
    }
    if (
      !integration &&
      (specSelects(e2eSpec, "card-ui-interactions.spec.ts") ||
        specSelects(e2eSpec, "card-display-content.spec.ts"))
    ) {
      process.env.CARDS_UNIFIED_V2_ENABLED = "true";
    }
    process.env.CI = "1";
    if (integration || agentRuntime === "agentscope") {
      javaRuntimeDirectory = await mkdtemp(path.join(reportDir, "runtime-"));
      javaRuntime = await startJavaRuntime(javaRuntimeDirectory, process.env);
      process.env.AGENTSCOPE_URL = javaRuntime.url;
    }

    execSync("pnpm --filter @rakazo/db generate", { stdio: "inherit", env: process.env });
    execSync("pnpm --filter @rakazo/db exec prisma migrate deploy", {
      stdio: "inherit",
      env: process.env,
      cwd: path.resolve("packages/db"),
    });

    if (integration) {
      const suites = [
        "packages/testkit/src/agentscope-offline.postgres.test.ts",
        "packages/testkit/src/scenario-contract.postgres.test.ts",
        "packages/testkit/src/history-compaction-agentscope.test.ts",
        "packages/testkit/src/computer-approval.postgres.test.ts",
        "packages/testkit/src/eval-history.postgres.test.ts",
        "packages/testkit/src/eval-customer-support.postgres.test.ts",
        "packages/testkit/src/journeys.test.ts",
        "packages/testkit/src/authorization.test.ts",
        "packages/testkit/src/attachments.test.ts",
        "packages/testkit/src/voice.test.ts",
        "packages/testkit/src/search.test.ts",
        "packages/testkit/src/executor-lifecycle.test.ts",
        "packages/testkit/src/connections.test.ts",
        "packages/testkit/src/bot-secrets.test.ts",
        "packages/db/src/space-membership.postgres.test.ts",
        "packages/db/src/messaging.postgres.test.ts",
        "packages/memory/src/commit.postgres.test.ts",
        "packages/adapters/src/wakeup.postgres.test.ts",
        "packages/adapters/src/realtime.postgres.test.ts",
        "packages/adapters/src/job-reconciler.postgres.test.ts",
        "packages/adapters/src/cloud-agent.postgres.test.ts",
      ];
      // Each app reconciles all durable work in its database, including intentionally
      // unfinished fixture runs. Clone the pristine migrated schema so one suite
      // cannot execute another suite's backlog or wait for it during shutdown.
      const template = container!.getDatabase().replaceAll('"', '""');
      const databaseCommand = async (statement: string) => {
        const result = await container!.exec([
          "psql",
          "-U",
          container!.getUsername(),
          "-d",
          "postgres",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          statement,
        ]);
        if (result.exitCode !== 0)
          throw new Error("Isolated integration database operation failed");
      };
      const selectedSuites = e2eSpec ? suites.filter((suite) => suite.includes(e2eSpec)) : suites;
      if (selectedSuites.length === 0) throw new Error(`No integration suite matches ${e2eSpec}`);
      for (const [index, suite] of selectedSuites.entries()) {
        const database = `integration_${index}`;
        await databaseCommand(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
        const suiteUrl = new URL(databaseUrl);
        suiteUrl.pathname = `/${database}`;
        try {
          await runProcess("pnpm", ["exec", "vitest", "run", suite], {
            ...process.env,
            DATABASE_URL: suiteUrl.toString(),
            REALTIME_DATABASE_URL: suiteUrl.toString(),
            OPENROUTER_API_KEY: "",
            MODEL_API_KEY: "",
          });
        } finally {
          await databaseCommand(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        }
      }
      await writeSummary(reportDir, {
        ok: true,
        mode,
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
      });
      return;
    }

    const [
      { ComposioEmulator, EmailEmulator, PipedreamConnector, ThirdPartyConnectorEmulator },
      { createApp },
    ] = await Promise.all([import("@rakazo/adapters"), import("../../../../apps/api/src/app.ts")]);
    const thirdParties = new ThirdPartyConnectorEmulator();
    const pipedream = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: process.env.ENCRYPTION_KEY,
      },
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const email = new EmailEmulator();
    const handles = await createApp({
      databaseUrl,
      prisma: undefined,
      composio: new ComposioEmulator(),
      pipedream,
      email,
      remoteConnectors: {
        fetch: thirdParties.fetch,
        resolveHostname: thirdParties.resolveHostname,
      },
      integrationsCatalogUrl: "https://catalog.example.test/",
    });
    // The production Worker schedules this sweep. The E2E harness hosts the same
    // job handlers in-process, so it must schedule the sweep to test proactive
    // delivery after the outbox merge window without a new user request.
    const deliverySweep = setInterval(() => {
      void handles.jobs.enqueue(deliveryDispatchJob()).catch((error) => {
        console.error("E2E delivery dispatch scheduling failed", error);
      });
    }, 10_000);
    deliverySweep.unref?.();
    // Host the production Worker budget check for real Java/Web E2E runs.
    const budgetEvents = createThreadEvents(handles.prisma);
    const budgetSweep = agentRuntime === "agentscope" ? setInterval(() => {
      void enforceRunBudgets({
        prisma: handles.prisma, events: budgetEvents, runtime: handles.runtime,
      }).catch((error) => console.error("E2E budget enforcement failed", error));
    }, 10_000) : null;
    budgetSweep?.unref?.();
    let activeRequests = 0;
    const requestWaiters = new Set<() => void>();
    const server = resources.servers.api;
    if (!server) throw new Error("port:api unassigned");
    server.on(
      "request",
      getRequestListener(async (request) => {
        if (new URL(request.url).pathname === "/__e2e/emails") {
          return Response.json(email.sent, { headers: { "cache-control": "no-store" } });
        }
        if (
          new URL(request.url).pathname === "/__e2e/display-blocks" &&
          request.method === "POST"
        ) {
          // CARD-01C visual fixture: persist real message blocks and artifacts
          // so the server projection produces every DisplayBlock kind.
          const input = (await request.json()) as {
            botId?: string;
            threadId?: string;
            imageId?: string;
            fileId?: string;
            htmlId?: string;
            pageId?: string;
            probeText?: string;
          };
          if (
            !input.botId ||
            !input.threadId ||
            !input.imageId ||
            !input.fileId ||
            !input.htmlId ||
            !input.pageId
          ) {
            return Response.json({ error: "botId, threadId and artifacts are required" }, { status: 400 });
          }
          const bot = await handles.prisma.bot.findUnique({ where: { id: input.botId } });
          const thread = await handles.prisma.thread.findFirst({
            where: { id: input.threadId, botId: input.botId },
          });
          if (!bot || !thread || thread.spaceId !== bot.spaceId || thread.userId !== bot.userId) {
            return Response.json({ error: "bot thread not found" }, { status: 404 });
          }
          const head = await handles.prisma.message.aggregate({
            where: { threadId: thread.id },
            _max: { seq: true },
          });
          let seq = (head._max.seq ?? 0) + 1;
          const longText = Array.from(
            { length: 14 },
            (_, index) => `Line ${index + 1}: the weekly report records a measurable change.`,
          ).join("\n");
          const displayMessage = await handles.prisma.message.create({
            data: {
              threadId: thread.id,
              seq: seq++,
              role: "bot",
              botId: bot.id,
              blocks: [
                { kind: "text", text: `Weekly report\n\n${longText}` },
                {
                  kind: "chart",
                  name: "Weekly trend",
                  spec: {
                    title: "Weekly trend",
                    marks: [
                      {
                        type: "dot",
                        options: { x: "day", y: "count", fill: "currentColor", r: 8 },
                      },
                    ],
                  },
                  data: [
                    { day: "Mon", count: 3 },
                    { day: "Tue", count: 5 },
                  ],
                },
                {
                  kind: "card",
                  lines: [
                    { k: "Owner", v: "Ada" },
                    { k: "Status", v: "Ready" },
                  ],
                },
                {
                  kind: "image",
                  artifactId: input.imageId,
                  mimeType: "image/png",
                  name: "chart.png",
                },
                {
                  kind: "file",
                  artifactId: input.fileId,
                  mimeType: "text/plain",
                  name: "notes.txt",
                  size: 5,
                },
                {
                  kind: "file",
                  artifactId: input.htmlId,
                  mimeType: "text/html",
                  name: "report.html",
                  size: 64,
                },
                {
                  kind: "file",
                  artifactId: input.pageId,
                  mimeType: "text/markdown",
                  name: "brief.md",
                  size: 32,
                },
                {
                  kind: "subagent",
                  agentId: "display-agent",
                  name: "Researcher",
                  task: "Collect the weekly metrics",
                  status: "completed",
                },
              ] as never,
            },
          });
          const callId = "display-call";
          if (input.probeText) {
            // A separate bot message so the viewport-reflow regression gets a
            // markdown card whose fold decision flips on narrow viewports.
            await handles.prisma.message.create({
              data: {
                threadId: thread.id,
                seq: seq++,
                role: "bot",
                botId: bot.id,
                blocks: [{ kind: "text", text: input.probeText }] as never,
              },
            });
          }
          await handles.prisma.message.create({
            data: {
              threadId: thread.id,
              seq: seq++,
              role: "user",
              blocks: [{ kind: "text", text: "The weather is sunny." }],
              clientNonce: `call:${callId}:user`,
            },
          });
          await handles.prisma.message.create({
            data: {
              threadId: thread.id,
              seq: seq++,
              role: "bot",
              botId: bot.id,
              blocks: [{ kind: "text", text: "Sunny and 22 degrees." }],
              clientNonce: `call:${callId}:reply`,
            },
          });
          await handles.prisma.message.create({
            data: {
              threadId: thread.id,
              seq: seq++,
              role: "bot",
              botId: bot.id,
              blocks: [{ kind: "voice_call", title: "Weather check", farewell: "Bye" }],
              clientNonce: `call:${callId}:marker`,
            },
          });
          return Response.json(
            { messageId: displayMessage.id },
            { headers: { "cache-control": "no-store" } },
          );
        }
        if (
          new URL(request.url).pathname === "/__e2e/outbound-draft" &&
          request.method === "POST"
        ) {
          // A10 screenshot/visual fixture: seed a real send_email approval
          // through the production pause path, without a model tool call.
          const input = (await request.json()) as { botId?: string; threadId?: string };
          if (!input.botId || !input.threadId) {
            return Response.json({ error: "botId and threadId are required" }, { status: 400 });
          }
          const bot = await handles.prisma.bot.findUnique({ where: { id: input.botId } });
          const thread = await handles.prisma.thread.findFirst({
            where: { id: input.threadId, botId: input.botId },
          });
          if (!bot || !thread || thread.spaceId !== bot.spaceId || thread.userId !== bot.userId) {
            return Response.json({ error: "bot thread not found" }, { status: 404 });
          }
          const task = await handles.prisma.task.create({
            data: {
              spaceId: bot.spaceId,
              userId: bot.userId,
              botId: bot.id,
              threadId: thread.id,
              prompt: "Seed an outbound draft for visual acceptance",
              status: "running",
            },
          });
          const run = await handles.prisma.run.create({
            data: {
              spaceId: bot.spaceId,
              userId: bot.userId,
              botId: bot.id,
              threadId: thread.id,
              taskId: task.id,
              status: "running",
              trigger: "user",
              leaseOwner: "e2e-seed",
              leaseFence: 1,
              leaseExpiresAt: new Date(Date.now() + 60_000),
            },
          });
          const attempt = await handles.prisma.attempt.create({
            data: { runId: run.id, fence: 1, status: "running" },
          });
          const effect = await handles.prisma.externalEffect.create({
            data: {
              spaceId: bot.spaceId,
              runId: run.id,
              kind: "send_email",
              idempotencyKey: `e2e-outbound-${run.id}`,
              status: "intended",
              request: {
                to: ["ada@example.test"],
                subject: "Weekly digest",
                text: "Original body",
              },
            },
          });
          const paused = await pauseRunForInput(handles.prisma, {
            spaceId: bot.spaceId,
            threadId: thread.id,
            botId: bot.id,
            runId: run.id,
            attemptId: attempt.id,
            leaseOwner: "e2e-seed",
            leaseFence: 1,
            blocks: [
              {
                kind: "ask",
                text: "Review before send_email",
                detail: "to: ada@example.test\nsubject: Weekly digest\nbody: Original body",
                status: "pending",
                approvalEffectId: effect.id,
                actions: [
                  { id: "allow", label: "Allow once" },
                  { id: "always", label: "Always allow" },
                  { id: "deny", label: "Deny" },
                ],
              },
            ],
          });
          if (!paused) {
            return Response.json({ error: "seed pause failed" }, { status: 409 });
          }
          return Response.json(
            { runId: run.id, threadId: thread.id },
            { headers: { "cache-control": "no-store" } },
          );
        }
        activeRequests += 1;
        try {
          return await handles.app.fetch(request);
        } finally {
          activeRequests -= 1;
          if (activeRequests === 0) {
            for (const resolve of requestWaiters) resolve();
            requestWaiters.clear();
          }
        }
      }, { hostname: "127.0.0.1" }),
    );
    server.ref();
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`, 15_000);

    try {
      try {
        // Vite binds WEB_PORT itself. The lease still reserves the number.
        await handoffPorts(resources.key, ["web"]);
        await runProcess(
          "pnpm",
          [
            "--filter",
            "@rakazo/web",
            "exec",
            "playwright",
            "test",
            // Both runtimes host ONE in-process API with shared sweeps over a
            // single database; parallel spec-file workers race that single
            // backend — multi-spec batches timed out wholesale under default
            // workers while every spec passes solo (#85). Keep spec files
            // serial; single-spec runs are unaffected (fullyParallel is
            // already false, so one file never used more than one worker).
            "--workers=1",
            ...(e2eSpec ? [e2eSpec] : []),
            ...(e2eGrep ? ["--grep", e2eGrep] : []),
          ],
          {
            ...process.env,
            CI: "1",
            // Pin English so e2e selectors match source messages regardless of runner locale.
            VITE_DEFAULT_UI_LOCALE: "en",
          },
        );
      } catch (error) {
        const failedRuns = await handles.prisma.run.findMany({
          where: { status: "failed" },
          select: { id: true, error: true },
        });
        if (failedRuns.length) console.error("Failed agent runs:", failedRuns);
        throw error;
      }
      await writeSummary(reportDir, {
        ok: true,
        mode,
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
        apiPort,
        webPort,
      });
    } finally {
      clearInterval(deliverySweep);
      if (budgetSweep) clearInterval(budgetSweep);
      const cleanupErrors: unknown[] = [];
      const computers = await managedComputers(handles).catch((error) => {
        cleanupErrors.push(error);
        return [];
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (activeRequests > 0) {
        await new Promise<void>((resolve) => requestWaiters.add(resolve));
      }
      await handles.stop().catch(() => undefined);
      for (let index = 0; index < computers.length; index += 4) {
        const results = await Promise.allSettled(
          computers.slice(index, index + 4).map((computer) =>
            handles.sandbox.destroy(
              {
                id: computer.providerRef!,
                botId: computer.homeKey,
                kind: computer.kind as "e2b" | "daytona" | "box",
                providerRef: computer.providerRef!,
              },
              {
                operationId: "e2e-cleanup",
                traceId: "e2e-cleanup",
                spaceId: computer.spaceId,
                userId: computer.userId,
                signal: new AbortController().signal,
              },
            ),
          ),
        );
        for (const result of results) {
          if (result.status === "rejected") cleanupErrors.push(result.reason);
        }
      }
      if (cleanupErrors.length) {
        console.error(
          new AggregateError(cleanupErrors, "Could not destroy every managed test sandbox"),
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await javaRuntime?.stop();
    if (javaRuntimeDirectory) await rm(javaRuntimeDirectory, { recursive: true, force: true });
    await container?.stop().catch(() => undefined);
    await releaseResources(resources).catch(() => undefined);
  }
}

type AppHandles = Awaited<ReturnType<typeof createApp>>;

async function managedComputers(handles: AppHandles) {
  if (!["e2b", "daytona", "box"].includes(sandboxProvider)) return [];
  return handles.prisma.computer.findMany({
    where: { providerRef: { not: null } },
    select: { homeKey: true, kind: true, providerRef: true, userId: true, spaceId: true },
  });
}

async function writeSummary(reportDir: string, summary: Record<string, unknown>) {
  await writeFile(
    path.join(reportDir, "summary.json"),
    JSON.stringify({ ...summary, at: new Date().toISOString() }, null, 2),
  );
}

async function waitForHealth(url: string, ms: number) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API health check failed for ${url}: ${last}`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
