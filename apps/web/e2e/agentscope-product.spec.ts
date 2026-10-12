import { expect, test } from "@playwright/test";
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

test("Web chat receives a native Harness subagent result", async ({ page }) => {
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
            expect(request.tools?.some((tool) => tool.function.name === "agent_spawn")).toBe(true);
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
            expect(JSON.stringify(request.messages)).toContain("CHILD_WEB_MARKER");
          },
          response: { type: "text", text: "CHILD_WEB_MARKER" },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("CHILD_WEB_MARKER");
          },
          response: { type: "text", text: "Delegation returned CHILD_WEB_MARKER." },
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
      page.getByTestId("transcript").getByText("Delegation returned CHILD_WEB_MARKER."),
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
    await signup(page, `java-structured-${Date.now()}@rakazo.test`, "password12", "Java Structured");
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
    await expect.poll(async () => {
      const thread = await rpc<{ run?: { status?: string } | null }>(page, "threads/get", { botId });
      return thread.run?.status ?? "completed";
    }, { timeout: 30_000 }).toBe("completed");

    task = await startModelEmulator({
      apiKey: "web-structured-fixture-key",
      steps: [
        {
          expect(request) {
            expect(request.tools?.some((tool) => tool.function.name === "publish_run_plan")).toBe(true);
          },
          response: {
            type: "tool", id: "plan-create", name: "publish_run_plan",
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
            type: "tool", id: "step-create", name: "publish_run_step",
            arguments: {
              stepId: "inspect-step", expectedRevision: 0, order: 0,
              title: "Inspect fixture", status: "running", planItemId: "inspect",
            },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("step-create");
          },
          response: {
            type: "tool", id: "step-complete", name: "publish_run_step",
            arguments: {
              stepId: "inspect-step", expectedRevision: 1, order: 0,
              title: "Inspect fixture", status: "completed", planItemId: "inspect",
              resultSummary: "Fixture inspected",
            },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("step-complete");
          },
          response: {
            type: "tool", id: "plan-complete", name: "publish_run_plan",
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
    await expect(page.getByTestId("transcript").getByText("Structured fixture completed.")).toBeVisible({ timeout: 40_000 });
    const snapshot = await rpc<{
      plans?: Array<{ runId: string; revision: number; items: Array<{ status: string }> }>;
      steps?: Array<{ runId: string; stepId: string; status: string }>;
      recentRuns?: Array<{ id: string; status: string }>;
    }>(page, "threads/get", { botId });
    const plan = snapshot.plans?.find((row) => row.revision === 2);
    expect(plan?.items[0]?.status).toBe("completed");
    expect(snapshot.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: plan?.runId, stepId: "inspect-step", status: "completed" }),
    ]));
    expect(snapshot.recentRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: plan?.runId, status: "completed" }),
    ]));
    const shell = page.locator(`[data-testid="execution-shell"][data-run-id="${plan?.runId}"]`);
    await expect(shell).toHaveCount(1);
    const shellToggle = shell.locator(":scope > button");
    await shellToggle.click();
    await expect(shell.locator('[data-slot="plan"]')).toBeVisible();
    await expect(shell.locator('[data-slot="steps"]')).toBeVisible();
    await shellToggle.focus();
    await page.keyboard.press("Enter");
    await expect(shellToggle).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(shellToggle).toHaveAttribute("aria-expanded", "true");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(shell.locator('[data-slot="plan"]')).toBeVisible();
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    )).toBe(true);
    task.assertComplete();
  } finally {
    await task?.close();
    await intro.close();
  }
});

test("Java background result reaches Web without another user message", async ({ page }) => {
  test.skip(process.env.AGENT_RUNTIME !== "agentscope", "Run with --runtime=agentscope");
  test.setTimeout(150_000);
  const intro = await startModelEmulator({
    apiKey: "web-background-fixture-key",
    steps: [{ expect() {}, response: { type: "text", text: "Ready for background work." } }],
  });
  let task: Awaited<ReturnType<typeof startModelEmulator>> | undefined;
  try {
    await signup(page, `java-background-${Date.now()}@rakazo.test`, "password12", "Java Background");
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
    await expect.poll(async () => {
      const thread = await rpc<{ run?: { status?: string } | null }>(page, "threads/get", { botId });
      return thread.run?.status ?? "completed";
    }, { timeout: 30_000 }).toBe("completed");

    const finishBackground = (request: {
      messages: Array<{ role: string; content?: unknown }>;
    }) => {
      const userMessages = request.messages
        .filter((message) => message.role === "user")
        .map((message) => JSON.stringify(message.content));
      if (userMessages.some((content) => content.includes("Write one concise user-facing update"))) {
        return { type: "text" as const, text: "Background delivery arrived: BACKGROUND_CHILD_RESULT." };
      }
      if (userMessages.some((content) => content.includes("BACKGROUND_CASE"))) {
        return { type: "text" as const, text: "BACKGROUND_CHILD_RESULT" };
      }
      if (JSON.stringify(request.messages).includes("task_id:")) {
        return { type: "text" as const, text: "Background task started." };
      }
      throw new Error("Unexpected background model turn");
    };
    task = await startModelEmulator({
      apiKey: "web-background-fixture-key",
      steps: [
        {
          expect(request) {
            expect(request.tools?.some((tool) => tool.function.name === "agent_spawn")).toBe(true);
          },
          response: {
            type: "tool", id: "background-spawn", name: "agent_spawn",
            arguments: { agent_id: "helper", task: "BACKGROUND_CASE", timeout_seconds: 0 },
          },
        },
        ...Array.from({ length: 3 }, () => ({
          expect() {},
          response: finishBackground,
        })),
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
    await page.getByPlaceholder(/Message/).fill("Start a background helper and tell me when it starts.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("transcript").getByText("Background task started.")).toBeVisible({ timeout: 40_000 });
    const beforeDelivery = await rpc<{ messages: Array<{ role: string }> }>(page, "threads/get", { botId });
    await expect(page.getByTestId("transcript").getByText(
      "Background delivery arrived: BACKGROUND_CHILD_RESULT.",
    )).toBeVisible({ timeout: 100_000 });
    const afterDelivery = await rpc<{
      messages: Array<{ role: string }>;
      recentRuns?: Array<{ trigger: string; status: string }>;
    }>(page, "threads/get", { botId });
    expect(afterDelivery.messages.filter((message) => message.role === "user")).toHaveLength(
      beforeDelivery.messages.filter((message) => message.role === "user").length,
    );
    expect(afterDelivery.recentRuns?.filter((run) => run.trigger === "delivery")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    task.assertComplete();
  } finally {
    await task?.close();
    await intro.close();
  }
});
