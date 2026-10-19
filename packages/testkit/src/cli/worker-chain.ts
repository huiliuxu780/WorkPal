import { type ChildProcess, execFileSync, execSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createDb } from "@rakazo/db";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { createApp } from "../../../../apps/api/src/app.ts";
import { startJavaRuntime } from "./java-runtime.js";
import { runProcess } from "./process.js";

loadRootEnv();

/**
 * Standalone-Worker production-chain acceptance.
 *
 * Unlike `test:e2e` (harness.ts), which embeds the job handlers in the test
 * process via WAKEUP_DRIVER=memory, this CLI runs the production topology:
 * the API process only publishes Graphile jobs, and a real `apps/worker`
 * child process claims and executes them against the real Java AgentScope
 * runtime and a local model-protocol fixture (started inside the spec).
 * The spec controls the Worker lifecycle through `/__e2e/worker/*` on the
 * API server to prove recovery without duplicate delivery.
 */

const specArg = process.argv.find((arg) => arg.startsWith("--spec="));
const grepArg = process.argv.find((arg) => arg.startsWith("--grep="));
const e2eSpec = specArg?.slice("--spec=".length) ?? "worker-chain.spec.ts";
const e2eGrep = grepArg?.slice("--grep=".length);

type WorkerHandle = {
  pid: number;
  stop: () => Promise<void>;
};

/**
 * Every OS pid whose command line runs apps/worker — the `pnpm exec tsx`
 * wrapper and the real node process whose pid becomes a Run's leaseOwner.
 */
function pgrepWorkerPids(): number[] {
  try {
    return execFileSync("pgrep", ["-f", "apps/worker/src/index.ts"], { encoding: "utf8" })
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    return [];
  }
}

/**
 * Spawns `apps/worker` exactly like production (`tsx src/index.ts`) and waits
 * for its "worker ready" log line. stop() sends SIGKILL: a crash with no
 * graceful drain, so recovery must come purely from durable database state.
 */
function startWorkerProcess(options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  logFile: string;
  label: string;
}): Promise<WorkerHandle> {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(options.logFile, { flags: "a" });
    // detached makes the child a process-group leader: `pnpm exec tsx` forks a
    // real node process, and killing only the pnpm wrapper would orphan the
    // worker and silently invalidate every "while the Worker is stopped" claim.
    const child: ChildProcess = spawn("pnpm", ["exec", "tsx", "apps/worker/src/index.ts"], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let settled = false;
    let buffer = "";
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        await new Promise<void>((done) => child.once("exit", () => done()));
      }
      log.end();
    };
    const onData = (chunk: Buffer) => {
      log.write(chunk);
      if (settled) return;
      buffer += chunk.toString("utf8");
      if (/worker ready/.test(buffer)) {
        settled = true;
        // Harness-attributed readiness anchor inside this generation's own log:
        // the spec correlates a Run's DB leaseOwner pid against these pids to
        // prove WHICH worker generation executed it (WK-01 acceptance).
        log.write(
          `${JSON.stringify({
            harness: "worker-chain",
            event: "generation-ready",
            label: options.label,
            wrapperPid: child.pid ?? -1,
            nodePids: pgrepWorkerPids(),
            at: new Date().toISOString(),
          })}\n`,
        );
        resolve({ pid: child.pid ?? -1, stop });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      log.end();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      log.end();
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Worker ${options.label} exited ${code}/${signal} before becoming ready; see ${options.logFile}`,
        ),
      );
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      void stop();
      reject(
        new Error(
          `Worker ${options.label} did not report ready within 60s; see ${options.logFile}`,
        ),
      );
    }, 60_000).unref();
  });
}

/** Recreates the disposable database so repeated local runs start pristine. */
async function resetExternalDatabase(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const database = url.pathname.slice(1);
  const maintenanceUrl = new URL(databaseUrl);
  maintenanceUrl.pathname = "/postgres";
  const { prisma, pool } = createDb(maintenanceUrl.toString(), {
    poolMax: 2,
    applicationName: "rakazo-worker-chain-reset",
  });
  try {
    if (!pool) throw new Error("Database reset requires a pg pool");
    await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await pool.query(`CREATE DATABASE "${database}"`);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    await pool?.end().catch(() => undefined);
  }
}

async function main() {
  const root = path.resolve(import.meta.dirname, "../../../..");
  const reportDir = path.resolve(root, "test-report/worker-chain");
  await mkdir(reportDir, { recursive: true });
  // Stale artifacts from a previous run must not masquerade as this run's evidence.
  await rm(path.join(reportDir, "summary.json"), { force: true });
  await rm(path.join(reportDir, "spec-timings.json"), { force: true });
  // The chain is meaningless without the production executor; never scripted.
  const agentRuntime = "agentscope";

  const externalDatabaseUrl = process.env.WORKPAL_E2E_DATABASE_URL;
  if (externalDatabaseUrl) {
    const url = new URL(externalDatabaseUrl);
    if (
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      !url.pathname.startsWith("/workpal_e2e_")
    ) {
      throw new Error("WORKPAL_E2E_DATABASE_URL must name a local workpal_e2e_ database");
    }
  }
  const container = externalDatabaseUrl
    ? undefined
    : await new PostgreSqlContainer("postgres:16-alpine").start();
  let javaRuntime: Awaited<ReturnType<typeof startJavaRuntime>> | undefined;
  let javaRuntimeDirectory: string | undefined;
  let worker: WorkerHandle | undefined;
  let workerGeneration = 0;
  const workerHistory: Array<{ generation: number; wrapperPid: number; readyAt: string }> = [];
  let server: { close: (cb: () => void) => void } | undefined;
  let handles: Awaited<ReturnType<typeof createApp>> | undefined;
  let internalHealth: { runtime?: string; jobs?: string } = {};
  try {
    const databaseUrl = externalDatabaseUrl ?? container!.getConnectionUri();
    if (externalDatabaseUrl) await resetExternalDatabase(externalDatabaseUrl);
    const apiPort = Number(process.env.WORKER_CHAIN_API_PORT ?? 3120);
    const webPort = Number(process.env.WORKER_CHAIN_WEB_PORT ?? 5190);
    const webOrigin = `http://127.0.0.1:${webPort}`;

    process.env.DATABASE_URL = databaseUrl;
    process.env.REALTIME_DATABASE_URL = databaseUrl;
    process.env.VERIFY_DATABASE = "1";
    // The whole point: jobs travel through Postgres (graphile-worker) from the
    // API publisher to the separate Worker process. Never "memory" here.
    process.env.WAKEUP_DRIVER = "graphile";
    process.env.SANDBOX_PROVIDER = "fake";
    process.env.AGENT_RUNTIME = agentRuntime;
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
    process.env.DATA_DIR = path.join(reportDir, "data-api");
    process.env.SIGNUPS_ENABLED = "true";
    process.env.SIGNUP_ALLOWLIST = "";
    process.env.CI = "1";

    javaRuntimeDirectory = await mkdtemp(path.join(reportDir, "runtime-"));
    javaRuntime = await startJavaRuntime(javaRuntimeDirectory, process.env);
    process.env.AGENTSCOPE_URL = javaRuntime.url;

    execSync("pnpm --filter @rakazo/db generate", {
      stdio: "inherit",
      env: process.env,
      cwd: root,
    });
    execSync("pnpm --filter @rakazo/db exec prisma migrate deploy", {
      stdio: "inherit",
      env: process.env,
      cwd: path.join(root, "packages/db"),
    });

    const workerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      REALTIME_DATABASE_URL: databaseUrl,
      WAKEUP_DRIVER: "graphile",
      AGENT_RUNTIME: agentRuntime,
      AGENTSCOPE_URL: javaRuntime.url,
      SANDBOX_PROVIDER: "fake",
      CLOUD_AGENT_PROVIDER: "emulator",
      COMPOSIO_API_KEY: "",
      CURSOR_API_KEY: "",
      DATA_DIR: path.join(reportDir, "data-worker"),
      AGENTLY_MAIL_ENABLED: "false",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
    };
    const spawnWorker = async () => {
      workerGeneration += 1;
      worker = await startWorkerProcess({
        env: workerEnv,
        cwd: root,
        logFile: path.join(reportDir, `worker-${workerGeneration}.log`),
        label: `generation ${workerGeneration}`,
      });
      workerHistory.push({
        generation: workerGeneration,
        wrapperPid: worker.pid,
        readyAt: new Date().toISOString(),
      });
    };

    const [
      { ComposioEmulator, EmailEmulator, PipedreamConnector, ThirdPartyConnectorEmulator },
      { createApp: createApiApp },
      { serve },
    ] = await Promise.all([
      import("@rakazo/adapters"),
      import("../../../../apps/api/src/app.ts"),
      import("@hono/node-server"),
    ]);
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
    handles = await createApiApp({
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
    server = serve({
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/__e2e/emails") {
          return Response.json(email.sent, { headers: { "cache-control": "no-store" } });
        }
        // Test-harness-only Worker lifecycle control (same layer as
        // /__e2e/emails; apps/api production code is untouched).
        if (url.pathname === "/__e2e/worker/status") {
          return Response.json({
            running: worker !== undefined,
            pid: worker?.pid ?? null,
            generation: workerGeneration,
          });
        }
        if (url.pathname === "/__e2e/worker/stop" && request.method === "POST") {
          const current = worker;
          worker = undefined;
          if (current) await current.stop();
          return Response.json({ ok: true, generation: workerGeneration });
        }
        if (url.pathname === "/__e2e/worker/start" && request.method === "POST") {
          if (worker) {
            return Response.json({ ok: false, error: "worker already running" }, { status: 409 });
          }
          await spawnWorker();
          return Response.json({
            ok: true,
            pid: worker?.pid ?? null,
            generation: workerGeneration,
          });
        }
        return handles!.app.fetch(request);
      },
      port: apiPort,
      hostname: "127.0.0.1",
    }) as unknown as { close: (cb: () => void) => void };
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`, 30_000);
    // WK-01 acceptance 1: the topology health check must name the production
    // runtime and the durable job path explicitly — never the scripted/memory
    // assertions of the compose topology smoke.
    internalHealth = (await (
      await fetch(`http://127.0.0.1:${apiPort}/internal/health`)
    ).json()) as { runtime?: string; jobs?: string };
    if (internalHealth.runtime !== "agentscope" || internalHealth.jobs !== "graphile") {
      throw new Error(
        `Topology health expected runtime=agentscope jobs=graphile, saw ${JSON.stringify(internalHealth)}`,
      );
    }
    // The Worker installs the graphile_worker schema and must be ready before
    // any spec enqueues jobs through the API publisher.
    await spawnWorker();

    try {
      await runProcess(
        "pnpm",
        [
          "--filter",
          "@rakazo/web",
          "exec",
          "playwright",
          "test",
          "--workers=1",
          e2eSpec,
          ...(e2eGrep ? ["--grep", e2eGrep] : []),
        ],
        {
          ...process.env,
          CI: "1",
          WORKER_CHAIN_E2E: "1",
          WORKER_CHAIN_REPORT_DIR: reportDir,
          VITE_DEFAULT_UI_LOCALE: "en",
        },
      );
      await writeFile(
        path.join(reportDir, "summary.json"),
        JSON.stringify(
          {
            ok: true,
            mode: "worker-chain",
            runtime: agentRuntime,
            wakeupDriver: "graphile",
            apiPort,
            webPort,
            workerGenerations: workerGeneration,
            health: internalHealth,
            processes: {
              api: {
                pid: process.pid,
                role: "serves apps/api in this harness process; publish-only (WAKEUP_DRIVER=graphile, no job handlers)",
              },
              worker: workerHistory.map((entry) => ({
                ...entry,
                role: "apps/worker child process; wrapper pid here, real node pids in its log's generation-ready line",
              })),
              javaAgentRuntime: {
                pid: javaRuntime?.pid ?? -1,
                url: javaRuntime?.url ?? null,
                role: "java -jar agent-runtime child process",
              },
              postgres: container
                ? { kind: "testcontainer", containerId: container.getId() }
                : {
                    kind: "external",
                    url: (externalDatabaseUrl ?? "").replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@"),
                  },
              web: {
                kind: "vite dev child of the Playwright webServer",
                port: webPort,
              },
              modelFixture: {
                kind: "loopback model emulator inside the Playwright spec process",
              },
            },
            timingsFile: path.join(reportDir, "spec-timings.json"),
            at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      const failedRuns = await handles.prisma.run
        .findMany({ where: { status: "failed" }, select: { id: true, trigger: true, error: true } })
        .catch(() => []);
      if (failedRuns.length) console.error("Failed agent runs:", failedRuns);
      const stuck = await handles.prisma.run
        .findMany({
          where: { status: { in: ["queued", "leased", "running"] } },
          select: { id: true, status: true, trigger: true, leaseOwner: true },
        })
        .catch(() => []);
      if (stuck.length) console.error("Non-terminal runs at failure:", stuck);
      console.error(`Worker logs: ${reportDir}/worker-*.log`);
      throw error;
    }
  } finally {
    await worker?.stop().catch(() => undefined);
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    await handles?.stop().catch(() => undefined);
    await javaRuntime?.stop();
    if (javaRuntimeDirectory) await rm(javaRuntimeDirectory, { recursive: true, force: true });
    await container?.stop().catch(() => undefined);
  }
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
