import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

// Real TS consumer -> HTTP adapter -> Python service -> AgentScope 2.0.9. Only the
// upstream model is a deterministic local protocol fixture; no paid-model claim.
const serviceDir = fileURLToPath(new URL("../../../services/agentscope/", import.meta.url));
const python = join(serviceDir, ".venv/bin/python");

describe.skipIf(!existsSync(python))("AgentScope consumer integration", () => {
  let child: ChildProcess;
  let stateDir: string;
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
    child = spawn(
      python,
      ["-m", "uvicorn", "workpal_agentscope.app:app", "--host", "127.0.0.1", "--port", "0"],
      {
        cwd: serviceDir,
        env: {
          ...process.env,
          PYTHONPATH: join(serviceDir, "src"),
          AGENTSCOPE_STATE_DIR: stateDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const serviceUrl = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Python service startup timed out")),
        30_000,
      );
      let logs = "";
      child.stderr?.on("data", (chunk) => {
        logs += chunk.toString();
        const match = logs.match(/Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]!);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Python exited ${code}: ${logs}`));
      });
    });
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
    const files = await readdir(stateDir, { recursive: true });
    const snapshots = files.filter((path) => path.endsWith(".json"));
    expect(snapshots).toHaveLength(1);
    return readFile(join(stateDir, snapshots[0]!), "utf8");
  };

  it("returns final results to approval/compaction while a chat tool is active, without touching chat state", async () => {
    const seedEvents = await consume(request("seed-chat"));
    expect(seedEvents.at(-1)).toEqual({ type: "done", text: "CHAT_RESPONSE_MARKER" });
    const original = await snapshot();
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
      expect(await snapshot()).toBe(original);

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
      expect(await snapshot()).toBe(original);
      helpersCompleted = true;
      return { stdout: "/workspace" };
    };
    const events = await consume(main);
    expect(helpersCompleted).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", text: "CHAT_RESPONSE_MARKER" });
    const saved = JSON.parse(await snapshot());
    expect(saved.lastSourceMessageId).toBe("active-chat");
    expect(saved.revision).toBe(2);
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
    seed.history = [{ id: "fresh-source", role: "user", content: "fresh chat context" }];
    await consume(seed);
    const original = await snapshot();
    const main = request("paused-chat", "tool-fixture");
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
    expect(await snapshot()).toBe(original);
  });
});
