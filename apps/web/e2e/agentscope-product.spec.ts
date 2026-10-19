import { expect, test } from "@playwright/test";
import { createDb } from "../../../packages/db/src/index.js";
import { startModelEmulator } from "../../../packages/testkit/src/model-emulator.js";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

test("Web chat completes a Java Harness tool round trip", async ({ page }) => {
  test.skip(process.env.AGENT_RUNTIME !== "agentscope", "Run with --runtime=agentscope");
  const intro = await startModelEmulator({
    apiKey: "web-runtime-fixture-key",
    steps: [{ expect() {}, response: { type: "text", text: "Ready to help." } }],
  });
  let task: Awaited<ReturnType<typeof startModelEmulator>> | undefined;
  try {
    await signup(page, `java-web-${Date.now()}@rakazo.test`, "password12", "Java Web");
    await page.waitForURL(/\/(onboarding|app)/);
    await rpc(page, "models/connect", {
      provider: intro.model.provider,
      modelId: intro.model.id,
      baseUrl: intro.baseUrl,
      apiKey: "web-runtime-fixture-key",
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
    await rpc(page, "agentSkills/create", {
      content: [
        "---",
        "name: web-fixture-skill",
        "description: Check the Java Harness skill bridge.",
        "---",
        "",
        "WEB_SKILL_BRIDGE_MARKER",
      ].join("\n"),
    });

    task = await startModelEmulator({
      apiKey: "web-runtime-fixture-key",
      steps: [
        {
          expect(request) {
            expect(
              request.tools?.some((tool) => tool.function.name === "load_skill_through_path"),
            ).toBe(true);
            expect(JSON.stringify(request.messages)).toContain("web-fixture-skill");
          },
          response: {
            type: "tool",
            id: "web-skill",
            name: "load_skill_through_path",
            arguments: { skillId: "web-fixture-skill_workpal", path: "SKILL.md" },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("WEB_SKILL_BRIDGE_MARKER");
            expect(JSON.stringify(request.messages)).toContain(
              "Save hello to notes/web-result.txt.",
            );
            expect(request.tools?.some((tool) => tool.function.name === "write_file")).toBe(true);
          },
          response: {
            type: "tool",
            id: "web-write",
            name: "write_file",
            arguments: { path: "notes/web-result.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("web-write");
          },
          response: { type: "text", text: "Saved notes/web-result.txt." },
        },
      ],
    });
    await rpc(page, "models/connect", {
      provider: task.model.provider,
      modelId: task.model.id,
      baseUrl: task.baseUrl,
      apiKey: "web-runtime-fixture-key",
    });
    await rpc(page, "bots/update", {
      botId,
      modelProvider: task.model.provider,
      modelId: task.model.id,
    });
    const composer = page.getByPlaceholder(/Message/);
    await composer.fill("Save hello to notes/web-result.txt.");
    await page.keyboard.press("Enter");
    await expect(
      page.getByTestId("transcript").getByText("Saved notes/web-result.txt."),
    ).toBeVisible({ timeout: 40_000 });
    const file = await rpc<{ content: string }>(page, "computer/readFile", {
      botId,
      path: "notes/web-result.txt",
    });
    expect(file.content).toBe("hello");
    task.assertComplete();
  } finally {
    await task?.close();
    await intro.close();
  }
});

test("Java Run reaches a duration budget and Web cancels its waiting card", async ({ page }) => {
  test.skip(process.env.AGENT_RUNTIME !== "agentscope", "Run with --runtime=agentscope");
  const intro = await startModelEmulator({
    apiKey: "web-budget-fixture-key",
    steps: [{ expect() {}, response: { type: "text", text: "Ready for the budget test." } }],
  });
  const db = createDb(process.env.DATABASE_URL!);
  let task: Awaited<ReturnType<typeof startModelEmulator>> | undefined;
  try {
    await signup(page, `java-budget-${Date.now()}@rakazo.test`, "password12", "Java Budget");
    await page.waitForURL(/\/(onboarding|app)/);
    await rpc(page, "models/connect", {
      provider: intro.model.provider,
      modelId: intro.model.id,
      baseUrl: intro.baseUrl,
      apiKey: "web-budget-fixture-key",
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

    task = await startModelEmulator({
      apiKey: "web-budget-fixture-key",
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Hold this budget fixture open.");
          },
          response: { type: "hold" },
        },
      ],
    });
    await rpc(page, "models/connect", {
      provider: task.model.provider,
      modelId: task.model.id,
      baseUrl: task.baseUrl,
      apiKey: "web-budget-fixture-key",
    });
    await rpc(page, "bots/update", {
      botId,
      modelProvider: task.model.provider,
      modelId: task.model.id,
    });
    await page.getByPlaceholder(/Message/).fill("Hold this budget fixture open.");
    await page.keyboard.press("Enter");

    let runId = "";
    await expect
      .poll(
        async () => {
          const thread = await rpc<{ run?: { id: string; status: string } | null }>(
            page,
            "threads/get",
            { botId },
          );
          if (thread.run?.status === "running") runId = thread.run.id;
          return thread.run?.status;
        },
        { timeout: 40_000 },
      )
      .toBe("running");
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
    // Advance only the measured attempt clock; the Run, Java request and Worker path are real.
    const activeAttempt = await db.prisma.attempt.findFirstOrThrow({
      where: { runId, status: "running" },
      select: { id: true },
    });
    await db.prisma.attempt.update({
      where: { id: activeAttempt.id },
      data: { startedAt: new Date(Date.now() - 901_000) },
    });

    await expect(page.getByText(/reached its duration sec budget/i)).toBeVisible({
      timeout: 40_000,
    });
    await expect
      .poll(() =>
        db.prisma.event.count({
          where: { runId, type: "budget.exceeded" },
        }),
      )
      .toBe(1);
    await page.getByRole("button", { name: "Cancel this run" }).click();
    await expect
      .poll(async () =>
        db.prisma.run.findUnique({
          where: { id: runId },
          select: { status: true, error: true },
        }),
      )
      .toMatchObject({ status: "cancelled", error: "budget_cancelled" });
    task.assertComplete();
  } finally {
    await task?.close();
    await intro.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
});

test("Web chat resumes a native Harness plan after approval", async ({ page }) => {
  test.skip(process.env.AGENT_RUNTIME !== "agentscope", "Run with --runtime=agentscope");
  const intro = await startModelEmulator({
    apiKey: "web-plan-fixture-key",
    steps: [{ expect() {}, response: { type: "text", text: "Ready to plan." } }],
  });
  let plan: Awaited<ReturnType<typeof startModelEmulator>> | undefined;
  try {
    await signup(page, `java-plan-${Date.now()}@rakazo.test`, "password12", "Java Plan");
    await page.waitForURL(/\/(onboarding|app)/);
    await rpc(page, "models/connect", {
      provider: intro.model.provider,
      modelId: intro.model.id,
      baseUrl: intro.baseUrl,
      apiKey: "web-plan-fixture-key",
    });
    await page.reload();
    await completeOnboarding(page);
    const botId = activeBotId(page);
    plan = await startModelEmulator({
      apiKey: "web-plan-fixture-key",
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Make a plan for the fixture.");
          },
          response: { type: "tool", id: "plan-enter", name: "plan_enter", arguments: {} },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("plan-enter");
          },
          response: {
            type: "tool",
            id: "plan-write",
            name: "plan_write",
            arguments: { content: "# Plan\n1. Inspect\n2. Finish" },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("plan-write");
          },
          response: {
            type: "tool",
            id: "plan-exit",
            name: "plan_exit",
            arguments: { summary: "Carry out the fixture plan" },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("plan-exit");
          },
          response: { type: "text", text: "Plan approved and completed." },
        },
      ],
    });
    await rpc(page, "models/connect", {
      provider: plan.model.provider,
      modelId: plan.model.id,
      baseUrl: plan.baseUrl,
      apiKey: "web-plan-fixture-key",
    });
    await rpc(page, "bots/update", {
      botId,
      modelProvider: plan.model.provider,
      modelId: plan.model.id,
    });
    const composer = page.getByPlaceholder(/Message/);
    await composer.fill("Make a plan for the fixture.");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible({
      timeout: 40_000,
    });
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(
      page.getByTestId("transcript").getByText("Plan approved and completed."),
    ).toBeVisible({ timeout: 40_000 });
    plan.assertComplete();
  } finally {
    await plan?.close();
    await intro.close();
  }
});

// AG-02/AG-06: native helper delegation is suspended at the production
// entrypoint and the platform prompt no longer advertises it. This journey
// pins the Web-visible contract: agent_spawn is never offered, a model that
// attempts it anyway is refused without ever constructing a helper, the run
// completes directly, and the AG-06 fixed prompt segment ships on a real
// Web run.
test("Web chat never offers native subagent delegation while suspended", async ({ page }) => {
  test.skip(process.env.AGENT_RUNTIME !== "agentscope", "Run with --runtime=agentscope");
  const intro = await startModelEmulator({
    apiKey: "web-subagent-fixture-key",
    steps: [{ expect() {}, response: { type: "text", text: "Ready to delegate." } }],
  });
  let task: Awaited<ReturnType<typeof startModelEmulator>> | undefined;
  try {
    await signup(page, `java-child-${Date.now()}@rakazo.test`, "password12", "Java Child");
    await page.waitForURL(/\/(onboarding|app)/);
    await rpc(page, "models/connect", {
      provider: intro.model.provider,
      modelId: intro.model.id,
      baseUrl: intro.baseUrl,
      apiKey: "web-subagent-fixture-key",
    });
    await page.reload();
    await completeOnboarding(page);
    const botId = activeBotId(page);
    task = await startModelEmulator({
      apiKey: "web-subagent-fixture-key",
      steps: [
        {
          expect(request) {
            expect(request.tools?.some((tool) => tool.function.name === "agent_spawn")).toBe(false);
            const system = String(
              request.messages.find((message) => message.role === "system")?.content ?? "",
            );
            expect(system).toContain("<content-trust-rules>");
            expect(system).not.toContain("helpers are allowed");
            expect(system).not.toContain("agent_spawn");
          },
          response: {
            type: "tool",
            id: "web-spawn",
            name: "agent_spawn",
            arguments: { agent_id: "helper", task: "Return CHILD_WEB_MARKER." },
          },
        },
        {
          expect(request) {
            // The refused call surfaces as a tool error; no helper session ever
            // reaches the model.
            const transcript = JSON.stringify(request.messages);
            expect(transcript).toContain("Return CHILD_WEB_MARKER.");
            expect(transcript).not.toContain("You are a helper");
          },
          response: { type: "text", text: "Delegation is unavailable; finished directly." },
        },
      ],
    });
    await rpc(page, "models/connect", {
      provider: task.model.provider,
      modelId: task.model.id,
      baseUrl: task.baseUrl,
      apiKey: "web-subagent-fixture-key",
    });
    await rpc(page, "bots/update", {
      botId,
      modelProvider: task.model.provider,
      modelId: task.model.id,
    });
    const composer = page.getByPlaceholder(/Message/);
    await composer.fill("Delegate this fixture to the helper and report its result.");
    await page.keyboard.press("Enter");
    await expect(
      page.getByTestId("transcript").getByText("Delegation is unavailable; finished directly."),
    ).toBeVisible({ timeout: 40_000 });
    task.assertComplete();
  } finally {
    await task?.close();
    await intro.close();
  }
});

test("Java publishes a structured Plan and Step into one Web execution", async ({ page }) => {
  test.skip(process.env.AGENT_RUNTIME !== "agentscope", "Run with --runtime=agentscope");
  const intro = await startModelEmulator({
    apiKey: "web-structured-fixture-key",
    steps: [{ expect() {}, response: { type: "text", text: "Ready to work." } }],
  });
  let task: Awaited<ReturnType<typeof startModelEmulator>> | undefined;
  try {
    await signup(
      page,
      `java-structured-${Date.now()}@rakazo.test`,
      "password12",
      "Java Structured",
    );
    await page.waitForURL(/\/(onboarding|app)/);
    await rpc(page, "models/connect", {
      provider: intro.model.provider,
      modelId: intro.model.id,
      baseUrl: intro.baseUrl,
      apiKey: "web-structured-fixture-key",
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

    task = await startModelEmulator({
      apiKey: "web-structured-fixture-key",
      steps: [
        {
          expect(request) {
            expect(request.tools?.some((tool) => tool.function.name === "publish_run_plan")).toBe(
              true,
            );
          },
          response: {
            type: "tool",
            id: "plan-create",
            name: "publish_run_plan",
            arguments: {
              expectedRevision: 0,
              goal: "Complete the structured fixture",
              items: [{ id: "inspect", title: "Inspect fixture", status: "active" }],
            },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("plan-create");
          },
          response: {
            type: "tool",
            id: "step-create",
            name: "publish_run_step",
            arguments: {
              stepId: "inspect-step",
              expectedRevision: 0,
              order: 0,
              title: "Inspect fixture",
              status: "running",
              planItemId: "inspect",
            },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("step-create");
          },
          response: {
            type: "tool",
            id: "step-complete",
            name: "publish_run_step",
            arguments: {
              stepId: "inspect-step",
              expectedRevision: 1,
              order: 0,
              title: "Inspect fixture",
              status: "completed",
              planItemId: "inspect",
              resultSummary: "Fixture inspected",
            },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("step-complete");
          },
          response: {
            type: "tool",
            id: "plan-complete",
            name: "publish_run_plan",
            arguments: {
              expectedRevision: 1,
              goal: "Complete the structured fixture",
              changeReason: "Inspection finished",
              items: [{ id: "inspect", title: "Inspect fixture", status: "completed" }],
            },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("plan-complete");
          },
          response: { type: "text", text: "Structured fixture completed." },
        },
      ],
    });
    await rpc(page, "models/connect", {
      provider: task.model.provider,
      modelId: task.model.id,
      baseUrl: task.baseUrl,
      apiKey: "web-structured-fixture-key",
    });
    await rpc(page, "bots/update", {
      botId,
      modelProvider: task.model.provider,
      modelId: task.model.id,
    });
    await page.getByPlaceholder(/Message/).fill("Complete the structured fixture.");
    await page.keyboard.press("Enter");
    await expect(
      page.getByTestId("transcript").getByText("Structured fixture completed."),
    ).toBeVisible({ timeout: 40_000 });
    const snapshot = await rpc<{
      plans?: Array<{ runId: string; revision: number; items: Array<{ status: string }> }>;
      steps?: Array<{ runId: string; stepId: string; status: string }>;
      recentRuns?: Array<{ id: string; status: string }>;
    }>(page, "threads/get", { botId });
    const plan = snapshot.plans?.find((row) => row.revision === 2);
    expect(plan?.items[0]?.status).toBe("completed");
    expect(snapshot.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: plan?.runId,
          stepId: "inspect-step",
          status: "completed",
        }),
      ]),
    );
    expect(snapshot.recentRuns).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: plan?.runId, status: "completed" })]),
    );
    // Located by card title: the transcript DOM carries no Run ids.
    const shell = page
      .locator('[data-testid="execution-shell"]')
      .filter({ hasText: "Complete the structured fixture." });
    await expect(shell).toHaveCount(1);
    const shellToggle = shell.locator("button[aria-expanded]").first();
    await shellToggle.click();
    await expect(shell.locator('[data-slot="plan"]')).toBeVisible();
    // UX-01B §3: with a Plan present, a Step whose planItemId matches a Plan
    // item lives in level 2 UNDER that item — not as a second flat steps list.
    // Opening the item's Details reveals the semantic Step and its result.
    const inspectItem = shell.locator('[data-plan-item-id="inspect"]');
    await expect(shell.locator('[data-slot="steps"]')).toHaveCount(0);
    await inspectItem.getByRole("button", { name: "Details", exact: true }).click();
    await expect(shell.locator('[data-step-id="inspect-step"]')).toBeVisible();
    await expect(shell.getByText("Fixture inspected")).toBeVisible();
    await shellToggle.focus();
    await page.keyboard.press("Enter");
    await expect(shellToggle).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(shellToggle).toHaveAttribute("aria-expanded", "true");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(shell.locator('[data-slot="plan"]')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    task.assertComplete();
  } finally {
    await task?.close();
    await intro.close();
  }
});

// AG-02/AG-06: background helper spawns are part of the suspended native
// delegation. The Web contract now: the spawn tool is never offered, an
// attempted background spawn registers no BackgroundAgentTask, no delivery
// run follows, and the run completes in-turn. Delivery of an ALREADY-started
// background task stays covered in-JVM (DelegationSuspensionTest /
// RuntimeIntegrationTest through the delegation seam).
test("Web chat refuses background helper spawns while delegation is suspended", async ({
  page,
}) => {
  test.skip(process.env.AGENT_RUNTIME !== "agentscope", "Run with --runtime=agentscope");
  test.setTimeout(150_000);
  const db = createDb(process.env.DATABASE_URL!);
  const intro = await startModelEmulator({
    apiKey: "web-background-fixture-key",
    steps: [{ expect() {}, response: { type: "text", text: "Ready for background work." } }],
  });
  let task: Awaited<ReturnType<typeof startModelEmulator>> | undefined;
  try {
    await signup(
      page,
      `java-background-${Date.now()}@rakazo.test`,
      "password12",
      "Java Background",
    );
    await page.waitForURL(/\/(onboarding|app)/);
    await rpc(page, "models/connect", {
      provider: intro.model.provider,
      modelId: intro.model.id,
      baseUrl: intro.baseUrl,
      apiKey: "web-background-fixture-key",
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

    task = await startModelEmulator({
      apiKey: "web-background-fixture-key",
      steps: [
        {
          expect(request) {
            expect(request.tools?.some((tool) => tool.function.name === "agent_spawn")).toBe(false);
            for (const native of [
              "agent_send",
              "agent_list",
              "task_output",
              "task_cancel",
              "task_list",
            ]) {
              expect(request.tools?.some((tool) => tool.function.name === native)).toBe(false);
            }
          },
          response: {
            type: "tool",
            id: "background-spawn",
            name: "agent_spawn",
            arguments: { agent_id: "helper", task: "BACKGROUND_CASE", timeout_seconds: 0 },
          },
        },
        {
          expect(request) {
            // The refused spawn never constructed a helper session.
            expect(JSON.stringify(request.messages)).not.toContain("You are a helper");
          },
          response: {
            type: "text",
            text: "Background delegation is unavailable; nothing was started.",
          },
        },
      ],
    });
    await rpc(page, "models/connect", {
      provider: task.model.provider,
      modelId: task.model.id,
      baseUrl: task.baseUrl,
      apiKey: "web-background-fixture-key",
    });
    await rpc(page, "bots/update", {
      botId,
      modelProvider: task.model.provider,
      modelId: task.model.id,
    });
    await page
      .getByPlaceholder(/Message/)
      .fill("Start a background helper and tell me when it starts.");
    await page.keyboard.press("Enter");
    await expect(
      page
        .getByTestId("transcript")
        .getByText("Background delegation is unavailable; nothing was started."),
    ).toBeVisible({ timeout: 40_000 });

    // The refused spawn left no background task behind and no delivery run followed.
    const runs = await db.prisma.run.findMany({ where: { botId }, select: { id: true } });
    expect(
      await db.prisma.backgroundAgentTask.count({
        where: { parentRunId: { in: runs.map((run) => run.id) } },
      }),
    ).toBe(0);
    const thread = await rpc<{ recentRuns?: Array<{ trigger: string; status: string }> }>(
      page,
      "threads/get",
      { botId },
    );
    expect(thread.recentRuns?.filter((run) => run.trigger === "delivery") ?? []).toEqual([]);
    task.assertComplete();
  } finally {
    await task?.close();
    await intro.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
});
