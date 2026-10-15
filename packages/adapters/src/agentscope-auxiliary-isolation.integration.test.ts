import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRunRequest, AgentRuntimeEvent, AgentTurnPolicy } from "@rakazo/adapter-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentScopeAgentRuntime } from "./agentscope-runtime.js";

// AG-01 acceptance #2/#3 at the real boundary: TS adapter -> Java runtime ->
// local model protocol fixture. Every auxiliary execution scope must reach the
// model with zero callable tools even when the request asks for an auto
// plan/delegation policy, and a mistaken backend tool or skill payload must be
// refused at the trusted Java boundary instead of silently entering the model
// request. The chat control proves the enforcement is scope-based: authorized
// backend tools and native Plan/Skill surfaces stay visible for normal chat.
const serviceDir = fileURLToPath(new URL("../../../services/agent-runtime/", import.meta.url));
const runtimeJar = join(serviceDir, "target/agent-runtime-0.1.0.jar");

const AUXILIARY_SCOPES = [
  "auto-review",
  "history-compaction",
  "turn-routing",
  "team-chat-judge",
] as const;

type FixtureModelRequest = {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name?: string; function?: { name?: string } }>;
};

describe("AgentScope auxiliary execution isolation", () => {
  let child: ChildProcess;
  let stateDir: string;
  let runtime: AgentScopeAgentRuntime;
  let modelUrl: string;
  const modelRequests: FixtureModelRequest[] = [];

  const modelServer = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body) as FixtureModelRequest;
    modelRequests.push(input);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [
      {
        id: "aux-response",
        object: "chat.completion.chunk",
        model: input.model,
        choices: [
          { index: 0, delta: { role: "assistant", content: "AUX_FIXTURE_OK" }, finish_reason: null },
        ],
      },
      {
        id: "aux-response",
        object: "chat.completion.chunk",
        model: input.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "workpal-aux-isolation-"));
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    modelUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const serviceUrl = `http://127.0.0.1:${port}`;
    child = spawn("java", ["-jar", runtimeJar], {
      cwd: serviceDir,
      env: {
        ...process.env,
        AGENT_RUNTIME_HOST: "127.0.0.1",
        AGENT_RUNTIME_PORT: String(port),
        AGENT_RUNTIME_DATA_DIR: stateDir,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let logs = "";
    child.stderr?.on("data", (chunk) => {
      logs += chunk.toString();
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null)
        throw new Error(`Java runtime exited ${child.exitCode}: ${logs}`);
      try {
        ready = (await fetch(`${serviceUrl}/health`)).ok;
      } catch {
        /* starting */
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Java runtime startup timed out: ${logs}`);
    runtime = new AgentScopeAgentRuntime({ baseUrl: serviceUrl });
  });

  afterAll(async () => {
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
    }
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });

  const context = () => ({
    operationId: "aux-isolation",
    traceId: "aux-isolation",
    userId: "user-1",
    spaceId: "space-1",
  });

  // The most permissive policy a mistaken caller could attach: everything auto.
  const permissivePolicy: AgentTurnPolicy = {
    version: "v1",
    interaction: { interactive: true },
    planning: { mode: "auto" },
    delegation: { mode: "auto", background: true, maxChildren: 3, maxDepth: 1 },
    ownership: { mode: "owner", ownerBotId: "bot-1" },
    routing: { kind: "direct" },
  };

  const baseRequest = (runId: string, modelId: string): AgentRunRequest => ({
    botId: "bot-1",
    threadId: runId,
    runId,
    prompt: "AUX_PROMPT_MARKER",
    instructions: "Reply with the requested output only.",
    history: [],
    tools: [],
    turnPolicy: permissivePolicy,
    model: { provider: "openai-compatible", id: modelId, apiKey: "fixture", baseUrl: modelUrl },
  });

  const consume = async (input: AgentRunRequest) => {
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(input, context())) events.push(event);
    return events;
  };

  const visibleToolNames = (modelId: string) =>
    modelRequests
      .filter((request) => request.model === modelId)
      .flatMap((request) =>
        (request.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? "<unknown>"),
      );

  describe.each(AUXILIARY_SCOPES)("%s scope", (scope) => {
    it("reaches the model with zero callable tools despite an auto plan/delegation policy", async () => {
      const modelId = `aux-${scope}-policy`;
      const request = baseRequest(`aux-${scope}-policy-run`, modelId);
      request.executionScope = scope;
      const events = await consume(request);
      expect(events.at(-1)).toEqual({ type: "done", text: "AUX_FIXTURE_OK" });
      const tools = visibleToolNames(modelId);
      expect(modelRequests.filter((entry) => entry.model === modelId).length).toBeGreaterThan(0);
      expect(tools, `${scope} model-visible tools were ${JSON.stringify(tools)}`).toEqual([]);
    });

    it("refuses a request that mistakenly carries backend tools", async () => {
      const modelId = `aux-${scope}-carries-tools`;
      const request = baseRequest(`aux-${scope}-tools-run`, modelId);
      request.executionScope = scope;
      request.tools = [
        {
          name: "shell",
          description: "Mistakenly attached backend tool.",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
          readOnly: true,
        },
      ];
      request.executeTool = async () => ({
        kind: "agent_tool_result",
        terminate: false,
        content: [{ type: "text", text: "must never run" }],
      });
      // Chosen behavior: explicit refusal at the trusted Java boundary, never a
      // silent strip and never a model call.
      await expect(consume(request)).rejects.toThrow(
        /422.*Auxiliary execution scope must not carry backend tools or skills/s,
      );
      expect(modelRequests.filter((entry) => entry.model === modelId)).toEqual([]);
    });

    it("refuses a request that mistakenly carries skills", async () => {
      const modelId = `aux-${scope}-carries-skills`;
      const request = baseRequest(`aux-${scope}-skills-run`, modelId);
      request.executionScope = scope;
      request.skills = [
        {
          id: "skill-1",
          name: "project-rules",
          description: "Mistakenly attached skill.",
          content: "AUX_SKILL_PRIVATE_MARKER",
        },
      ];
      await expect(consume(request)).rejects.toThrow(
        /422.*Auxiliary execution scope must not carry backend tools or skills/s,
      );
      const leaked = modelRequests.filter((entry) => entry.model === modelId);
      expect(leaked).toEqual([]);
    });
  });

  it("keeps authorized backend tools and native Plan/Skill surfaces for normal chat", async () => {
    const modelId = "chat-capability-control";
    const request = baseRequest("chat-capability-control-run", modelId);
    request.executionScope = "chat";
    request.tools = [
      {
        name: "shell",
        description: "Authorized backend tool.",
        inputSchema: { type: "object", properties: { command: { type: "string" } } },
        readOnly: true,
      },
    ];
    request.executeTool = async () => ({
      kind: "agent_tool_result",
      terminate: false,
      content: [{ type: "text", text: "/workspace" }],
    });
    request.skills = [
      { id: "skill-1", name: "project-rules", description: "Rules", content: "CHAT_SKILL_MARKER" },
    ];
    const events = await consume(request);
    expect(events.at(-1)).toEqual({ type: "done", text: "AUX_FIXTURE_OK" });
    const tools = visibleToolNames(modelId);
    for (const expected of ["shell", "plan_enter", "plan_write", "load_skill_through_path"]) {
      expect(tools, `chat model-visible tools were ${JSON.stringify(tools)}`).toContain(expected);
    }
  });
});
