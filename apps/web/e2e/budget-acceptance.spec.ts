import { expect, type Page, test } from "@playwright/test";
import { AgentScopeAgentRuntime } from "../../../packages/adapters/src/agentscope-runtime.js";
import { deliverRunAborts } from "../../../packages/adapters/src/revoke-cancelled-work.js";
import { enforceRunBudgets } from "../../../packages/adapters/src/run-budget-enforcement.js";
import { createDb, createThreadEvents } from "../../../packages/db/src/index.js";
import { startModelEmulator } from "../../../packages/testkit/src/model-emulator.js";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

type Emulator = Awaited<ReturnType<typeof startModelEmulator>>;
type Db = ReturnType<typeof createDb>;

/**
 * Task 18 production-acceptance chains: a real Java AgentScope Run, the real
 * API/DB/Web stack, and the production budget entry point. Only measured facts
 * are injected (persisted UsageRecords, real product events, attempt clocks);
 * Runs, Interventions, messages and terminal states are all produced by the
 * production paths.
 */

function productionBudgetEnforcer(db: Db) {
  const events = createThreadEvents(db.prisma);
  // The production runtime adapter: its abort stops the local stream and sends
  // the native DELETE with a 1.5s timeout, exactly like the Worker sweep.
  const runtime = new AgentScopeAgentRuntime({ baseUrl: process.env.AGENTSCOPE_URL ?? "" });
  return (runId?: string) =>
    enforceRunBudgets({ prisma: db.prisma, events, runtime }, new Date(), runId);
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
      { timeout: 30_000 },
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

/**
 * The production Worker sweep retries run aborts whose DELETE did not land
 * (retryPendingRunAborts). The held model stream fixture needs the same
 * retry before another Run may use the Java session slot.
 */
async function releaseNativeRun(db: Db, runId: string) {
  const runtime = new AgentScopeAgentRuntime({ baseUrl: process.env.AGENTSCOPE_URL ?? "" });
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await deliverRunAborts(db.prisma, (id) => runtime.abort(id), [runId]);
    if (result.revoked.includes(runId)) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Runtime abort was not confirmed for ${runId}`);
}

async function waitRunRunning(page: Page, db: Db, botId: string) {
  let runId = "";
  await expect
    .poll(
      async () => {
        const thread = await rpc<{ run?: { id: string; status: string } | null }>(
          page,
          "threads/get",
          { botId },
        );
        if (thread.run && thread.run.status !== "completed") runId = thread.run.id;
        return thread.run?.status;
      },
      { timeout: 40_000 },
    )
    .toBe("running");
  await expect
    .poll(
      async () =>
        db.prisma.attempt.findFirst({ where: { runId, status: "running" }, select: { id: true } }),
      { timeout: 20_000 },
    )
    .not.toBeNull();
  return runId;
}

test("token budget breach lets the owner raise the budget and the same Run finishes", async ({
  page,
  browser,
}) => {
  test.skip(process.env.AGENT_RUNTIME !== "agentscope", "Run with --runtime=agentscope");
  test.setTimeout(240_000);
  const apiKey = "web-token-budget-key";
  const db = createDb(process.env.DATABASE_URL!);
  const enforce = productionBudgetEnforcer(db);
  let intro: Emulator | undefined;
  let task: Emulator | undefined;
  try {
    const setup = await setupChatBot(page, apiKey, "Ready for the token budget test.", "Java Token Budget");
    intro = setup.intro;
    const { botId } = setup;
    let releaseTokenHold: (() => void) | undefined;
    task = await startModelEmulator({
      apiKey,
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain(
              "Hold this token budget fixture open.",
            );
          },
          response: { type: "hold", onOpen: (release) => { releaseTokenHold = release; } },
        },
        {
          expect(request) {
            // The resumed Attempt replays the original Task prompt unchanged.
            expect(JSON.stringify(request.messages)).toContain(
              "Hold this token budget fixture open.",
            );
          },
          response: { type: "text", text: "Token budget raised and finished." },
        },
      ],
    });
    await switchToTaskModel(page, botId, apiKey, task);
    await page.getByPlaceholder(/Message/).fill("Hold this token budget fixture open.");
    await page.keyboard.press("Enter");

    const runId = await waitRunRunning(page, db, botId);
    const run = await db.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.budgetOverride).toBeNull();

    // Metering fact: a persisted UsageRecord past the interactive 200k budget,
    // read back through the production enforcement query.
    await db.prisma.usageRecord.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        userId: run.userId,
        runId,
        provider: "openai-compatible",
        model: task.model.id,
        inputTokens: 200_001,
        outputTokens: 0,
      },
    });
    await enforce(runId);

    await expect(page.getByText(/reached its tokens budget/i)).toBeVisible({ timeout: 40_000 });
    expect(await db.prisma.event.count({ where: { runId, type: "budget.exceeded" } })).toBe(1);
    expect(await db.prisma.intervention.count({ where: { runId } })).toBe(1);
    // End the held model stream so the Java session slot frees deterministically
    // before the owner resumes the same Run (the Worker's abort retry alone races).
    releaseTokenHold?.();
    await releaseNativeRun(db, runId);
    const intervention = await db.prisma.intervention.findFirstOrThrow({ where: { runId } });
    expect(await db.prisma.run.findUnique({ where: { id: runId }, select: { status: true } }))
      .toMatchObject({ status: "waiting_input" });

    // A different authenticated user cannot raise this owner's budget.
    const strangerContext = await browser.newContext();
    const stranger = await strangerContext.newPage();
    await signup(
      stranger,
      `token-stranger-${Date.now()}@rakazo.test`,
      "password12",
      "Token Stranger",
    );
    await stranger.waitForURL(/\/(onboarding|app)/);
    // A different authenticated user is refused by the API; the error body is
    // not part of the contract, so assert the authoritative rejection status.
    const strangerReply = await stranger.request.post("/rpc/threads/resolveIntervention", {
      data: {
        json: {
          botId,
          interventionId: intervention.id,
          clientSubmissionId: `stranger-${Date.now()}`,
          answer: "increase_budget",
        },
      },
    });
    expect(strangerReply.ok()).toBe(false);
    await strangerContext.close();
    expect(
      await db.prisma.run.findUnique({
        where: { id: runId },
        select: { status: true, budgetOverride: true },
      }),
    ).toMatchObject({ status: "waiting_input", budgetOverride: null });

    await page.getByRole("button", { name: "Increase the budget and continue" }).click();

    // The production scan must not immediately re-pause on the old spend while
    // the same Run executes again with the raised persisted budget. The
    // harness sweep keeps scanning every ten seconds through the resume, so a
    // re-pause would surface as a second budget.exceeded or a stalled Run.
    expect(await enforce(runId)).toBe(0);

    await expect(
      page.getByTestId("transcript").getByText("Token budget raised and finished."),
    ).toBeVisible({ timeout: 60_000 });

    const final = await db.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(final.status).toBe("completed");
    // Same Task, one Run: raising the budget never forks a second execution.
    expect(final.taskId).toBe(run.taskId);
    expect(await db.prisma.run.count({ where: { taskId: run.taskId } })).toBe(1);
    const override = final.budgetOverride as { maxTokens?: number } | null;
    expect(override?.maxTokens ?? 0).toBeGreaterThan(200_001);
    const attempts = await db.prisma.attempt.findMany({ where: { runId }, orderBy: { fence: "asc" } });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.fence).toBeGreaterThan(attempts[0]!.fence);
    expect(attempts[1]!.status).toBe("completed");
    expect(await db.prisma.event.count({ where: { runId, type: "budget.exceeded" } })).toBe(1);

    // The Intervention settles exactly once.
    const settled = await db.prisma.intervention.findUniqueOrThrow({ where: { id: intervention.id } });
    expect(settled.status).not.toBe("pending");
    expect(settled.resolvedAt).not.toBeNull();
    const submissions = await db.prisma.interventionSubmission.findMany({
      where: { interventionId: intervention.id },
    });
    expect(submissions).toHaveLength(1);

    // Duplicate submissions return the authoritative outcome without re-enqueue:
    // the recorded submission id replays, a fresh id is rejected.
    const replayReply = await page.request.post("/rpc/threads/resolveIntervention", {
      data: {
        json: {
          botId,
          interventionId: intervention.id,
          clientSubmissionId: submissions[0]!.clientSubmissionId,
          answer: "increase_budget",
        },
      },
    });
    const replay = (await replayReply.json()) as { json?: { outcome?: string } };
    expect(replayReply.status()).toBe(200);
    expect(replay.json?.outcome).toBe("accepted");
    const freshReply = await page.request.post("/rpc/threads/resolveIntervention", {
      data: {
        json: {
          botId,
          interventionId: intervention.id,
          clientSubmissionId: `fresh-${Date.now()}`,
          answer: "increase_budget",
        },
      },
    });
    // Authoritative terminal state: a fresh submission id on a settled
    // Intervention is already_handled and applies nothing again.
    expect(freshReply.status()).toBe(200);
    const freshBody = (await freshReply.json()) as { json?: { outcome?: string } };
    expect(freshBody.json?.outcome).toBe("already_handled");
    expect(await db.prisma.run.count({ where: { taskId: run.taskId } })).toBe(1);
    expect(await db.prisma.attempt.count({ where: { runId } })).toBe(2);
    expect(await db.prisma.event.count({ where: { runId, type: "budget.exceeded" } })).toBe(1);
    task.assertComplete();
  } finally {
    await task?.close();
    await intro?.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
});

test("tool-call budget breach narrows scope through the unified cancellation path", async ({
  page,
}) => {
  test.skip(process.env.AGENT_RUNTIME !== "agentscope", "Run with --runtime=agentscope");
  test.setTimeout(240_000);
  const apiKey = "web-tool-budget-key";
  const db = createDb(process.env.DATABASE_URL!);
  const enforce = productionBudgetEnforcer(db);
  const events = createThreadEvents(db.prisma);
  let intro: Emulator | undefined;
  let task: Emulator | undefined;
  try {
    const setup = await setupChatBot(page, apiKey, "Ready for the tool budget test.", "Java Tool Budget");
    intro = setup.intro;
    const { botId } = setup;
    task = await startModelEmulator({
      apiKey,
      steps: [
        {
          // AG-02/AG-06: native delegation is suspended, so agent_spawn is
          // never offered and no background helper can keep the run open. The
          // model call itself holds the stream while the budget breach is
          // metered and enforced.
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Run the tool budget fixture.");
            expect(request.tools?.some((tool) => tool.function.name === "agent_spawn")).toBe(false);
          },
          response: { type: "hold" },
        },
      ],
    });
    await switchToTaskModel(page, botId, apiKey, task);
    await page.getByPlaceholder(/Message/).fill("Run the tool budget fixture.");
    await page.keyboard.press("Enter");

    const runId = await waitRunRunning(page, db, botId);
    const run = await db.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    const threadId = run.threadId;
    // Suspended delegation cannot attach a background task to the run; the
    // budget breach is enforced on the metered run itself.
    expect(
      await db.prisma.backgroundAgentTask.findFirst({
        where: { parentRunId: runId },
        select: { taskId: true },
      }),
    ).toBeNull();

    // Metering facts: real agent.tool.called product events past the 50-call
    // interactive budget, written through the production event append path.
    for (let index = 0; index < 51; index++) {
      await events.append({
        spaceId: run.spaceId,
        threadId,
        botId: run.botId,
        runId,
        type: "agent.tool.called",
        payload: { name: "budget_meter_fixture", executionId: `meter-${index}` },
      });
    }
    await enforce(runId);

    await expect(page.getByText(/reached its tool calls budget/i)).toBeVisible({ timeout: 40_000 });
    expect(await db.prisma.event.count({ where: { runId, type: "budget.exceeded" } })).toBe(1);
    const intervention = await db.prisma.intervention.findFirstOrThrow({ where: { runId } });
    const runsBefore = await db.prisma.run.count({ where: { threadId } });

    await page.getByRole("button", { name: "Stop and send a narrower request" }).click();

    await expect
      .poll(
        async () =>
          db.prisma.run.findUnique({ where: { id: runId }, select: { status: true, error: true } }),
        { timeout: 30_000 },
      )
      .toMatchObject({ status: "cancelled", error: "budget_narrowed" });
    // Still no background task after the unified cancellation path ran; the
    // cancellation of an ALREADY-started task stays covered in-JVM
    // (RuntimeIntegrationTest through the delegation seam).
    expect(
      await db.prisma.backgroundAgentTask.findFirst({
        where: { parentRunId: runId },
        select: { taskId: true },
      }),
    ).toBeNull();

    const finalRun = await db.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(finalRun.leaseOwner).toBeNull();
    const attempts = await db.prisma.attempt.findMany({ where: { runId } });
    expect(attempts.every((attempt) => attempt.status !== "running")).toBe(true);
    expect(await db.prisma.event.count({ where: { runId, type: "run.cancelled" } })).toBe(1);
    const settled = await db.prisma.intervention.findUniqueOrThrow({ where: { id: intervention.id } });
    expect(settled.status).not.toBe("pending");
    expect(settled.resolvedAt).not.toBeNull();
    expect(
      await db.prisma.interventionSubmission.count({ where: { interventionId: intervention.id } }),
    ).toBe(1);
    // One guidance hint, and narrowing never auto-starts a replacement Run.
    const messages = await db.prisma.message.findMany({ where: { threadId, role: "bot" } });
    expect(
      messages.filter((message) =>
        JSON.stringify(message.blocks).includes("Send a narrower request to start a new run."),
      ),
    ).toHaveLength(1);
    expect(await db.prisma.run.count({ where: { threadId } })).toBe(runsBefore);

    // Repeat scans and repeat submissions add no second terminal event.
    expect(await enforce(runId)).toBe(0);
    const freshNarrowReply = await page.request.post("/rpc/threads/resolveIntervention", {
      data: {
        json: {
          botId,
          interventionId: intervention.id,
          clientSubmissionId: `fresh-${Date.now()}`,
          answer: "narrow_scope",
        },
      },
    });
    expect(freshNarrowReply.status()).toBe(200);
    const freshNarrowBody = (await freshNarrowReply.json()) as { json?: { outcome?: string } };
    expect(freshNarrowBody.json?.outcome).toBe("already_handled");
    expect(await db.prisma.event.count({ where: { runId, type: "run.cancelled" } })).toBe(1);
    expect(await db.prisma.run.count({ where: { threadId } })).toBe(runsBefore);
    const laterMessages = await db.prisma.message.findMany({ where: { threadId, role: "bot" } });
    expect(
      laterMessages.filter((message) =>
        JSON.stringify(message.blocks).includes("Send a narrower request to start a new run."),
      ),
    ).toHaveLength(1);
    task.assertComplete();
  } finally {
    await task?.close();
    await intro?.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
});

test("routine budget breach fails the Run and queues one delivery behind recovering admission", async ({
  page,
}) => {
  test.skip(process.env.AGENT_RUNTIME !== "agentscope", "Run with --runtime=agentscope");
  test.setTimeout(300_000);
  const apiKey = "web-routine-budget-key";
  const db = createDb(process.env.DATABASE_URL!);
  const enforce = productionBudgetEnforcer(db);
  let intro: Emulator | undefined;
  let task: Emulator | undefined;
  try {
    const setup = await setupChatBot(page, apiKey, "Ready for the routine budget test.", "Java Routine Budget");
    intro = setup.intro;
    const { botId } = setup;
    let releaseRoutineHold: (() => void) | undefined;
    task = await startModelEmulator({
      apiKey,
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("ROUTINE_BUDGET_FIXTURE");
          },
          response: { type: "hold", onOpen: (release) => { releaseRoutineHold = release; } },
        },
      ],
    });
    await switchToTaskModel(page, botId, apiKey, task);

    // Production automation path: a real Routine, fired through its product
    // test-run entry, creates the unattended Run on the bot's main Thread.
    const routine = await rpc<{ id: string }>(page, "routines/create", {
      botId,
      name: "Budget fixture routine",
      prompt: "ROUTINE_BUDGET_FIXTURE: report the nightly fixture status.",
      crons: ["0 0 1 1 *"],
      timezone: "UTC",
      active: false,
    });
    const thread = await db.prisma.thread.findUniqueOrThrow({ where: { botId } });
    const { runId } = await rpc<{ runId: string }>(page, "routines/testRun", {
      routineId: routine.id,
      clientNonce: `budget-fixture-${Date.now()}`,
    });
    await expect
      .poll(
        async () =>
          db.prisma.run.findUnique({ where: { id: runId }, select: { status: true } }),
        { timeout: 60_000 },
      )
      .toMatchObject({ status: "running" });
    await expect
      .poll(
        async () =>
          db.prisma.attempt.findFirst({
            where: { runId, status: "running" },
            select: { id: true },
          }),
        { timeout: 20_000 },
      )
      .not.toBeNull();
    const fixtureRun = await db.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(fixtureRun.trigger).toBe("routine");
    const userMessagesBefore = await db.prisma.message.count({
      where: { threadId: thread.id, role: "user" },
    });

    // Metering fact: rewind only the measured attempt clock past the 3600s
    // unattended duration budget.
    const activeAttempt = await db.prisma.attempt.findFirstOrThrow({
      where: { runId, status: "running" },
      select: { id: true },
    });
    await db.prisma.attempt.update({
      where: { id: activeAttempt.id },
      data: { startedAt: new Date(Date.now() - 3_601_000) },
    });
    await enforce(runId);

    await expect
      .poll(
        async () =>
          db.prisma.run.findUnique({ where: { id: runId }, select: { status: true, error: true } }),
        { timeout: 30_000 },
      )
      .toMatchObject({ status: "failed", error: "budget_exceeded:duration_sec" });
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
    // Free the Java session slot after the Worker persisted its abort retry.
    // RT-25 retains chat admission until RT-26 supplies clean/detached proof,
    // so the delivery Run must remain queued instead of entering the session.
    releaseRoutineHold?.();
    await releaseNativeRun(db, runId);

    await expect
      .poll(
        async () =>
          db.prisma.run.findFirst({
            where: { threadId: thread.id, trigger: "delivery" },
            select: { id: true, status: true, leaseOwner: true },
          }),
        { timeout: 120_000 },
      )
      .toMatchObject({ status: "queued", leaseOwner: null });
    expect(await db.prisma.message.count({ where: { threadId: thread.id, role: "user" } })).toBe(
      userMessagesBefore,
    );

    const deliveryRun = await db.prisma.run.findFirstOrThrow({
      where: { threadId: thread.id, trigger: "delivery" },
    });
    expect(deliveryRun).toMatchObject({ status: "queued", leaseOwner: null, error: null });
    const record = await db.prisma.deliveryRecord.findFirstOrThrow({ where: { runId } });
    expect(record.deliveryRunId).toBe(deliveryRun.id);
    expect(record.status).toBe("claimed");
    expect(record.deliveredAt).toBeNull();
    expect(
      await db.prisma.agentSessionAdmission.findFirstOrThrow({ where: { ownerRunId: runId } }),
    ).toMatchObject({ state: "recovering", ownerRunId: runId });
    expect(await db.prisma.run.count({ where: { threadId: thread.id, trigger: "delivery" } })).toBe(
      1,
    );
    expect(
      await db.prisma.event.count({ where: { threadId: thread.id, type: "delivery.sent" } }),
    ).toBe(0);
    const summaries = await db.prisma.message.findMany({
      where: { threadId: thread.id, role: "bot", runId: deliveryRun.id },
    });
    expect(summaries).toHaveLength(0);

    // Repeated Worker scheduling neither releases admission nor forks a Run.
    await page.waitForTimeout(12_000);
    expect(await db.prisma.run.count({ where: { threadId: thread.id, trigger: "delivery" } })).toBe(
      1,
    );
    expect(
      await db.prisma.event.count({ where: { threadId: thread.id, type: "delivery.sent" } }),
    ).toBe(0);
    expect(
      await db.prisma.message.count({
        where: { threadId: thread.id, role: "bot", runId: deliveryRun.id },
      }),
    ).toBe(0);
    task.assertComplete();
  } finally {
    await task?.close();
    await intro?.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
});
