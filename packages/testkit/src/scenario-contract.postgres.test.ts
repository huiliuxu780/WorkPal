import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, FakeSandboxProvider, NO_RESPONSE } from "@rakazo/adapters";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BOT_INTRO_PROMPT } from "../../../apps/api/src/router.ts";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { type ModelEmulatorStep, startModelEmulator } from "./model-emulator.js";

// ---------------------------------------------------------------------------
// AG-03 production-chain layer: full app (real executor, real worker path),
// real Java runtime (AGENTSCOPE_URL from the harness), real PostgreSQL and the
// local model emulator. Final model requests are captured at the emulator
// boundary; outcomes are verified in the database and on the sandbox/provider
// side effects. Case IDs reference
// packages/adapters/src/__fixtures__/scenarios/case-registry.ts.
// ---------------------------------------------------------------------------

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";
const fixtureKey = "scenario-contract-fixture-key";

describe.skipIf(!databaseAvailable)("AG-03 scenario contracts on the production chain", () => {
  let handles: Awaited<ReturnType<typeof createHandles>>;
  let composio: ComposioEmulator;
  let sandbox: FakeSandboxProvider;
  let actSpy: ReturnType<typeof vi.spyOn>;
  let dataDir: string;

  async function createHandles() {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    return createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: fixtureOrigin,
      webOrigin: fixtureOrigin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "agentscope",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio,
      encryptionKey: "scenario-contract-encryption-key",
    });
  }

  beforeAll(async () => {
    // Compatible-endpoint capability declaration so the real executor exposes
    // computer tools without mocking its model vision gate.
    vi.stubEnv("RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS", "offline-fixture");
    composio = new ComposioEmulator();
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-scenario-contract-"));
    handles = await createHandles();
    expect(handles.sandbox).toBeInstanceOf(FakeSandboxProvider);
    sandbox = handles.sandbox as FakeSandboxProvider;
    actSpy = vi.spyOn(sandbox, "act");
  }, 120_000);

  afterAll(async () => {
    try {
      await handles?.stop();
    } finally {
      vi.unstubAllEnvs();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  async function rpc<T>(
    cookie: string,
    procedure: string,
    input: unknown = {},
    options: { expectError?: boolean } = {},
  ): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
      body: JSON.stringify({ json: input }),
    });
    const body = (await response.json()) as { json?: T; error?: { message?: string } };
    if (!options.expectError && (response.status >= 400 || body.error))
      throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
    return body.json as T;
  }

  async function signup(label: string): Promise<string> {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: fixtureOrigin },
      body: JSON.stringify({
        email: `scenario-${label}-${randomUUID()}@rakazo.test`,
        password: "password12",
        name: `Scenario ${label}`,
      }),
    });
    expect(response.status, "signup failed").toBeLessThan(400);
    return sessionCookieHeader(response);
  }

  async function connectModel(cookie: string, model: { model: { provider: string; id: string }; baseUrl: string }) {
    await rpc(cookie, "models/connect", {
      provider: model.model.provider,
      modelId: model.model.id,
      baseUrl: model.baseUrl,
      apiKey: fixtureKey,
    });
  }

  async function createBot(
    cookie: string,
    model: { model: { provider: string; id: string } },
    name: string,
    instructions = "Complete the scenario task.",
  ) {
    const bot = await rpc<{ id: string }>(cookie, "bots/create", {
      name,
      title: "",
      description: "",
      instructions,
      notifyOnFinish: false,
    });
    await discardBotIntroRun(handles, cookie, bot.id);
    await rpc(cookie, "bots/update", {
      botId: bot.id,
      modelProvider: model.model.provider,
      modelId: model.model.id,
    });
    return bot;
  }

  async function waitForRun(runId: string, status: string, timeout = 45_000) {
    await expect
      .poll(
        async () => {
          const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: runId } });
          return run.status;
        },
        { timeout, interval: 100 },
      )
      .toBe(status);
  }

  const toolNamesOf = (request: { tools?: Array<{ function?: { name?: string } }> }) =>
    (request.tools ?? []).map((tool) => tool.function?.name ?? "<unknown>");

  // --- S01-C6: complete lawful tool execution through the production chain ----
  it(
    "S01-C6 production tool execution",
    async () => {
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              const names = toolNamesOf(request);
              // Backend tools and Java plan natives reach the model…
              expect(names).toContain("write_file");
              expect(names).toContain("shell");
              expect(names).toContain("plan_enter");
              expect(names).toContain("plan_write");
              expect(names).toContain("plan_exit");
              // …while suspended helper surfaces never do (AG-02), even though
              // the TS selection still offers run_subagent.
              expect(names).not.toContain("run_subagent");
              for (const subagent of ["agent_spawn", "agent_send", "agent_list", "task_output", "task_cancel", "task_list"]) {
                expect(names).not.toContain(subagent);
              }
            },
            response: {
              type: "tool",
              id: "scenario-write",
              name: "write_file",
              arguments: { path: "notes/scenario-contract.txt", content: "AG-03 was here" },
            },
          },
          {
            expect(request) {
              const result = request.messages.findLast((message) => message.role === "tool");
              expect(result?.tool_call_id).toBe("scenario-write");
              expect(JSON.parse(String(result?.content))).toMatchObject({
                ok: true,
                path: "notes/scenario-contract.txt",
              });
            },
            response: {
              type: "tool",
              id: "scenario-shell",
              name: "shell",
              arguments: { command: "wc -c notes/scenario-contract.txt" },
            },
          },
          {
            expect(request) {
              const result = request.messages.findLast((message) => message.role === "tool");
              expect(result?.tool_call_id).toBe("scenario-shell");
            },
            response: { type: "text", text: "Scenario file saved and verified." },
          },
        ],
      });
      try {
        const cookie = await signup("s01c6");
        await connectModel(cookie, model);
        const bot = await createBot(cookie, model, "Execution fixture");
        const sent = await rpc<{ runId: string }>(cookie, "threads/send", {
          botId: bot.id,
          text: "Save AG-03 was here to notes/scenario-contract.txt and verify its size.",
        });
        await waitForRun(sent.runId, "completed");
        model.assertComplete();
        const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
        expect(run.trigger).toBe("user");
        const finalMessage = await handles.prisma.message.findFirstOrThrow({
          where: { runId: sent.runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(JSON.stringify(finalMessage.blocks)).toContain("Scenario file saved and verified.");
      } finally {
        await model.close();
      }
    },
    120_000,
  );

  // --- S03-C2: creation intro can only speak ----------------------------------
  it(
    "S03-C2 intro run has no tool surface",
    async () => {
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              // Zero backend tools (executor override for created/delivery).
              // Captured fact: production intro requests carry the default
              // skill set, so the chat-scope skill loader is the only native.
              expect(toolNamesOf(request)).toEqual(["load_skill_through_path"]);
              const fullText = JSON.stringify(request.messages);
              expect(fullText).toContain("You were just created.");
              expect(fullText).toContain(BOT_INTRO_PROMPT.slice(0, 40));
            },
            response: { type: "text", text: "I understand my role and I am ready." },
          },
        ],
      });
      try {
        const cookie = await signup("s03c2");
        await connectModel(cookie, model);
        // No discardBotIntroRun here: the intro Run is the subject of this case.
        const bot = await rpc<{ id: string }>(cookie, "bots/create", {
          name: "Intro fixture",
          title: "Fresh bot",
          description: "Introduced by AG-03",
          instructions: "Introduce yourself precisely.",
          notifyOnFinish: false,
        });
        const introRun = await vi
          .waitFor(
            async () => {
              const run = await handles.prisma.run.findFirstOrThrow({
                where: { botId: bot.id, trigger: "created" },
              });
              return run;
            },
            { timeout: 20_000, interval: 100 },
          );
        await waitForRun(introRun.id, "completed");
        model.assertComplete();
        expect(model.requests).toHaveLength(1);
        expect(actSpy).not.toHaveBeenCalled();
        const introMessage = await handles.prisma.message.findFirstOrThrow({
          where: { runId: introRun.id, role: "bot" },
        });
        expect(JSON.stringify(introMessage.blocks)).toContain("I understand my role");
      } finally {
        await model.close();
      }
    },
    120_000,
  );

  // --- S04-C2: routine result branch -------------------------------------------
  it(
    "S04-C2 routine result branch",
    async () => {
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              const names = toolNamesOf(request);
              expect(names).not.toContain("schedule_create");
              expect(names).not.toContain("plan_enter");
              expect(names).not.toContain("plan_write");
              expect(names).not.toContain("plan_exit");
              const system = String(request.messages[0]?.content ?? "");
              expect(system).toContain("the entire final assistant reply must be exactly NO_RESPONSE");
              expect(system).toContain("Planning: disabled for this turn.");
            },
            response: { type: "text", text: "Digest: all systems nominal." },
          },
        ],
      });
      try {
        const cookie = await signup("s04c2");
        await connectModel(cookie, model);
        const bot = await createBot(cookie, model, "Routine fixture");
        const routine = await rpc<{ id: string }>(cookie, "routines/create", {
          botId: bot.id,
          name: "Scenario digest",
          prompt: "ROUTINE_SCENARIO_FIXTURE: report the digest.",
          crons: ["0 0 1 1 *"],
          timezone: "UTC",
          active: false,
        });
        const { runId } = await rpc<{ runId: string }>(cookie, "routines/testRun", {
          routineId: routine.id,
          clientNonce: `scenario-routine-${Date.now()}`,
        });
        await waitForRun(runId, "completed");
        model.assertComplete();
        const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: runId } });
        expect(run.trigger).toBe("routine");
        const message = await handles.prisma.message.findFirstOrThrow({
          where: { runId, role: "bot" },
        });
        expect(JSON.stringify(message.blocks)).toContain("Digest: all systems nominal.");
      } finally {
        await model.close();
      }
    },
    120_000,
  );

  // --- S04-C3: routine silent branch ----------------------------------------------
  it(
    "S04-C3 routine silent branch",
    async () => {
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              const system = String(request.messages[0]?.content ?? "");
              expect(system).toContain("the entire final assistant reply must be exactly NO_RESPONSE");
            },
            response: { type: "text", text: NO_RESPONSE },
          },
        ],
      });
      try {
        const cookie = await signup("s04c3");
        await connectModel(cookie, model);
        const bot = await createBot(cookie, model, "Silent routine fixture");
        const routine = await rpc<{ id: string }>(cookie, "routines/create", {
          botId: bot.id,
          name: "Scenario silent digest",
          prompt: "ROUTINE_SCENARIO_FIXTURE: stay silent when there is nothing to report.",
          crons: ["0 0 1 1 *"],
          timezone: "UTC",
          active: false,
        });
        const { runId } = await rpc<{ runId: string }>(cookie, "routines/testRun", {
          routineId: routine.id,
          clientNonce: `scenario-silent-${Date.now()}`,
        });
        await waitForRun(runId, "completed");
        model.assertComplete();
        // The exact NO_RESPONSE sentinel finishes the Run with no chat bubble.
        const bubbles = await handles.prisma.message.count({ where: { runId, role: "bot" } });
        expect(bubbles).toBe(0);
      } finally {
        await model.close();
      }
    },
    120_000,
  );

  // --- S09-C1/C4 and S09-C2: approval allow/deny on the same Run ---------------------
  it.each(["allow", "deny"] as const)(
    "S09-C1/C2 approval %s resumes the same run with the persisted effect",
    async (answer) => {
      actSpy.mockClear();
      const approvedArgs = {
        actions: [{ kind: "type", text: "scenario contract clipboard" }],
        observe: false,
        settle_ms: 0,
      };
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              expect(toolNamesOf(request)).toContain("computer_act");
            },
            response: {
              type: "tool",
              id: "scenario-pending-action",
              name: "computer_act",
              arguments: approvedArgs,
            },
          },
          {
            expect(request) {
              const result = request.messages.findLast((message) => message.role === "tool");
              expect(result?.tool_call_id).toBe("scenario-pending-action");
              const body = JSON.parse(String(result?.content));
              if (answer === "allow") expect(body).toMatchObject({ ok: true, completed: 1 });
              else expect(JSON.stringify(body)).toMatch(/denied/i);
            },
            response: { type: "text", text: "Approval fixture finished." },
          },
        ],
      });
      try {
        const cookie = await signup(`s09-${answer}`);
        await connectModel(cookie, model);
        const bot = await createBot(cookie, model, "Approval fixture");
        const storedBot = await handles.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
        await handles.prisma.actionApprovalRule.create({
          data: {
            spaceId: storedBot.spaceId,
            createdByUserId: storedBot.userId,
            effect: "require_approval",
            matchKind: "tool",
            matchValue: "computer_act",
          },
        });
        const sent = await rpc<{ runId: string }>(cookie, "threads/send", {
          botId: bot.id,
          text: "Put scenario contract clipboard on the computer clipboard.",
        });
        await waitForRun(sent.runId, "waiting_input");
        const effects = await handles.prisma.externalEffect.findMany({ where: { runId: sent.runId } });
        expect(effects).toHaveLength(1);
        expect(effects[0]).toMatchObject({ kind: "computer_act", status: "intended", request: approvedArgs });
        expect(actSpy).not.toHaveBeenCalled();
        const card = await handles.prisma.message.findFirstOrThrow({
          where: { runId: sent.runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        await rpc(cookie, "threads/answer", {
          botId: bot.id,
          runId: sent.runId,
          messageId: card.id,
          answer,
        });
        await waitForRun(sent.runId, "completed");
        model.assertComplete();
        // Same Run resumed: the recovery is not a new Run and not a new trigger
        // (S09-C4 — "resume" never appears on a created Run row).
        const resumed = await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
        expect(resumed.trigger).toBe("user");
        expect(actSpy).toHaveBeenCalledTimes(answer === "allow" ? 1 : 0);
        const settled = await handles.prisma.externalEffect.findMany({ where: { runId: sent.runId } });
        expect(settled).toHaveLength(1);
        expect(settled[0]).toMatchObject({
          id: effects[0]!.id,
          status: answer === "allow" ? "completed" : "denied",
        });
      } finally {
        await model.close();
      }
    },
    120_000,
  );

  // --- S09-C3: connector revocation between approval and resume ----------------------
  it(
    "S09-C3 permission change before resume",
    async () => {
      // Recorded current behavior (AG-03 findings, pinned not masked):
      // Finding A — when the connector is revoked between the approval record
      //   and the resume, the Java runtime replays the pending tool call from
      //   session state, its bridge allow-list check ("Tool is not allowed for
      //   this run") rejects it, and the Run FAILS with the effect left
      //   "approved". The security contract holds: zero provider executions.
      //   The denial does not surface to the model as a tool-error result.
      // Finding B — the failed resume leaves the dangling tool call in the
      //   persisted Java session; the NEXT chat run on the same thread reuses
      //   that session, hits the same bridge refusal in resumeTools and fails
      //   without ever consulting the model (thread wedged until a generation
      //   change). Both are product-gap candidates recorded in
      //   docs/ag03-scenario-contracts.md; a fix should flip these expectations.
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              expect(toolNamesOf(request)).toContain("GMAIL_SEND_EMAIL");
            },
            response: {
              type: "tool",
              id: "scenario-mail",
              name: "GMAIL_SEND_EMAIL",
              arguments: {
                recipient_email: "peer@example.test",
                subject: "Scenario greeting",
                body: "Hello from the scenario contract.",
              },
            },
          },
          // Step for the poisoned follow-up run: provided so that a future fix
          // (session cleanup) makes the run COMPLETE and this test fail loudly
          // instead of passing for the wrong reason.
          {
            expect(request) {
              expect(toolNamesOf(request)).not.toContain("GMAIL_SEND_EMAIL");
            },
            response: { type: "text", text: "No mail tools are available now." },
          },
        ],
      });
      try {
        const cookie = await signup("s09c3");
        await connectModel(cookie, model);
        const bot = await createBot(cookie, model, "Connector fixture");
        const connection = await rpc<{ connectionId: string }>(cookie, "connections/begin", {
          connectorId: "composio",
          provider: "GMAIL",
          displayName: "Scenario Gmail",
        });
        const actor = await rpc<{ userId: string }>(cookie, "me");
        const storedBot = await handles.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
        await handles.prisma.actionApprovalRule.create({
          data: {
            spaceId: storedBot.spaceId,
            createdByUserId: storedBot.userId,
            effect: "require_approval",
            matchKind: "tool",
            matchValue: "GMAIL_SEND_EMAIL",
          },
        });
        const sent = await rpc<{ runId: string }>(cookie, "threads/send", {
          botId: bot.id,
          text: "Send a greeting email to peer@example.test with subject Scenario greeting.",
        });
        await waitForRun(sent.runId, "waiting_input");
        // The tool was genuinely available before the change (S13: prove usable first).
        expect(composio.executions.filter((entry) => entry.userId === actor.userId)).toEqual([]);
        const effects = await handles.prisma.externalEffect.findMany({ where: { runId: sent.runId } });
        expect(effects).toHaveLength(1);
        expect(effects[0]).toMatchObject({ kind: "GMAIL_SEND_EMAIL", status: "intended" });
        const card = await handles.prisma.message.findFirstOrThrow({
          where: { runId: sent.runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        // Permission/connection change BEFORE the resume decision.
        await rpc(cookie, "connections/revoke", { connectionId: connection.connectionId });
        await rpc(cookie, "threads/answer", {
          botId: bot.id,
          runId: sent.runId,
          messageId: card.id,
          answer: "allow",
        });
        // Finding A: the revoked replay fails the Run at the runtime boundary.
        await waitForRun(sent.runId, "failed");
        expect(composio.executions.filter((entry) => entry.userId === actor.userId)).toEqual([]);
        const settled = await handles.prisma.externalEffect.findMany({ where: { runId: sent.runId } });
        expect(settled).toHaveLength(1);
        expect(settled[0]!.status).not.toBe("completed");
        expect(settled[0]!.status).toBe("approved");
        expect(model.requests).toHaveLength(1);
        // Finding B: the same thread's next run fails without a model call.
        const poisoned = await rpc<{ runId: string }>(cookie, "threads/send", {
          botId: bot.id,
          text: "Do you still have mail tools?",
        });
        await waitForRun(poisoned.runId, "failed");
        expect(model.requests).toHaveLength(1);
        expect(composio.executions.filter((entry) => entry.userId === actor.userId)).toEqual([]);
      } finally {
        await model.close();
      }
    },
    180_000,
  );

  // --- S13-C2: revoked connector tools disappear from a clean next run ---------------
  it(
    "S13-C2 revoked connector tool disappears from the next clean run",
    async () => {
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              // Prove the tool is genuinely offered while connected.
              expect(toolNamesOf(request)).toContain("GMAIL_SEND_EMAIL");
            },
            response: { type: "text", text: "Mail tools are available." },
          },
          {
            expect(request) {
              // After revocation the same bot's next run no longer sees it.
              expect(toolNamesOf(request)).not.toContain("GMAIL_SEND_EMAIL");
              expect(toolNamesOf(request).filter((name) => name.startsWith("GMAIL_"))).toEqual([]);
            },
            response: { type: "text", text: "No mail tools are available now." },
          },
        ],
      });
      try {
        const cookie = await signup("s13c2");
        await connectModel(cookie, model);
        const bot = await createBot(cookie, model, "Connector visibility fixture");
        const connection = await rpc<{ connectionId: string }>(cookie, "connections/begin", {
          connectorId: "composio",
          provider: "GMAIL",
          displayName: "Visibility Gmail",
        });
        const actor = await rpc<{ userId: string }>(cookie, "me");
        const first = await rpc<{ runId: string }>(cookie, "threads/send", {
          botId: bot.id,
          text: "List what mail tools you have.",
        });
        await waitForRun(first.runId, "completed");
        await rpc(cookie, "connections/revoke", { connectionId: connection.connectionId });
        const second = await rpc<{ runId: string }>(cookie, "threads/send", {
          botId: bot.id,
          text: "List what mail tools you have now.",
        });
        await waitForRun(second.runId, "completed");
        model.assertComplete();
        expect(composio.executions.filter((entry) => entry.userId === actor.userId)).toEqual([]);
      } finally {
        await model.close();
      }
    },
    180_000,
  );

  // --- S01-C5: reaction entry creates a message and never a Run ----------------------
  it(
    "S01-C5 reaction creates a message and no Run",
    async () => {
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              expect(JSON.stringify(request.messages)).toContain("Say hello.");
            },
            response: { type: "text", text: "Hello! Ready when you are." },
          },
        ],
      });
      try {
        const cookie = await signup("s01c5");
        await connectModel(cookie, model);
        const bot = await createBot(cookie, model, "Reaction fixture");
        const sent = await rpc<{ runId: string }>(cookie, "threads/send", {
          botId: bot.id,
          text: "Say hello.",
        });
        await waitForRun(sent.runId, "completed");
        model.assertComplete();
        const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
        const userMessageId = run.sourceMessageId;
        expect(userMessageId).toBeTruthy();
        const runsBefore = await handles.prisma.run.count({ where: { botId: bot.id } });
        const messagesBefore = await handles.prisma.message.count({
          where: { threadId: run.threadId },
        });
        await rpc(cookie, "threads/react", {
          botId: bot.id,
          messageId: userMessageId,
          reaction: "👍",
          clientNonce: `scenario-react-${randomUUID()}`,
        });
        // The reaction appends exactly one user message and starts no AI turn:
        // "reaction" stays a declared-only trigger with no Run creation path.
        const messagesAfter = await handles.prisma.message.count({ where: { threadId: run.threadId } });
        expect(messagesAfter).toBe(messagesBefore + 1);
        const reactionMessage = await handles.prisma.message.findFirstOrThrow({
          where: { threadId: run.threadId, role: "user", replyToMessageId: userMessageId },
        });
        expect(JSON.stringify(reactionMessage.blocks)).toContain("👍");
        const runsAfter = await handles.prisma.run.count({ where: { botId: bot.id } });
        expect(runsAfter).toBe(runsBefore);
        model.assertComplete();
      } finally {
        await model.close();
      }
    },
    120_000,
  );
});
