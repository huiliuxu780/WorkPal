import { expect, type Page, test } from "@playwright/test";
import { createDb } from "../../../packages/db/src/index.js";
import { startModelEmulator } from "../../../packages/testkit/src/model-emulator.js";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

type Emulator = Awaited<ReturnType<typeof startModelEmulator>>;
type Db = ReturnType<typeof createDb>;

/**
 * Capability Rules acceptance at the real production boundary: Web → API →
 * Java AgentScope → Tool Bridge → executor `evaluateBotToolCapability`. The
 * model is the offline emulator, but the tool request travels the real bridge
 * and the deny decision happens at the same place as action approval.
 */

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

async function currentRunId(page: Page, db: Db, botId: string) {
  const thread = await db.prisma.thread.findUniqueOrThrow({ where: { botId } });
  const run = await db.prisma.run.findFirstOrThrow({
    where: { threadId: thread.id, trigger: "user" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return run.id;
}

test("deny and malformed capability rules block the real tool boundary without approval", async ({
  page,
}) => {
  test.skip(process.env.AGENT_RUNTIME !== "agentscope", "Run with --runtime=agentscope");
  test.setTimeout(240_000);
  const apiKey = "web-capability-deny-key";
  const db = createDb(process.env.DATABASE_URL!);
  let intro: Emulator | undefined;
  let task: Emulator | undefined;
  try {
    const setup = await setupChatBot(page, apiKey, "Ready for the capability test.", "Java Capability");
    intro = setup.intro;
    const { botId } = setup;

    // A legitimate persisted deny rule for this Bot; there is no rule editor,
    // the policy column is the production source the executor re-reads live.
    await db.prisma.bot.update({
      where: { id: botId },
      data: {
        capabilityRules: [
          { capability: "write_file", resource: "**", scope: "bot", effect: "deny" },
        ],
      },
    });

    task = await startModelEmulator({
      apiKey,
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Write the capability fixture file.");
            expect(request.tools?.some((tool) => tool.function.name === "write_file")).toBe(true);
          },
          response: {
            type: "tool",
            id: "denied-write",
            name: "write_file",
            arguments: { path: "notes/capability-fixture.txt", content: "should never land" },
          },
        },
        {
          expect(request) {
            // The executor returned the refusal to the model as the tool result.
            const transcript = JSON.stringify(request.messages);
            expect(transcript).toContain("denied-write");
            expect(transcript).toContain("Capability rule denied write_file.");
          },
          response: {
            type: "text",
            text: "The write_file call was denied by a capability rule; nothing was written.",
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain(
              "Write the capability fixture file again.",
            );
          },
          response: {
            type: "tool",
            id: "malformed-write",
            name: "write_file",
            arguments: { path: "notes/capability-fixture.txt", content: "should never land" },
          },
        },
        {
          expect(request) {
            const transcript = JSON.stringify(request.messages);
            expect(transcript).toContain("malformed-write");
            // A malformed persisted policy fails closed instead of allowing.
            expect(transcript).toContain("Bot capability rules are invalid");
          },
          response: {
            type: "text",
            text: "The capability policy is malformed, so the write stayed blocked.",
          },
        },
      ],
    });
    await switchToTaskModel(page, botId, apiKey, task);

    await page.getByPlaceholder(/Message/).fill("Write the capability fixture file.");
    await page.keyboard.press("Enter");
    await expect(
      page
        .getByTestId("transcript")
        .getByText("The write_file call was denied by a capability rule; nothing was written."),
    ).toBeVisible({ timeout: 60_000 });

    const deniedRunId = await currentRunId(page, db, botId);
    // The tool implementation never ran: no file, no committed effect, no approval.
    await expect(
      rpc(page, "computer/readFile", { botId, path: "notes/capability-fixture.txt" }),
    ).rejects.toThrow(/computer\/readFile/);
    expect(await db.prisma.externalEffect.count({ where: { runId: deniedRunId } })).toBe(0);
    expect(await db.prisma.intervention.count({ where: { runId: deniedRunId } })).toBe(0);
    expect(
      await db.prisma.event.count({ where: { runId: deniedRunId, type: "approval.requested" } }),
    ).toBe(0);
    // The refusal itself is not a Run failure; the turn completed honestly.
    expect(await db.prisma.run.findUnique({ where: { id: deniedRunId }, select: { status: true } }))
      .toMatchObject({ status: "completed" });

    // Corrupt the persisted policy: the same call must fail closed, not allow.
    await db.prisma.bot.update({
      where: { id: botId },
      data: {
        capabilityRules: [
          { capability: "write_file", resource: "**", scope: "bot", effect: "permit" },
        ],
      },
    });
    await page.getByPlaceholder(/Message/).fill("Write the capability fixture file again.");
    await page.keyboard.press("Enter");
    await expect(
      page
        .getByTestId("transcript")
        .getByText("The capability policy is malformed, so the write stayed blocked."),
    ).toBeVisible({ timeout: 60_000 });

    const malformedRunId = await currentRunId(page, db, botId);
    expect(malformedRunId).not.toBe(deniedRunId);
    await expect(
      rpc(page, "computer/readFile", { botId, path: "notes/capability-fixture.txt" }),
    ).rejects.toThrow(/computer\/readFile/);
    expect(await db.prisma.externalEffect.count({ where: { runId: malformedRunId } })).toBe(0);
    expect(await db.prisma.intervention.count({ where: { runId: malformedRunId } })).toBe(0);
    expect(
      await db.prisma.run.findUnique({ where: { id: malformedRunId }, select: { status: true } }),
    ).toMatchObject({ status: "completed" });
    task.assertComplete();
  } finally {
    await task?.close();
    await intro?.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
});

test("an approved tool replay is still blocked when the rule changed to deny", async ({
  page,
}) => {
  test.skip(process.env.AGENT_RUNTIME !== "agentscope", "Run with --runtime=agentscope");
  test.setTimeout(240_000);
  const apiKey = "web-capability-replay-key";
  const db = createDb(process.env.DATABASE_URL!);
  let intro: Emulator | undefined;
  let task: Emulator | undefined;
  try {
    const setup = await setupChatBot(page, apiKey, "Ready for the replay test.", "Java Capability Replay");
    intro = setup.intro;
    const { botId } = setup;

    // ask routes through the existing Intervention/Approval path.
    await db.prisma.bot.update({
      where: { id: botId },
      data: {
        capabilityRules: [
          { capability: "write_file", resource: "**", scope: "bot", effect: "ask" },
        ],
      },
    });

    task = await startModelEmulator({
      apiKey,
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Write the approval fixture file.");
            expect(request.tools?.some((tool) => tool.function.name === "write_file")).toBe(true);
          },
          response: {
            type: "tool",
            id: "asked-write",
            name: "write_file",
            arguments: { path: "notes/approval-fixture.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            // After approval the executor re-read the policy, found deny and
            // refused the replayed call; the model sees the refusal, not a write.
            const transcript = JSON.stringify(request.messages);
            expect(transcript).toContain("asked-write");
            expect(transcript).toContain("Capability rule denied write_file.");
          },
          response: {
            type: "text",
            text: "Approval was granted but the rule changed to deny; nothing was written.",
          },
        },
      ],
    });
    await switchToTaskModel(page, botId, apiKey, task);

    await page.getByPlaceholder(/Message/).fill("Write the approval fixture file.");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const runId = await currentRunId(page, db, botId);
    expect(await db.prisma.intervention.count({ where: { runId } })).toBe(1);

    // The rule flips to deny before the approved request replays.
    await db.prisma.bot.update({
      where: { id: botId },
      data: {
        capabilityRules: [
          { capability: "write_file", resource: "**", scope: "bot", effect: "deny" },
        ],
      },
    });
    await page.getByRole("button", { name: "Allow once", exact: true }).click();

    await expect(
      page
        .getByTestId("transcript")
        .getByText("Approval was granted but the rule changed to deny; nothing was written."),
    ).toBeVisible({ timeout: 60_000 });

    await expect(
      rpc(page, "computer/readFile", { botId, path: "notes/approval-fixture.txt" }),
    ).rejects.toThrow(/computer\/readFile/);
    // The approval was recorded and granted, but the effect never executed.
    const effects = await db.prisma.externalEffect.findMany({ where: { runId } });
    expect(effects).toHaveLength(1);
    expect(effects[0]!.status).toBe("approved");
    expect(effects[0]!.result).toBeNull();
    expect(await db.prisma.run.findUnique({ where: { id: runId }, select: { status: true } }))
      .toMatchObject({ status: "completed" });
    task.assertComplete();
  } finally {
    await task?.close();
    await intro?.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
});
