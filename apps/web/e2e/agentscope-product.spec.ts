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
