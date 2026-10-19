import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { createDb } from "../../../packages/db/src/index.js";
import { startModelEmulator } from "../../../packages/testkit/src/model-emulator.js";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

type Emulator = Awaited<ReturnType<typeof startModelEmulator>>;
type Db = ReturnType<typeof createDb>;

/**
 * Standalone-Worker production-chain acceptance (pnpm test:worker-chain).
 *
 * WK-01 topology: Web, API, Graphile Worker, Java AgentScope runtime,
 * PostgreSQL and the loopback model fixture are separate processes. The API
 * only publishes Graphile jobs; every Run below is claimed and executed by a
 * real `apps/worker` child process. Proactive delivery travels the production
 * Routine-over-budget → `run_result` outbox → `delivery.dispatch` →
 * trigger=delivery Run chain: no new user message, no direct dispatcher call,
 * no fabricated completion.
 *
 * Every assertion reads durable database state (Run/Task/Attempt/
 * DeliveryRecord/Message/Event), OS process identity (a Run's leaseOwner pid
 * ↔ pgrep of apps/worker ↔ the generation-ready line in that Worker
 * generation's own log) and the model fixture's request log — never a
 * simulated in-test-process event, never page text alone.
 *
 * Documented test seams (metering facts only, same class as
 * budget-acceptance.spec.ts): rewinding the running Attempt clock past the
 * 3600s unattended duration budget, and a bounded native-session DELETE
 * mirroring the production abort-retry sweep so the next Run never races the
 * Java thread slot. Budget enforcement, lease-loss retry, outbox
 * claim/dispatch/settle and message commits are all produced by production
 * code paths running in the Worker process. The mid-run crash test uses NO
 * clock seam at all: it waits out the real hard-coded 5-minute run-lease and
 * computer-execution-lease TTLs, and recovery runs end to end through the
 * restarted Worker's reconciler (whose graphile replace-mode enqueue natively
 * supersedes the SIGKILLed job's stale lock), the lease-loss abort/retry
 * policy and the computer-lease reclaim.
 */

test.skip(
  process.env.WORKER_CHAIN_E2E !== "1",
  "Runs under pnpm test:worker-chain with a standalone Worker process",
);

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3120";
const reportDir = process.env.WORKER_CHAIN_REPORT_DIR ?? "";
const CLAIM_MARKER = "WORKER_CHAIN_CLAIM_FIXTURE hold this stream open.";
const DIRECT_REPLY = "WORKER_CHAIN_DIRECT_REPLY completed by the standalone worker.";
const ROUTINE_MARKER = "WORKER_CHAIN_ROUTINE_FIXTURE";
const ROUTINE_PROMPT = `${ROUTINE_MARKER}: report the nightly fixture status.`;
const RECOVERY_MARKER = "WORKER_CHAIN_RECOVERY_FIXTURE hold this stream open for the crash test.";
const RECOVERY_REPLY = "WORKER_CHAIN_RECOVERY_REPLY completed by the retried attempt.";
const DELIVERY_INSTRUCTION = "Write one concise user-facing update";
const DELIVERY_TEXT =
  "WORKER_CHAIN_DELIVERY: the scheduled fixture run failed on its duration budget.";

/** Measured recovery/latency facts, merged into <reportDir>/spec-timings.json. */
const timings: Record<string, number> = {};

async function recordTimings() {
  console.log("worker-chain timings (ms):", JSON.stringify(timings));
  if (!reportDir) return;
  await mkdir(reportDir, { recursive: true });
  const file = path.join(reportDir, "spec-timings.json");
  const previous = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as Record<
    string,
    number
  >;
  await writeFile(file, JSON.stringify({ ...previous, ...timings }, null, 2));
}

async function workerStatus() {
  const response = await fetch(`${apiUrl}/__e2e/worker/status`);
  if (!response.ok) throw new Error(`worker status ${response.status}`);
  return (await response.json()) as { running: boolean; pid: number | null; generation: number };
}

async function stopWorker() {
  const response = await fetch(`${apiUrl}/__e2e/worker/stop`, { method: "POST" });
  expect(response.ok, "worker stop").toBe(true);
  await expect.poll(async () => (await workerStatus()).running, { timeout: 15_000 }).toBe(false);
}

async function startWorker() {
  const status = await workerStatus();
  if (!status.running) {
    const response = await fetch(`${apiUrl}/__e2e/worker/start`, { method: "POST" });
    expect(response.ok, "worker start").toBe(true);
  }
  await expect.poll(async () => (await workerStatus()).running, { timeout: 75_000 }).toBe(true);
  return workerStatus();
}

/**
 * OS-level pids of the spawned Worker tree (`pnpm exec tsx apps/worker/...`
 * forks, so the control endpoint only knows the wrapper pid). A Run's
 * leaseOwner is `${process.pid}-${uuid}` of the real Node process; matching it
 * against this set proves an independent worker process executed the Run.
 */
function workerNodePids(): Set<string> {
  try {
    const out = execFileSync("pgrep", ["-f", "apps/worker/src/index.ts"], { encoding: "utf8" });
    return new Set(
      out
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * The pids the harness recorded in one Worker generation's own log when that
 * generation became ready — the Worker-log side of the leaseOwner correlation.
 */
async function workerLogReadyPids(generation: number): Promise<Set<string>> {
  if (!reportDir) return new Set();
  const content = await readFile(path.join(reportDir, `worker-${generation}.log`), "utf8").catch(
    () => "",
  );
  const pids = new Set<string>();
  for (const line of content.split("\n")) {
    if (!line.includes('"harness":"worker-chain"')) continue;
    try {
      const parsed = JSON.parse(line) as { event?: string; nodePids?: number[] };
      if (parsed.event === "generation-ready") {
        for (const pid of parsed.nodePids ?? []) pids.add(String(pid));
      }
    } catch {
      // The Worker's own pretty-format lines are not JSON; ignore them.
    }
  }
  return pids;
}

/** WK-01 acceptance 1: the API names the production runtime and durable jobs. */
async function assertTopologyHealth() {
  const response = await fetch(`${apiUrl}/internal/health`);
  expect(response.ok, "GET /internal/health").toBe(true);
  const details = (await response.json()) as { runtime?: string; jobs?: string };
  expect(details.runtime, "API must run the production agentscope runtime").toBe("agentscope");
  expect(details.jobs, "API must publish jobs through graphile").toBe("graphile");
}

/**
 * The production Worker sweep retries run aborts whose DELETE did not land
 * (retryPendingRunAborts); a best-effort abort or a killed Worker can leave
 * the Java thread session slot held. This bounded loop is the same seam
 * budget-acceptance.spec.ts uses so the next Run on the Thread never races the
 * slot; the native DELETE is idempotent (200 with a cancelled flag).
 */
async function releaseNativeRun(runId: string) {
  const url = process.env.AGENTSCOPE_URL ?? "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(`${url}/v1/runs/${runId}`, { method: "DELETE" }).catch(() => null);
    if (response && (response.status === 200 || response.status === 404)) return response.status;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return -1;
}

async function pollRunStatus(db: Db, runId: string, status: string, timeout = 60_000) {
  await expect
    .poll(
      async () =>
        (await db.prisma.run.findUnique({ where: { id: runId }, select: { status: true } }))
          ?.status ?? "missing",
      { timeout },
    )
    .toBe(status);
}

/** Polls until the threads.send RPC has committed the user Run. */
async function waitUserRun(db: Db, threadId: string) {
  await expect
    .poll(async () => db.prisma.run.count({ where: { threadId, trigger: "user" } }), {
      timeout: 30_000,
    })
    .toBe(1);
  return db.prisma.run.findFirstOrThrow({
    where: { threadId, trigger: "user" },
    orderBy: { createdAt: "desc" },
  });
}

async function setupChatBot(page: Page, apiKey: string, introText: string, name: string) {
  const intro = await startModelEmulator({
    apiKey,
    steps: [{ expect() {}, response: { type: "text", text: introText } }],
  });
  const email = `${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}@rakazo.test`;
  await signup(page, email, "password12", name);
  await page.waitForURL(/\/(onboarding|app)/);
  await rpc(page, "models/connect", {
    provider: intro.model.provider,
    modelId: intro.model.id,
    baseUrl: intro.baseUrl,
    apiKey,
  });
  await page.reload();
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await expect
    .poll(
      async () => {
        const thread = await rpc<{ run?: { status?: string } | null }>(page, "threads/get", {
          botId,
        });
        return thread.run?.status ?? "completed";
      },
      { timeout: 60_000 },
    )
    .toBe("completed");
  return { intro, botId };
}

async function switchToTaskModel(page: Page, botId: string, apiKey: string, task: Emulator) {
  await rpc(page, "models/connect", {
    provider: task.model.provider,
    modelId: task.model.id,
    baseUrl: task.baseUrl,
    apiKey,
  });
  await rpc(page, "bots/update", {
    botId,
    modelProvider: task.model.provider,
    modelId: task.model.id,
  });
}

async function sendMessage(page: Page, text: string) {
  await page.getByPlaceholder(/Message/).fill(text);
  await page.keyboard.press("Enter");
}

/** Production automation entry: a real Routine fired through its product test-run RPC. */
async function startRoutineRun(page: Page, botId: string, name: string) {
  const routine = await rpc<{ id: string }>(page, "routines/create", {
    botId,
    name,
    prompt: ROUTINE_PROMPT,
    crons: ["0 0 1 1 *"],
    timezone: "UTC",
    active: false,
  });
  const { runId } = await rpc<{ runId: string }>(page, "routines/testRun", {
    routineId: routine.id,
    clientNonce: `worker-chain-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
  return { routineId: routine.id, runId };
}

/**
 * Metering fact: rewind only the measured Attempt clock past the 3600s
 * unattended duration budget, then wait for the WORKER's own budget sweep to
 * enforce it — the spec never calls enforceRunBudgets itself.
 */
async function rewindAttemptClockAndAwaitBudgetFailure(db: Db, runId: string) {
  const attempt = await db.prisma.attempt.findFirstOrThrow({
    where: { runId, status: "running" },
    select: { id: true },
  });
  await db.prisma.attempt.update({
    where: { id: attempt.id },
    data: { startedAt: new Date(Date.now() - 3_601_000) },
  });
  const rewoundAt = Date.now();
  await pollRunStatus(db, runId, "failed", 60_000);
  const failed = await db.prisma.run.findUniqueOrThrow({
    where: { id: runId },
    select: { error: true },
  });
  expect(failed.error).toBe("budget_exceeded:duration_sec");
  timings.budgetEnforcementMs = Date.now() - rewoundAt;
}

test("a user Run stays queued while the Worker is down and is claimed and executed by the Worker process", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const apiKey = "worker-chain-claim-key";
  const db = createDb(process.env.DATABASE_URL!);
  let intro: Emulator | undefined;
  let task: Emulator | undefined;
  let release: (() => void) | undefined;
  try {
    await expect.poll(async () => (await workerStatus()).running).toBe(true);
    await assertTopologyHealth();
    const setup = await setupChatBot(
      page,
      apiKey,
      "Ready for the worker chain test.",
      "Worker Chain Claim",
    );
    intro = setup.intro;
    const { botId } = setup;
    task = await startModelEmulator({
      apiKey,
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("WORKER_CHAIN_CLAIM_FIXTURE");
          },
          response: {
            type: "hold",
            text: DIRECT_REPLY,
            onOpen: (end) => {
              release = end;
            },
          },
        },
      ],
    });
    await switchToTaskModel(page, botId, apiKey, task);

    // With the Worker stopped, the API/Web processes must not execute anything:
    // this is the regression assertion against in-test-process job handlers.
    await stopWorker();
    await sendMessage(page, CLAIM_MARKER);
    const thread = await db.prisma.thread.findUniqueOrThrow({ where: { botId } });
    const created = await waitUserRun(db, thread.id);
    for (let index = 0; index < 16; index += 1) {
      const run = await db.prisma.run.findUniqueOrThrow({
        where: { id: created.id },
        select: { status: true, leaseOwner: true },
      });
      expect(run.status, `Run left queued without a Worker (leaseOwner=${run.leaseOwner})`).toBe(
        "queued",
      );
      expect(
        await db.prisma.attempt.count({ where: { runId: created.id } }),
        "Attempt created without a Worker",
      ).toBe(0);
      expect(task.requests.length, "model fixture called without a Worker").toBe(0);
      await page.waitForTimeout(500);
    }

    const claimStart = Date.now();
    const worker = await startWorker();
    expect(worker.pid).toBeGreaterThan(0);
    await pollRunStatus(db, created.id, "running", 60_000);
    timings.claimToRunningMs = Date.now() - claimStart;

    // Durable in-flight evidence that an independent worker OS process holds
    // the Run: the Worker id is `${nodePid}-${uuid}` of a process spawned as
    // apps/worker; the embedded API executor would use workerId "api".
    const running = await db.prisma.run.findUniqueOrThrow({ where: { id: created.id } });
    expect(running.leaseOwner).not.toBeNull();
    expect(running.leaseOwner).not.toBe("api");
    const leasePid = running.leaseOwner!.split("-")[0]!;
    expect(leasePid).not.toBe(String(process.pid));
    expect(workerNodePids().has(leasePid)).toBe(true);
    const readyPids = await workerLogReadyPids(worker.generation);
    expect(
      readyPids.has(leasePid),
      "this Worker generation's own log records the lease-holder pid",
    ).toBe(true);
    expect(running.leaseFence).toBeGreaterThanOrEqual(1);
    expect(running.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    const attempt = await db.prisma.attempt.findFirst({
      where: { runId: created.id, status: "running" },
      select: { id: true, fence: true },
    });
    expect(attempt).not.toBeNull();

    // Let the held model stream finish; the same Run completes and its reply
    // becomes visible in the Web transcript.
    await expect.poll(async () => release !== undefined, { timeout: 30_000 }).toBe(true);
    release!();
    await expect(page.getByTestId("transcript").getByText(DIRECT_REPLY)).toBeVisible({
      timeout: 60_000,
    });
    const final = await db.prisma.run.findUniqueOrThrow({ where: { id: created.id } });
    expect(final.status).toBe("completed");
    expect(final.error).toBeNull();
    const taskRow = await db.prisma.task.findUniqueOrThrow({ where: { id: final.taskId } });
    expect(taskRow.threadId).toBe(thread.id);
    expect(taskRow.prompt).toContain("WORKER_CHAIN_CLAIM_FIXTURE");
    expect(await db.prisma.attempt.count({ where: { runId: created.id } })).toBe(1);
    const attempts = await db.prisma.attempt.findMany({ where: { runId: created.id } });
    expect(attempts[0]!.status).toBe("completed");
    task.assertComplete();
    await recordTimings();
  } finally {
    await startWorker().catch(() => undefined);
    try {
      release?.();
    } catch {
      // Stream already closed.
    }
    await task?.close();
    await intro?.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
});

test("a cancelled Run retried while the Worker is down stays queued until the Worker claims it", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const apiKey = "worker-chain-retry-key";
  const db = createDb(process.env.DATABASE_URL!);
  let intro: Emulator | undefined;
  let task: Emulator | undefined;
  let release: (() => void) | undefined;
  try {
    await expect.poll(async () => (await workerStatus()).running).toBe(true);
    await assertTopologyHealth();
    const setup = await setupChatBot(
      page,
      apiKey,
      "Ready for the manual retry worker test.",
      "Worker Chain Retry",
    );
    intro = setup.intro;
    const { botId } = setup;
    const retryMarker = `WORKER_CHAIN_RETRY_FIXTURE ${Date.now()}`;
    const retryReply = "WORKER_CHAIN_RETRY_REPLY completed by the standalone worker.";
    const expectRetryFixture = {
      expect(request: { messages: unknown }) {
        // Keep this expect from throwing on the wrap string: a failed
        // fixture assertion aborts the HTTP response and hangs the Worker.
        expect(JSON.stringify(request.messages)).toContain("WORKER_CHAIN_RETRY_FIXTURE");
      },
    };
    task = await startModelEmulator({
      apiKey,
      steps: [
        {
          ...expectRetryFixture,
          response: {
            type: "hold",
            text: "holding the original attempt",
            onOpen: (end) => {
              release = end;
            },
          },
        },
        {
          ...expectRetryFixture,
          response: { type: "text", text: retryReply },
        },
        // Abort of the held original can issue a follow-up model request.
        // Keep a spare text step so that leftover does not starve the retry.
        {
          ...expectRetryFixture,
          response: { type: "text", text: retryReply },
        },
      ],
    });
    await switchToTaskModel(page, botId, apiKey, task);
    await sendMessage(page, retryMarker);
    const thread = await db.prisma.thread.findUniqueOrThrow({ where: { botId } });
    const original = await waitUserRun(db, thread.id);
    await pollRunStatus(db, original.id, "running", 60_000);
    // The Run is promoted before Java issues the model call. Stopping before
    // that call leaves the hold step unused, and the successor then hangs on it.
    await expect.poll(async () => task?.requests.length ?? 0, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => release !== undefined, { timeout: 10_000 }).toBe(true);
    await rpc(page, "threads/stop", { botId });
    await pollRunStatus(db, original.id, "cancelled", 60_000);
    try {
      release?.();
    } catch {
      // Stream already closed by stop.
    }
    await releaseNativeRun(original.id);
    await expect
      .poll(
        async () => db.prisma.attempt.count({ where: { runId: original.id, status: "running" } }),
        { timeout: 30_000 },
      )
      .toBe(0);

    await stopWorker();
    const requestsBeforeRetry = task.requests.length;
    const retried = await rpc<{ runId: string; taskId: string; replayed: boolean }>(
      page,
      "runs/retry",
      { runId: original.id, clientNonce: `worker-chain-retry-${Date.now()}` },
    );
    expect(retried.replayed).toBe(false);
    expect(retried.taskId).toBe(original.taskId);
    for (let index = 0; index < 16; index += 1) {
      const run = await db.prisma.run.findUniqueOrThrow({
        where: { id: retried.runId },
        select: { status: true, leaseOwner: true, retryOfRunId: true },
      });
      expect(run.status).toBe("queued");
      expect(run.leaseOwner).toBeNull();
      expect(run.retryOfRunId).toBe(original.id);
      expect(task.requests.length, "model fixture called without a Worker").toBe(
        requestsBeforeRetry,
      );
      await page.waitForTimeout(500);
    }

    const worker = await startWorker();
    await pollRunStatus(db, retried.runId, "running", 60_000);
    const running = await db.prisma.run.findUniqueOrThrow({ where: { id: retried.runId } });
    expect(running.leaseOwner).not.toBe("api");
    const leasePid = running.leaseOwner!.split("-")[0]!;
    expect(workerNodePids().has(leasePid)).toBe(true);
    await pollRunStatus(db, retried.runId, "completed", 60_000);
    await expect(page.getByTestId("transcript").getByText(retryReply)).toBeVisible({
      timeout: 15_000,
    });
    const final = await db.prisma.run.findUniqueOrThrow({ where: { id: retried.runId } });
    expect(final.status).toBe("completed");
    const source = await db.prisma.run.findUniqueOrThrow({ where: { id: original.id } });
    expect(source.status).toBe("cancelled");
    expect(final.taskId).toBe(original.taskId);
    expect(final.threadId).toBe(original.threadId);
    expect(worker.pid).toBeGreaterThan(0);
    expect(task.requests.length).toBeGreaterThan(requestsBeforeRetry);
    const retryRequest = task.requests.at(-1);
    expect(JSON.stringify(retryRequest?.messages ?? [])).toContain("WORKER_CHAIN_RETRY_FIXTURE");
    expect(JSON.stringify(retryRequest?.messages ?? []).toLowerCase()).toContain("manual retry");
    await recordTimings();
  } finally {
    await startWorker().catch(() => undefined);
    try {
      release?.();
    } catch {
      // Stream already closed.
    }
    await task?.close();
    await intro?.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
});

test("a Routine over-budget failure is proactively delivered exactly once by the standalone Worker", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const apiKey = "worker-chain-routine-key";
  const db = createDb(process.env.DATABASE_URL!);
  let intro: Emulator | undefined;
  let task: Emulator | undefined;
  let releaseRoutineHold: (() => void) | undefined;
  let releaseDeliveryHold: (() => void) | undefined;
  let isolationIntro: Emulator | undefined;
  try {
    await expect.poll(async () => (await workerStatus()).running).toBe(true);
    await assertTopologyHealth();
    const setup = await setupChatBot(
      page,
      apiKey,
      "Ready for the routine delivery test.",
      "Worker Chain Routine",
    );
    intro = setup.intro;
    const { botId } = setup;
    task = await startModelEmulator({
      apiKey,
      steps: [
        {
          // The Routine Run's own model call, held open so the duration
          // budget is the reason this Run ends (as in budget-acceptance).
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain(ROUTINE_MARKER);
          },
          response: {
            type: "hold",
            onOpen: (release) => {
              releaseRoutineHold = release;
            },
          },
        },
        {
          // The Worker-dispatched delivery Run: the production prompt template
          // quotes the failed Run's budget error. Held so the executing
          // Worker process can be identified from the durable lease.
          expect(request) {
            const all = JSON.stringify(request.messages);
            expect(all).toContain(DELIVERY_INSTRUCTION);
            expect(all).toContain("budget_exceeded:duration_sec");
          },
          response: {
            type: "hold",
            text: DELIVERY_TEXT,
            onOpen: (release) => {
              releaseDeliveryHold = release;
            },
          },
        },
      ],
    });
    await switchToTaskModel(page, botId, apiKey, task);
    const thread = await db.prisma.thread.findUniqueOrThrow({ where: { botId } });
    const userMessagesBefore = await db.prisma.message.count({
      where: { threadId: thread.id, role: "user" },
    });

    // Production automation entry: a real Routine, fired through its product
    // test-run RPC, creates the unattended Run on the bot's main Thread. No
    // new user message is sent anywhere in this test.
    const { routineId, runId } = await startRoutineRun(page, botId, "Worker chain routine");
    await pollRunStatus(db, runId, "running", 60_000);
    const source = await db.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(source.trigger).toBe("routine");
    expect(source.routineId).toBe(routineId);
    expect(source.leaseOwner, "the standalone Worker claimed the Routine Run").not.toBeNull();
    expect(workerNodePids().has(source.leaseOwner!.split("-")[0]!)).toBe(true);
    await expect
      .poll(async () => db.prisma.attempt.count({ where: { runId, status: "running" } }), {
        timeout: 20_000,
      })
      .toBe(1);
    // The Run is promoted before the Java process issues the model call; wait
    // for the fixture to actually receive it before rewinding its clock.
    await expect.poll(async () => task?.requests.length ?? 0, { timeout: 30_000 }).toBe(1);

    // Metering fact only; the WORKER's own budget sweep enforces, finalizes
    // and writes the outbox row through the production transaction — the spec
    // never calls enforceRunBudgets or the delivery dispatcher.
    await rewindAttemptClockAndAwaitBudgetFailure(db, runId);
    // Unattended breaches never wait on a human: no budget Intervention exists.
    expect(await db.prisma.intervention.count({ where: { runId } })).toBe(0);
    const lifecycle = await db.prisma.event.findMany({
      where: { runId, type: { in: ["budget.exceeded", "run.failed", "delivery.created"] } },
      orderBy: { seq: "asc" },
      select: { type: true },
    });
    expect(lifecycle.map((event) => event.type)).toEqual([
      "budget.exceeded",
      "run.failed",
      "delivery.created",
    ]);
    const record = await db.prisma.deliveryRecord.findFirstOrThrow({ where: { runId } });
    expect(record.kind).toBe("run_result");
    expect(record.idempotencyKey).toBe(`${runId}:budget_failure`);
    expect(record.threadId).toBe(thread.id);
    expect(record.status).toBe("pending");

    // The Worker's enforce-time abort normally freed the Java session already;
    // this bounded DELETE (same seam as budget-acceptance) guarantees the
    // thread slot before the delivery Run needs it.
    const released = await releaseNativeRun(runId);
    if (released === -1) {
      try {
        releaseRoutineHold?.();
      } catch {
        // Socket already gone.
      }
    }

    // Outbox merge window (30s) + the Worker's dispatch sweep (10s): the
    // Worker itself claims the record and creates the trigger=delivery Run.
    const deliveryGeneration = (await workerStatus()).generation;
    await expect
      .poll(
        async () =>
          (
            await db.prisma.run.findFirst({
              where: { threadId: thread.id, trigger: "delivery" },
              select: { status: true },
            })
          )?.status ?? "none",
        { timeout: 180_000 },
      )
      .toBe("running");
    const inFlight = await db.prisma.run.findFirstOrThrow({
      where: { threadId: thread.id, trigger: "delivery" },
    });
    expect(inFlight.leaseOwner, "the standalone Worker executes the delivery Run").not.toBeNull();
    const deliveryPid = inFlight.leaseOwner!.split("-")[0]!;
    expect(workerNodePids().has(deliveryPid)).toBe(true);
    expect((await workerLogReadyPids(deliveryGeneration)).has(deliveryPid)).toBe(true);

    await expect
      .poll(async () => releaseDeliveryHold !== undefined, { timeout: 30_000 })
      .toBe(true);
    releaseDeliveryHold!();
    await pollRunStatus(db, inFlight.id, "completed", 120_000);
    await expect(page.getByTestId("transcript").getByText(DELIVERY_TEXT)).toBeVisible({
      timeout: 60_000,
    });

    // Traceable ID chain: delivery.created → delivery Run → bot message →
    // delivery.sent, all bound to the same source Run and outbox record.
    const deliveryRun = await db.prisma.run.findFirstOrThrow({
      where: { threadId: thread.id, trigger: "delivery" },
    });
    expect(deliveryRun.id).toBe(inFlight.id);
    const deliveryTask = await db.prisma.task.findUniqueOrThrow({
      where: { id: deliveryRun.taskId },
    });
    expect(deliveryTask.prompt).toContain(DELIVERY_INSTRUCTION);
    const sent = await db.prisma.deliveryRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(sent.status).toBe("sent");
    expect(sent.deliveryRunId).toBe(deliveryRun.id);
    expect(sent.deliveredAt).not.toBeNull();
    timings.outboxToSentMs = sent.deliveredAt!.getTime() - record.createdAt.getTime();
    const createdEvent = await db.prisma.event.findFirstOrThrow({
      where: { runId, type: "delivery.created" },
      select: { payload: true, seq: true },
    });
    expect((createdEvent.payload as { deliveryId?: string }).deliveryId).toBe(record.id);
    expect((createdEvent.payload as { sourceRunId?: string }).sourceRunId).toBe(runId);
    const sentEvent = await db.prisma.event.findFirstOrThrow({
      where: { threadId: thread.id, type: "delivery.sent" },
      select: { payload: true, seq: true },
    });
    expect((sentEvent.payload as { deliveryId?: string }).deliveryId).toBe(record.id);
    const summaries = await db.prisma.message.findMany({
      where: { threadId: thread.id, role: "bot", runId: deliveryRun.id },
    });
    expect(summaries).toHaveLength(1);
    expect(JSON.stringify(summaries[0]!.blocks)).toContain(DELIVERY_TEXT);
    expect((sentEvent.payload as { messageId?: string }).messageId).toBe(summaries[0]!.id);
    expect(sentEvent.seq).toBeGreaterThan(createdEvent.seq);
    // Delivery never fabricates a user turn.
    expect(await db.prisma.message.count({ where: { threadId: thread.id, role: "user" } })).toBe(
      userMessagesBefore,
    );
    // Both model calls (Routine Run + delivery Run) were served to the Java process.
    expect(task.requests.length).toBe(2);

    // Duplicate scheduling: further dispatch sweeps redeliver nothing.
    await page.waitForTimeout(25_000);
    expect(await db.prisma.run.count({ where: { threadId: thread.id, trigger: "delivery" } })).toBe(
      1,
    );
    expect(
      await db.prisma.event.count({ where: { threadId: thread.id, type: "delivery.sent" } }),
    ).toBe(1);
    expect(
      await db.prisma.message.count({
        where: { threadId: thread.id, role: "bot", runId: deliveryRun.id },
      }),
    ).toBe(1);

    // Worker restart after settle: the durable sent record is never re-dispatched.
    await stopWorker();
    await startWorker();
    await page.waitForTimeout(15_000);
    expect(await db.prisma.run.count({ where: { threadId: thread.id, trigger: "delivery" } })).toBe(
      1,
    );
    expect(
      await db.prisma.event.count({ where: { threadId: thread.id, type: "delivery.sent" } }),
    ).toBe(1);
    expect(
      await db.prisma.message.count({
        where: { threadId: thread.id, role: "bot", runId: deliveryRun.id },
      }),
    ).toBe(1);
    const afterRestart = await db.prisma.deliveryRecord.findUniqueOrThrow({
      where: { id: record.id },
    });
    expect(afterRestart.status).toBe("sent");
    expect(afterRestart.deliveryRunId).toBe(deliveryRun.id);

    // Cross-Space isolation: a second user's fresh Space/Thread never sees the
    // result, in the DB or in that Space's own transcript. Uses the proven
    // model-connected onboarding path (a credential-less onboarding parks on a
    // step completeOnboarding does not recognize).
    await page.context().clearCookies();
    const isolation = await setupChatBot(
      page,
      "worker-chain-isolation-key",
      "Ready for the isolation check.",
      "Worker Chain Isolation",
    );
    isolationIntro = isolation.intro;
    await expect(page.getByTestId("transcript").getByText(DELIVERY_TEXT)).toHaveCount(0);
    const isolationBot = isolation.botId;
    const isolationThread = await db.prisma.thread.findUniqueOrThrow({
      where: { botId: isolationBot },
    });
    expect(isolationThread.id).not.toBe(thread.id);
    expect(isolationThread.spaceId).not.toBe(thread.spaceId);
    expect(
      await db.prisma.run.count({ where: { trigger: "delivery", threadId: { not: thread.id } } }),
    ).toBe(0);
    expect(await db.prisma.deliveryRecord.count({ where: { threadId: { not: thread.id } } })).toBe(
      0,
    );
    expect(
      await db.prisma.event.count({
        where: { type: "delivery.sent", threadId: { not: thread.id } },
      }),
    ).toBe(0);
    const isolationMessages = await db.prisma.message.findMany({
      where: { threadId: isolationThread.id },
    });
    expect(
      isolationMessages.every((message) => !JSON.stringify(message.blocks).includes(DELIVERY_TEXT)),
    ).toBe(true);

    task.assertComplete();
    await recordTimings();
  } finally {
    await startWorker().catch(() => undefined);
    try {
      releaseDeliveryHold?.();
    } catch {
      // Stream already closed.
    }
    try {
      releaseRoutineHold?.();
    } catch {
      // Stream already closed.
    }
    await task?.close();
    await intro?.close();
    await isolationIntro?.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
});

test("a Worker crash before the outbox merge window recovers after restart and delivers exactly once", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const apiKey = "worker-chain-crash-key";
  const db = createDb(process.env.DATABASE_URL!);
  let intro: Emulator | undefined;
  let task: Emulator | undefined;
  let releaseRoutineHold: (() => void) | undefined;
  try {
    await expect.poll(async () => (await workerStatus()).running).toBe(true);
    await assertTopologyHealth();
    const setup = await setupChatBot(
      page,
      apiKey,
      "Ready for the crash recovery test.",
      "Worker Chain Crash",
    );
    intro = setup.intro;
    const { botId } = setup;
    task = await startModelEmulator({
      apiKey,
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain(ROUTINE_MARKER);
          },
          response: {
            type: "hold",
            onOpen: (release) => {
              releaseRoutineHold = release;
            },
          },
        },
        {
          expect(request) {
            const all = JSON.stringify(request.messages);
            expect(all).toContain(DELIVERY_INSTRUCTION);
            expect(all).toContain("budget_exceeded:duration_sec");
          },
          response: { type: "text", text: DELIVERY_TEXT },
        },
      ],
    });
    await switchToTaskModel(page, botId, apiKey, task);
    const thread = await db.prisma.thread.findUniqueOrThrow({ where: { botId } });
    const userMessagesBefore = await db.prisma.message.count({
      where: { threadId: thread.id, role: "user" },
    });
    const botMessagesBefore = await db.prisma.message.count({
      where: { threadId: thread.id, role: "bot" },
    });

    const { runId } = await startRoutineRun(page, botId, "Worker chain crash routine");
    await pollRunStatus(db, runId, "running", 60_000);
    await expect
      .poll(async () => db.prisma.attempt.count({ where: { runId, status: "running" } }), {
        timeout: 20_000,
      })
      .toBe(1);
    // Wait for the Java process to actually issue the Routine Run's model call
    // before rewinding its clock.
    await expect.poll(async () => task?.requests.length ?? 0, { timeout: 30_000 }).toBe(1);
    await rewindAttemptClockAndAwaitBudgetFailure(db, runId);
    const pending = await db.prisma.deliveryRecord.findFirstOrThrow({ where: { runId } });
    expect(pending.status).toBe("pending");

    // Kill the Worker while the outbox row is still inside its 30s merge
    // window (nextAttemptAt = createdAt + 30s): nothing was dispatched yet,
    // and with no Worker process nothing may claim, dispatch or post.
    await stopWorker();
    const stoppedRecord = await db.prisma.deliveryRecord.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(stoppedRecord.status).toBe("pending");
    // The failed source Run's Java session must be freed while the Worker is
    // down (its enforce-time abort is best-effort); the runtime process is
    // independent of the Worker and keeps serving.
    const released = await releaseNativeRun(runId);
    if (released === -1) {
      try {
        releaseRoutineHold?.();
      } catch {
        // Socket already gone.
      }
    }

    // Stay down past the due time.
    const downtimeMs = Math.max(0, pending.nextAttemptAt.getTime() - Date.now()) + 10_000;
    await page.waitForTimeout(downtimeMs);
    const afterDowntime = await db.prisma.deliveryRecord.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(afterDowntime.status).toBe("pending");
    expect(afterDowntime.claimedBy).toBeNull();
    expect(afterDowntime.deliveryRunId).toBeNull();
    expect(await db.prisma.run.count({ where: { threadId: thread.id, trigger: "delivery" } })).toBe(
      0,
    );
    expect(
      await db.prisma.event.count({ where: { threadId: thread.id, type: "delivery.sent" } }),
    ).toBe(0);
    expect(await db.prisma.message.count({ where: { threadId: thread.id, role: "bot" } })).toBe(
      botMessagesBefore,
    );
    expect(task.requests.length, "no model activity while the Worker is dead").toBe(1);

    // Restart: the durable outbox row alone drives recovery.
    const restartStart = Date.now();
    await startWorker();
    await expect
      .poll(
        async () =>
          (
            await db.prisma.run.findFirst({
              where: { threadId: thread.id, trigger: "delivery" },
              select: { status: true },
            })
          )?.status ?? "none",
        { timeout: 180_000 },
      )
      .toBe("completed");
    await expect(page.getByTestId("transcript").getByText(DELIVERY_TEXT)).toBeVisible({
      timeout: 60_000,
    });
    const recovery = await db.prisma.deliveryRecord.findUniqueOrThrow({
      where: { id: pending.id },
    });
    timings.crashRestartToSentMs = (recovery.deliveredAt?.getTime() ?? Date.now()) - restartStart;

    const deliveryRun = await db.prisma.run.findFirstOrThrow({
      where: { threadId: thread.id, trigger: "delivery" },
    });
    expect(recovery.status).toBe("sent");
    expect(recovery.deliveryRunId).toBe(deliveryRun.id);
    expect(recovery.deliveredAt).not.toBeNull();
    // Exactly once: one delivery Run, one settled record, one message, one event.
    expect(await db.prisma.run.count({ where: { threadId: thread.id, trigger: "delivery" } })).toBe(
      1,
    );
    expect(await db.prisma.deliveryRecord.count({ where: { runId } })).toBe(1);
    expect(
      await db.prisma.event.count({ where: { threadId: thread.id, type: "delivery.sent" } }),
    ).toBe(1);
    const summaries = await db.prisma.message.findMany({
      where: { threadId: thread.id, role: "bot", runId: deliveryRun.id },
    });
    expect(summaries).toHaveLength(1);
    expect(JSON.stringify(summaries[0]!.blocks)).toContain(DELIVERY_TEXT);
    expect(await db.prisma.message.count({ where: { threadId: thread.id, role: "bot" } })).toBe(
      botMessagesBefore + 1,
    );
    expect(await db.prisma.message.count({ where: { threadId: thread.id, role: "user" } })).toBe(
      userMessagesBefore,
    );

    // More sweep cycles after the restart still redeliver nothing.
    await page.waitForTimeout(25_000);
    expect(await db.prisma.run.count({ where: { threadId: thread.id, trigger: "delivery" } })).toBe(
      1,
    );
    expect(
      await db.prisma.event.count({ where: { threadId: thread.id, type: "delivery.sent" } }),
    ).toBe(1);
    expect(
      await db.prisma.message.count({
        where: { threadId: thread.id, role: "bot", runId: deliveryRun.id },
      }),
    ).toBe(1);
    task.assertComplete();
    await recordTimings();
  } finally {
    await startWorker().catch(() => undefined);
    try {
      releaseRoutineHold?.();
    } catch {
      // Stream already closed.
    }
    await task?.close();
    await intro?.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
});

test("a Worker killed mid-Run recovers the same Run through lease-loss retry and completes it", async ({
  page,
}) => {
  test.setTimeout(1_200_000);
  const apiKey = "worker-chain-recovery-key";
  const db = createDb(process.env.DATABASE_URL!);
  let intro: Emulator | undefined;
  let task: Emulator | undefined;
  let releaseFirst: (() => void) | undefined;
  let releaseRetry: (() => void) | undefined;
  try {
    await expect.poll(async () => (await workerStatus()).running).toBe(true);
    await assertTopologyHealth();
    const setup = await setupChatBot(
      page,
      apiKey,
      "Ready for the lease recovery test.",
      "Worker Chain Recovery",
    );
    intro = setup.intro;
    const { botId } = setup;
    task = await startModelEmulator({
      apiKey,
      steps: [
        {
          // First Attempt: held open, then orphaned by the SIGKILLed Worker.
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("WORKER_CHAIN_RECOVERY_FIXTURE");
          },
          response: {
            type: "hold",
            onOpen: (release) => {
              releaseFirst = release;
            },
          },
        },
        {
          // Retried Attempt on the SAME Run after lease-loss recovery; held so
          // the executing Worker generation is identified from the durable
          // lease before the Run is released to completion.
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("WORKER_CHAIN_RECOVERY_FIXTURE");
          },
          response: {
            type: "hold",
            text: RECOVERY_REPLY,
            onOpen: (release) => {
              releaseRetry = release;
            },
          },
        },
      ],
    });
    await switchToTaskModel(page, botId, apiKey, task);
    await sendMessage(page, RECOVERY_MARKER);
    const thread = await db.prisma.thread.findUniqueOrThrow({ where: { botId } });
    const run = await waitUserRun(db, thread.id);
    await pollRunStatus(db, run.id, "running", 60_000);
    const inFlight = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(inFlight.leaseOwner).not.toBeNull();
    const deadLeaseOwner = inFlight.leaseOwner!;
    expect(workerNodePids().has(deadLeaseOwner.split("-")[0]!)).toBe(true);
    expect(inFlight.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    await expect
      .poll(async () => db.prisma.attempt.count({ where: { runId: run.id, status: "running" } }), {
        timeout: 20_000,
      })
      .toBe(1);
    // The Run is promoted before the Java process issues the model call; wait
    // for the fixture to actually receive it before killing the Worker.
    await expect.poll(async () => task?.requests.length ?? 0, { timeout: 30_000 }).toBe(1);
    const killedGeneration = (await workerStatus()).generation;

    // SIGKILL mid-model-call: no graceful drain, no abort, no finalize.
    await stopWorker();
    await page.waitForTimeout(5_000);
    const orphaned = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(orphaned.status, "nothing may finalize the Run while the Worker is dead").toBe(
      "running",
    );
    expect(orphaned.leaseOwner).toBe(deadLeaseOwner);
    const orphanedAttempt = await db.prisma.attempt.findFirstOrThrow({
      where: { runId: run.id, status: "running" },
      select: { fence: true },
    });
    expect(task.requests.length, "no model activity while the Worker is dead").toBe(1);
    await expect(page.getByTestId("transcript").getByText(RECOVERY_REPLY)).toHaveCount(0);

    // No clock seam here: the run lease and the computer execution lease are
    // both hard-coded 5-minute TTLs renewed by the same 60s heartbeat, so the
    // dead Worker's leases expire on the real clock at most 5 minutes after
    // the kill. Recovery then runs entirely in production code: the
    // reconciler's run.continue enqueue supersedes the SIGKILLed graphile
    // job's stale lock (replace-mode add_job nulls the locked row's key and
    // inserts a fresh job), the lease-loss path aborts the orphaned Java
    // session and schedules the automatic retry, and the expired
    // computer-execution lease is reclaimed on promotion.

    const recoveryStart = Date.now();
    const worker = await startWorker();
    expect(worker.generation).toBe(killedGeneration + 1);

    // The restarted Worker re-runs run.continue; the production lease-loss
    // path aborts the orphaned Java session (closing the first held model
    // stream), schedules the automatic lease_lost retry (5s) and re-executes
    // the SAME Run under a new fence.
    await expect
      .poll(async () => db.prisma.event.count({ where: { runId: run.id, type: "run.retried" } }), {
        timeout: 480_000,
      })
      .toBe(1);
    const retriedEvent = await db.prisma.event.findFirstOrThrow({
      where: { runId: run.id, type: "run.retried" },
      select: { payload: true },
    });
    expect((retriedEvent.payload as { reason?: string }).reason).toBe("lease_lost");
    const retriedAttempt = await db.prisma.attempt.findFirstOrThrow({
      where: { runId: run.id, status: "retry_scheduled" },
      select: { fence: true, error: true },
    });
    expect(retriedAttempt.fence).toBe(orphanedAttempt.fence);
    expect(retriedAttempt.error).toContain("lease expired");

    await expect
      .poll(
        async () => {
          const current = await db.prisma.run.findUnique({
            where: { id: run.id },
            select: { status: true, leaseFence: true, leaseOwner: true },
          });
          return current &&
            current.status === "running" &&
            current.leaseFence > retriedAttempt.fence &&
            current.leaseOwner
            ? current.leaseOwner
            : null;
        },
        { timeout: 480_000 },
      )
      .not.toBeNull();
    const rerun = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(rerun.leaseOwner).not.toBeNull();
    expect(rerun.leaseOwner).not.toBe(deadLeaseOwner);
    const retryPid = rerun.leaseOwner!.split("-")[0]!;
    expect(workerNodePids().has(retryPid)).toBe(true);
    expect(
      (await workerLogReadyPids(worker.generation)).has(retryPid),
      "the NEW Worker generation's own log records the retry lease-holder pid",
    ).toBe(true);

    await expect.poll(async () => releaseRetry !== undefined, { timeout: 30_000 }).toBe(true);
    releaseRetry!();
    await pollRunStatus(db, run.id, "completed", 120_000);
    timings.leaseLossRecoveryMs = Date.now() - recoveryStart;
    // Real-clock recovery: ≤5min lease TTL + ≤30s reconciler + 5s retry delay
    // + re-execution. Bound generously; the measured value is recorded.
    expect(timings.leaseLossRecoveryMs, "bounded recovery").toBeLessThan(660_000);

    await expect(page.getByTestId("transcript").getByText(RECOVERY_REPLY)).toBeVisible({
      timeout: 60_000,
    });
    const final = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(final.status).toBe("completed");
    expect(final.error).toBeNull();
    const attempts = await db.prisma.attempt.findMany({
      where: { runId: run.id },
      orderBy: { fence: "asc" },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.status).toBe("retry_scheduled");
    expect(attempts[1]!.status).toBe("completed");
    expect(attempts[1]!.fence).toBeGreaterThan(attempts[0]!.fence);
    const replies = await db.prisma.message.findMany({
      where: { threadId: thread.id, role: "bot", runId: run.id },
    });
    expect(replies).toHaveLength(1);
    expect(JSON.stringify(replies[0]!.blocks)).toContain(RECOVERY_REPLY);
    // Both model calls served the same Run content — the orphaned Attempt and
    // the retry — correlated by fixture request log, DB attempts and lease pids.
    expect(task.requests.length).toBe(2);
    task.assertComplete();
    await recordTimings();
  } finally {
    await startWorker().catch(() => undefined);
    try {
      releaseRetry?.();
    } catch {
      // Stream already closed.
    }
    try {
      releaseFirst?.();
    } catch {
      // Stream already closed.
    }
    await task?.close();
    await intro?.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
});
