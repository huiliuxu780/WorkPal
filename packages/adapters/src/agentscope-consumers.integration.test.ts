import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentScopeAgentRuntime } from "./agentscope-runtime.js";
import { runAutoReviewJudge } from "./auto-review.js";
import { compactHistory } from "./history-compaction.js";

// Real TS consumer -> HTTP adapter -> Java service -> AgentScope Harness. Only the
// upstream model is a deterministic local protocol fixture; no paid-model claim.
const serviceDir = fileURLToPath(new URL("../../../services/agent-runtime/", import.meta.url));
const runtimeJar = join(serviceDir, "target/agent-runtime-0.1.0.jar");

describe("AgentScope consumer integration", () => {
  let child: ChildProcess;
  let stateDir: string;
  let chatSnapshotPath: string | undefined;
  let runtime: AgentScopeAgentRuntime;
  let modelUrl: string;
  const modelRequests: Array<{
    model: string;
    messages: Array<{ role: string; content: unknown }>;
  }> = [];
  const modelServer = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    modelRequests.push(input);
    const needsTool =
      input.model === "tool-fixture" &&
      !input.messages.some((message: { role: string }) => message.role === "tool");
    const text =
      input.model === "review-fixture"
        ? '{"decision":"pass","reason":"approved fixture action"}'
        : input.model === "summary-fixture"
          ? "SUMMARY_RESULT_MARKER: preserved user decisions."
          : "CHAT_RESPONSE_MARKER";
    const delta = needsTool
      ? {
          tool_calls: [
            {
              index: 0,
              id: "shell-call-1",
              type: "function",
              function: { name: "shell", arguments: '{"command":"pwd"}' },
            },
          ],
        }
      : { content: text };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [part, finish] of [
      [delta, null],
      [{}, needsTool ? "tool_calls" : "stop"],
    ]) {
      res.write(
        `data: ${JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`,
      );
    }
    res.end("data: [DONE]\n\n");
  });

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "workpal-helper-regression-"));
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
    operationId: "integration",
    traceId: "integration",
    userId: "user-1",
    spaceId: "space-1",
  });
  const request = (runId: string, modelId = "chat-fixture"): AgentRunRequest => ({
    botId: "bot-1",
    threadId: "thread-1",
    runId,
    sourceMessageId: runId,
    prompt: "PRIVATE_CHAT_MARKER",
    instructions: "Be concise.",
    history: [],
    tools: [],
    model: { provider: "openai-compatible", id: modelId, apiKey: "fixture", baseUrl: modelUrl },
  });
  const consume = async (input: AgentRunRequest) => {
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(input, context())) events.push(event);
    return events;
  };
  const snapshot = async () => {
    if (!chatSnapshotPath) {
      const files = await readdir(stateDir, { recursive: true });
      const snapshots = files.filter(
        (path) => path.startsWith("state/") && path.endsWith("agent_state.json"),
      );
      expect(snapshots).toHaveLength(1);
      chatSnapshotPath = join(stateDir, snapshots[0]!);
    }
    return readFile(chatSnapshotPath, "utf8");
  };

  it("returns final results to approval/compaction while a chat tool is active, without touching chat state", async () => {
    const seedEvents = await consume(request("seed-chat"));
    expect(seedEvents.at(-1)).toEqual({ type: "done", text: "CHAT_RESPONSE_MARKER" });
    const main = request("active-chat", "tool-fixture");
    // Supply the source marker so the chat restores its durable context.
    main.history = [{ id: "seed-chat", role: "user", content: "PRIVATE_CHAT_MARKER" }];
    main.tools = [
      {
        name: "shell",
        description: "Read working directory.",
        inputSchema: { type: "object", properties: { command: { type: "string" } } },
        readOnly: true,
      },
    ];
    let helpersCompleted = false;
    main.executeTool = async () => {
      const activeSnapshot = await snapshot();
      // Main chat still holds its lock while the TS executor asks its LLM judge.
      await expect(consume(request("competing-chat"))).rejects.toThrow(/409/);
      const review = await runAutoReviewJudge({
        runtime,
        checker: { provider: "openai-compatible", model: "review-fixture" },
        apiKey: "fixture",
        baseUrl: modelUrl,
        prompt: "REVIEW_PROMPT_MARKER",
        runId: "active-chat",
        userId: "user-1",
        spaceId: "space-1",
        botId: "bot-1",
        threadId: "thread-1",
      });
      expect(review).toMatchObject({ decision: "pass", reason: "approved fixture action" });
      expect(await snapshot()).toBe(activeSnapshot);

      const thread = {
        botId: "bot-1",
        userId: "user-1",
        spaceId: "space-1",
        historyCompactedUpToSeq: null,
        historyCompactionGeneration: 0,
        historyCompactionSummary: null,
        nextMessageSeq: 1,
      };
      const updateMany = vi.fn(async () => ({ count: 1 }));
      await compactHistory(
        {
          runtime,
          prisma: {
            thread: { findUniqueOrThrow: async () => thread, updateMany },
            message: {
              findMany: async () => [
                { seq: 0, role: "user", blocks: [{ kind: "text", text: "SUMMARY_PROMPT_MARKER" }] },
              ],
            },
          } as unknown as PrismaClient,
          resolveModel: async () => ({
            provider: "openai-compatible",
            id: "summary-fixture",
            apiKey: "fixture",
            baseUrl: modelUrl,
          }),
          memoryProviders: { resolve: async () => null },
          jobs: { enqueue: async () => undefined } as never,
        },
        "thread-1",
      );
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            historyCompactedUpToSeq: 0,
            historyCompactionSummary: "SUMMARY_RESULT_MARKER: preserved user decisions.",
          },
        }),
      );
      expect(await snapshot()).toBe(activeSnapshot);
      helpersCompleted = true;
      return { stdout: "/workspace" };
    };
    const events = await consume(main);
    expect(helpersCompleted).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", text: "CHAT_RESPONSE_MARKER" });
    const saved = JSON.parse(await snapshot());
    expect(JSON.stringify(saved)).toContain("PRIVATE_CHAT_MARKER");
    expect(JSON.stringify(saved)).not.toMatch(
      /REVIEW_PROMPT_MARKER|SUMMARY_PROMPT_MARKER|SUMMARY_RESULT_MARKER/,
    );
    for (const helper of modelRequests.filter(
      (input) => input.model === "review-fixture" || input.model === "summary-fixture",
    )) {
      expect(JSON.stringify(helper)).not.toContain("PRIVATE_CHAT_MARKER");
    }
  });

  it("recognizes backend approval pause as a terminal without completing or saving the chat", async () => {
    const seed = request("pause-seed");
    seed.threadId = "thread-pause";
    seed.history = [{ id: "fresh-source", role: "user", content: "fresh chat context" }];
    await consume(seed);
    const main = request("paused-chat", "tool-fixture");
    main.threadId = "thread-pause";
    // Deliberately rebuild from a source window with no previous tool result.
    main.history = [{ id: "different-source", role: "user", content: "wait for approval" }];
    main.tools = [
      { name: "shell", description: "Sandbox action.", inputSchema: { type: "object" } },
    ];
    main.executeTool = async () => ({
      kind: "agent_tool_result",
      terminate: true,
      content: [{ type: "text", text: "Waiting for approval." }],
      details: { approval: "paused" },
    });
    const events = await consume(main);
    expect(events.some((event) => event.type === "tool")).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "progress", text: "shell waiting for approval" });
  });
});
