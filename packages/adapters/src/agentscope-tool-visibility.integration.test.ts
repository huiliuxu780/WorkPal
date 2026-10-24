import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { toolsForRetryRun } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentScopeAgentRuntime } from "./agentscope-runtime.js";
import { withAgentScopeTestAdmission } from "./testing/agentscope-session-admission.js";

// AG-05: TS adapter → real Java jar → local model protocol fixture. Same Run,
// three model HTTP calls: tool available → revoked → re-authorized with a new
// schema. Auxiliary scopes stay empty. Native helper delegation stays off.
const serviceDir = fileURLToPath(new URL("../../../services/agent-runtime/", import.meta.url));
const runtimeJar = join(serviceDir, "target/agent-runtime-0.1.0.jar");

type FixtureModelRequest = {
  model: string;
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>;
  tools?: Array<{ name?: string; function?: { name?: string; parameters?: unknown } }>;
};

const keepTool: ConnectorTool = {
  name: "keep_tool",
  description: "Always available.",
  inputSchema: { type: "object", properties: {} },
  readOnly: true,
};

const flipV1: ConnectorTool = {
  name: "flip_tool",
  description: "Flip v1",
  inputSchema: { type: "object", properties: {} },
  readOnly: true,
};

const flipV2: ConnectorTool = {
  name: "flip_tool",
  description: "Flip v2",
  inputSchema: { type: "object", properties: { mode: { type: "string" } } },
  readOnly: true,
};

const retryDirect: ConnectorTool = {
  name: "hook_write",
  description: "POST a countable local fixture",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: { url: { type: "string" }, body: { type: "string" } },
    required: ["url", "body"],
    additionalProperties: false,
  },
};

const retryCatalog: ConnectorTool = {
  name: "fixture_execute_tool",
  description: "Run a fixture tool by id",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      arguments: { type: "object" },
    },
    required: ["id", "arguments"],
    additionalProperties: false,
  },
};

describe("AgentScope per-call tool visibility", () => {
  let child: ChildProcess;
  let stateDir: string;
  let runtime: AgentScopeAgentRuntime;
  let modelUrl: string;
  const modelRequests: FixtureModelRequest[] = [];
  const toolExecutions: Array<{ name: string; args: Record<string, unknown> }> = [];

  const modelServer = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body) as FixtureModelRequest;
    modelRequests.push(input);
    const names = toolNames(input);
    const keepCount = modelRequests.filter((request) => request.model === input.model).length;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta: unknown, finish: string | null = null) => {
      res.write(
        `data: ${JSON.stringify({
          id: "vis-response",
          object: "chat.completion.chunk",
          model: input.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );
    };
    emit({ role: "assistant" });
    if (input.model === "retry-schema" || input.model === "ordinary-schema") {
      if (keepCount === 1) {
        emit({
          tool_calls: [
            {
              index: 0,
              id: "direct-1",
              type: "function",
              function: {
                name: "hook_write",
                arguments: '{"url":"https://example.test","body":"one"}',
              },
            },
          ],
        });
        emit({}, "tool_calls");
      } else if (keepCount === 2) {
        emit({
          tool_calls: [
            {
              index: 0,
              id: "catalog-1",
              type: "function",
              function: {
                name: "fixture_execute_tool",
                arguments:
                  '{"id":"hook:write","arguments":{"url":"https://example.test","body":"one"}}',
              },
            },
          ],
        });
        emit({}, "tool_calls");
      } else {
        emit({ content: "RETRY_SCHEMA_OK" });
        emit({}, "stop");
      }
    } else if (input.model === "vis-refuse" && keepCount === 2) {
      emit({
        tool_calls: [
          {
            index: 0,
            id: "flip-hallucinated",
            type: "function",
            function: { name: "flip_tool", arguments: "{}" },
          },
        ],
      });
      emit({}, "tool_calls");
    } else if (keepCount === 1) {
      emit({
        tool_calls: [
          {
            index: 0,
            id: "keep-1",
            type: "function",
            function: { name: "keep_tool", arguments: "{}" },
          },
        ],
      });
      emit({}, "tool_calls");
    } else if (keepCount === 2 && names.includes("flip_tool") === false) {
      emit({
        tool_calls: [
          {
            index: 0,
            id: "keep-2",
            type: "function",
            function: { name: "keep_tool", arguments: "{}" },
          },
        ],
      });
      emit({}, "tool_calls");
    } else if (keepCount === 3 && names.includes("flip_tool")) {
      emit({
        tool_calls: [
          {
            index: 0,
            id: "flip-1",
            type: "function",
            function: { name: "flip_tool", arguments: '{"mode":"restored"}' },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      emit({ content: "VIS_FIXTURE_OK" });
      emit({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "workpal-tool-visibility-"));
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

  const context = (runId: string) => ({
    operationId: runId,
    traceId: runId,
    userId: "user-1",
    spaceId: "space-1",
    botId: "bot-1",
    runId,
    signal: new AbortController().signal,
  });

  it("refreshes connector tools on every model call of the same run", async () => {
    const request: AgentRunRequest = {
      botId: "bot-1",
      threadId: "vis-same-run",
      runId: "vis-same-run",
      prompt: "Use the live tools.",
      instructions: "Reply with the requested output only.",
      history: [],
      tools: [keepTool, flipV1],
      currentTools: async () => {
        // Key off completed model HTTP, not currentTools invocations: execute-time
        // revalidation also calls this, and must not skip a visibility round.
        const round = modelRequests.filter((entry) => entry.model === "vis-same-run").length;
        if (round === 0) return [keepTool, flipV1];
        if (round === 1) return [keepTool];
        return [keepTool, flipV2];
      },
      executeTool: async (name, args) => {
        toolExecutions.push({ name, args });
        return {
          kind: "agent_tool_result",
          terminate: false,
          content: [{ type: "text", text: `${name} ok` }],
        };
      },
      model: {
        provider: "openai-compatible",
        id: "vis-same-run",
        apiKey: "fixture",
        baseUrl: modelUrl,
      },
    };
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(
      withAgentScopeTestAdmission(request, { userId: "user-1", spaceId: "space-1" }),
      context("vis-same-run"))) events.push(event);
    expect(events.at(-1)).toEqual({ type: "done", text: "VIS_FIXTURE_OK" });
    const captured = modelRequests.filter((entry) => entry.model === "vis-same-run");
    expect(captured.length).toBeGreaterThanOrEqual(3);
    expect(toolNames(captured[0]!)).toEqual(expect.arrayContaining(["keep_tool", "flip_tool"]));
    expect(toolNames(captured[1]!)).toEqual(["keep_tool"]);
    expect(toolNames(captured[1]!)).not.toContain("flip_tool");
    expect(toolNames(captured[2]!)).toEqual(expect.arrayContaining(["keep_tool", "flip_tool"]));
    expect(JSON.stringify(schemaOf(captured[2]!, "flip_tool"))).toContain("mode");
    expect(toolExecutions.map((entry) => entry.name)).toEqual([
      "keep_tool",
      "keep_tool",
      "flip_tool",
    ]);
    expect(toolExecutions[2]?.args).toEqual({ mode: "restored" });
    expect(events.some((event) => event.type === "tool" && event.name === "flip_tool")).toBe(true);
  });

  it("refuses a hallucinated revoked tool without a provider execution", async () => {
    const executions: string[] = [];
    const request: AgentRunRequest = {
      botId: "bot-1",
      threadId: "vis-refuse",
      runId: "vis-refuse",
      prompt: "Use the live tools.",
      instructions: "Reply with the requested output only.",
      history: [],
      tools: [keepTool, flipV1],
      currentTools: async () => {
        const round = modelRequests.filter((entry) => entry.model === "vis-refuse").length;
        return round === 0 ? [keepTool, flipV1] : [keepTool];
      },
      executeTool: async (name) => {
        if (name === "flip_tool") {
          return {
            error: "permission_revoked: Tool flip_tool is not authorized for this run",
            reason: "permission_revoked",
            executed: false,
          };
        }
        executions.push(name);
        return {
          kind: "agent_tool_result",
          terminate: false,
          content: [{ type: "text", text: `${name} ok` }],
        };
      },
      model: {
        provider: "openai-compatible",
        id: "vis-refuse",
        apiKey: "fixture",
        baseUrl: modelUrl,
      },
    };
    const events: AgentRuntimeEvent[] = [];
    try {
      for await (const event of runtime.run(
      withAgentScopeTestAdmission(request, { userId: "user-1", spaceId: "space-1" }),
      context("vis-refuse"))) events.push(event);
    } catch (error) {
      expect(String(error)).toMatch(/not allowed/i);
    }
    const captured = modelRequests.filter((entry) => entry.model === "vis-refuse");
    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(toolNames(captured[0]!)).toEqual(expect.arrayContaining(["keep_tool", "flip_tool"]));
    expect(toolNames(captured[1]!)).toEqual(["keep_tool"]);
    expect(executions).not.toContain("flip_tool");
  });

  it("keeps auxiliary scopes empty while chat still sees native plan tools", async () => {
    const request: AgentRunRequest = {
      botId: "bot-1",
      threadId: "vis-aux",
      runId: "vis-aux",
      executionScope: "team-chat-judge",
      prompt: "Judge the turn.",
      instructions: "Reply only.",
      history: [],
      tools: [],
      model: {
        provider: "openai-compatible",
        id: "vis-aux",
        apiKey: "fixture",
        baseUrl: modelUrl,
      },
    };
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(
      withAgentScopeTestAdmission(request, { userId: "user-1", spaceId: "space-1" }),
      context("vis-aux"))) events.push(event);
    expect(events.at(-1)?.type).toBe("done");
    const captured = modelRequests.filter((entry) => entry.model === "vis-aux");
    expect(captured.length).toBeGreaterThan(0);
    expect(toolNames(captured[0]!)).toEqual([]);
  });

  it("keeps retryOperationId on direct and catalog schemas across every model round", async () => {
    const live = [retryDirect, retryCatalog];
    const request: AgentRunRequest = {
      botId: "bot-1",
      threadId: "retry-schema",
      runId: "retry-schema",
      prompt: "Continue the listed operations.",
      instructions: "Reply with the requested output only.",
      history: [],
      tools: toolsForRetryRun(live, "run-old"),
      currentTools: async () => toolsForRetryRun(live, "run-old"),
      executeTool: async (name, args) => {
        toolExecutions.push({ name, args });
        return {
          kind: "agent_tool_result",
          terminate: false,
          content: [{ type: "text", text: `${name} ok` }],
        };
      },
      model: {
        provider: "openai-compatible",
        id: "retry-schema",
        apiKey: "fixture",
        baseUrl: modelUrl,
      },
    };
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(
      withAgentScopeTestAdmission(request, { userId: "user-1", spaceId: "space-1" }),
      context("retry-schema"))) events.push(event);
    expect(events.at(-1)).toEqual({ type: "done", text: "RETRY_SCHEMA_OK" });
    const captured = modelRequests.filter((entry) => entry.model === "retry-schema");
    expect(captured.length).toBeGreaterThanOrEqual(3);
    for (const round of captured) {
      expectRetryIdentity(parametersOf(round, "hook_write"), ["url", "body"]);
      expectRetryIdentity(parametersOf(round, "fixture_execute_tool"), ["id", "arguments"]);
    }
  });

  it("does not declare retryOperationId on an ordinary run's model schemas", async () => {
    const live = [retryDirect, retryCatalog];
    const request: AgentRunRequest = {
      botId: "bot-1",
      threadId: "ordinary-schema",
      runId: "ordinary-schema",
      prompt: "Use the live tools.",
      instructions: "Reply with the requested output only.",
      history: [],
      tools: live,
      currentTools: async () => live,
      executeTool: async (name, args) => {
        toolExecutions.push({ name, args });
        return {
          kind: "agent_tool_result",
          terminate: false,
          content: [{ type: "text", text: `${name} ok` }],
        };
      },
      model: {
        provider: "openai-compatible",
        id: "ordinary-schema",
        apiKey: "fixture",
        baseUrl: modelUrl,
      },
    };
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(
      withAgentScopeTestAdmission(request, { userId: "user-1", spaceId: "space-1" }),
      context("ordinary-schema"))) events.push(event);
    expect(events.at(-1)).toEqual({ type: "done", text: "RETRY_SCHEMA_OK" });
    const captured = modelRequests.filter((entry) => entry.model === "ordinary-schema");
    expect(captured.length).toBeGreaterThanOrEqual(3);
    for (const round of captured) {
      expectOrdinaryIdentity(parametersOf(round, "hook_write"), ["url", "body"]);
      expectOrdinaryIdentity(parametersOf(round, "fixture_execute_tool"), ["id", "arguments"]);
    }
  });
});

function toolNames(request: FixtureModelRequest): string[] {
  return (request.tools ?? [])
    .map((tool) => tool.function?.name ?? tool.name ?? "")
    .filter((name) => name && !name.startsWith("plan_") && name !== "load_skill_through_path");
}

function schemaOf(request: FixtureModelRequest, name: string) {
  return (request.tools ?? []).find((tool) => (tool.function?.name ?? tool.name) === name);
}

function parametersOf(request: FixtureModelRequest, name: string) {
  return schemaOf(request, name)?.function?.parameters as Record<string, unknown> | undefined;
}

function expectRetryIdentity(schema: Record<string, unknown> | undefined, keys: string[]) {
  expect(schema).toEqual(
    expect.objectContaining({
      additionalProperties: false,
      properties: expect.objectContaining({
        ...Object.fromEntries(keys.map((key) => [key, expect.anything()])),
        retryOperationId: expect.objectContaining({ type: "string" }),
      }),
    }),
  );
}

function expectOrdinaryIdentity(schema: Record<string, unknown> | undefined, keys: string[]) {
  const properties = schema?.properties as Record<string, unknown> | undefined;
  expect(schema).toEqual(
    expect.objectContaining({
      additionalProperties: false,
      properties: expect.objectContaining(
        Object.fromEntries(keys.map((key) => [key, expect.anything()])),
      ),
    }),
  );
  expect(properties?.retryOperationId).toBeUndefined();
}
