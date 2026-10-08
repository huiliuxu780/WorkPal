import type { RequestListener } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentScopeAgentRuntime } from "./agentscope-runtime.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function runRequest(runId = "run-1"): AgentRunRequest {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    runId,
    sourceMessageId: "message-1",
    prompt: "hello",
    instructions: "be concise",
    history: [],
    tools: [],
    model: {
      provider: "openai-compatible",
      id: "fixture",
      apiKey: "fixture-key",
      baseUrl: "http://model.test/v1",
    },
  };
}

function runContext(runId = "run-1") {
  return {
    operationId: `op-${runId}`,
    traceId: `trace-${runId}`,
    userId: "user-1",
    spaceId: "space-1",
    botId: "bot-1",
    runId,
    signal: new AbortController().signal,
  };
}

async function listen(handler: RequestListener): Promise<{ url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (body) requests.push(JSON.parse(body));
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

describe("AgentScopeAgentRuntime", () => {
  it("translates the loopback NDJSON stream into runtime events", async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(
        [
          JSON.stringify({ type: "text", text: "hel" }),
          JSON.stringify({ type: "text", text: "lo" }),
          JSON.stringify({ type: "done", text: "hello" }),
          "",
        ].join("\n"),
      );
    });
    const runtime = new AgentScopeAgentRuntime({ baseUrl: fixture.url });
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(runRequest(), runContext())) events.push(event);

    expect(events).toEqual([
      { type: "text", text: "hel" },
      { type: "text", text: "lo" },
      { type: "done", text: "hello" },
    ]);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({
      runId: "run-1",
      model: { provider: "openai-compatible", apiKey: "fixture-key" },
    });
  });

  it("serializes scoped skills for AgentScope on-demand loading", async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(`${JSON.stringify({ type: "done", text: "" })}\n`);
    });
    const runtime = new AgentScopeAgentRuntime({ baseUrl: fixture.url });
    const next = runRequest();
    next.skills = [
      {
        id: "skill-1",
        name: "release-check",
        description: "Verify releases.",
        content: "---\nname: release-check\ndescription: Verify releases.\n---\nRun tests.",
      },
    ];
    for await (const _event of runtime.run(next, runContext())) {
      // consume
    }
    expect(fixture.requests[0]).toMatchObject({
      skills: [
        {
          id: "skill-1",
          name: "release-check",
          description: "Verify releases.",
        },
      ],
    });
  });

  it("rejects remote services before model credentials can leave the trusted network", () => {
    expect(() => new AgentScopeAgentRuntime({ baseUrl: "https://agents.example.test" })).toThrow(
      /loopback or the private Compose service/,
    );
  });

  it("rejects a run without trusted application identity", async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(`${JSON.stringify({ type: "done", text: "" })}\n`);
    });
    const runtime = new AgentScopeAgentRuntime({ baseUrl: fixture.url });
    await expect(async () => {
      for await (const _event of runtime.run(runRequest())) {
        // consume
      }
    }).rejects.toThrow(/trusted user and space/);
    expect(fixture.requests).toHaveLength(0);
  });

  it("surfaces wire errors as run failures", async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(`${JSON.stringify({ type: "error", message: "model unavailable" })}\n`);
    });
    const runtime = new AgentScopeAgentRuntime({ baseUrl: fixture.url });
    await expect(async () => {
      for await (const _event of runtime.run(runRequest(), runContext())) {
        // Consume the stream.
      }
    }).rejects.toThrow("model unavailable");
  });

  it("brokers authorized tools back to the bound TypeScript executor", async () => {
    const fixture = await listen((_request, response) => {
      void (async () => {
        const outbound = fixture.requests[0] as {
          runId: string;
          toolBridge: {
            url: string;
            steeringUrl: string;
            modelUrl: string;
            token: string;
            identity: Record<string, string>;
          };
        };
        const steering = await fetch(outbound.toolBridge.steeringUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${outbound.toolBridge.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ runId: outbound.runId, seenIds: [] }),
        });
        expect(await steering.json()).toEqual({
          messages: [
            {
              id: "steer-1",
              messageId: "message-2",
              text: "also list files",
              images: [],
            },
          ],
        });
        const model = await fetch(outbound.toolBridge.modelUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${outbound.toolBridge.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            runId: outbound.runId,
            provider: "anthropic",
            modelId: "claude-fixture",
          }),
        });
        expect(await model.json()).toEqual({
          model: {
            provider: "anthropic",
            id: "claude-fixture",
            apiKey: "child-key",
          },
        });
        const callback = await fetch(outbound.toolBridge.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${outbound.toolBridge.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            runId: outbound.runId,
            name: "shell",
            executionId: "call-7",
            args: { command: "pwd" },
          }),
        });
        expect(callback.status).toBe(200);
        expect(await callback.json()).toEqual({ status: "ok", result: { stdout: "/workspace" } });
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end(`${JSON.stringify({ type: "done", text: "" })}\n`);
      })();
    });
    const executeTool = vi.fn(async () => ({ stdout: "/workspace" }));
    const onToolCompleted = vi.fn();
    const request = runRequest("run-tools");
    request.tools = [
      {
        name: "shell",
        description: "Run a sandbox command.",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        readOnly: false,
      },
    ];
    request.executeTool = executeTool;
    request.onToolCompleted = onToolCompleted;
    request.claimSteering = vi.fn(async () => [
      { id: "steer-1", messageId: "message-2", text: "also list files" },
    ]);
    request.resolveModel = vi.fn(async (provider, id) => ({
      provider,
      id,
      apiKey: "child-key",
    }));

    const runtime = new AgentScopeAgentRuntime({ baseUrl: fixture.url });
    const context = {
      operationId: "op-1",
      traceId: "trace-1",
      userId: "user-1",
      spaceId: "space-1",
      botId: "bot-1",
      runId: "run-tools",
      signal: new AbortController().signal,
    };
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(request, context)) events.push(event);

    expect(events).toEqual([{ type: "done", text: "" }]);
    expect(executeTool).toHaveBeenCalledWith("shell", { command: "pwd" }, "call-7");
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shell", executionId: "call-7" }),
    );
    expect(request.claimSteering).toHaveBeenCalledWith([]);
    expect(request.resolveModel).toHaveBeenCalledWith("anthropic", "claude-fixture");
    expect(
      (fixture.requests[0] as { toolBridge: { identity: Record<string, string> } }).toolBridge
        .identity,
    ).toEqual({
      userId: "user-1",
      spaceId: "space-1",
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-tools",
    });
  });

  it("keeps only a task-scoped bridge after the parent stream ends", async () => {
    let registration:
      | Promise<{ bridge: { url: string; taskEventUrl: string; token: string }; taskToken: string }>
      | undefined;
    const fixture = await listen((_request, response) => {
      registration = (async () => {
        const outbound = fixture.requests[0] as {
          runId: string;
          toolBridge: {
            url: string;
            taskUrl: string;
            taskEventUrl: string;
            token: string;
          };
        };
        const started = await fetch(outbound.toolBridge.taskUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${outbound.toolBridge.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            runId: outbound.runId,
            taskId: "task_12345678",
            agentId: "helper",
            sessionId: "sub-1",
          }),
        });
        expect(started.status).toBe(200);
        const { token } = (await started.json()) as { token: string };
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end(`${JSON.stringify({ type: "done", text: "parent finished" })}\n`);
        return { bridge: outbound.toolBridge, taskToken: token };
      })();
    });
    const executeTool = vi.fn(async () => ({ value: "read result" }));
    const registerBackgroundTask = vi.fn(async () => {});
    const authorizeBackgroundTool = vi.fn(async () => true);
    const onBackgroundTaskEvent = vi.fn(async () => {});
    const request = runRequest("run-background");
    request.tools = [
      {
        name: "read_clock",
        description: "Read clock",
        inputSchema: {
          type: "object",
          properties: {},
        },
        readOnly: true,
      },
      {
        name: "write_data",
        description: "Write",
        inputSchema: {
          type: "object",
          properties: {},
        },
        readOnly: false,
      },
    ];
    request.executeTool = executeTool;
    request.registerBackgroundTask = registerBackgroundTask;
    request.authorizeBackgroundTool = authorizeBackgroundTool;
    request.onBackgroundTaskEvent = onBackgroundTaskEvent;
    const runtime = new AgentScopeAgentRuntime({ baseUrl: fixture.url });
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(request, runContext("run-background")))
      events.push(event);
    expect(events.at(-1)).toEqual({ type: "done", text: "parent finished" });
    const { bridge, taskToken } = await registration!;
    expect(registerBackgroundTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task_12345678",
        toolNames: ["read_clock"],
        parentRunId: "run-background",
      }),
    );
    const call = (name: string, token: string) =>
      fetch(bridge.url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          runId: "run-background",
          taskId: "task_12345678",
          agentId: "helper",
          sessionId: "sub-1",
          name,
          executionId: "subagent:sub-1:call-1",
          args: {},
        }),
      });
    expect((await call("read_clock", bridge.token)).status).toBe(401);
    expect((await call("write_data", taskToken)).status).toBe(403);
    expect((await call("read_clock", taskToken)).status).toBe(200);
    expect(executeTool).toHaveBeenCalledTimes(1);
    authorizeBackgroundTool.mockResolvedValue(false);
    expect((await call("read_clock", taskToken)).status).toBe(403);
    const completed = await fetch(bridge.taskEventUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${taskToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run-background",
        taskId: "task_12345678",
        status: "completed",
        result: "done",
      }),
    });
    expect(completed.status).toBe(200);
    expect(onBackgroundTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        result: "done",
      }),
    );
    expect((await call("read_clock", taskToken)).status).toBe(401);
  });

  it("fails in-flight background projections when the Java instance changes", async () => {
    let taskToken = "";
    const fixture = await listen((_request, response) => {
      void (async () => {
        const outbound = fixture.requests.at(-1) as {
          runId: string;
          toolBridge?: {
            taskUrl: string;
            token: string;
          };
        };
        if (outbound.runId === "run-before-restart") {
          const started = await fetch(outbound.toolBridge!.taskUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${outbound.toolBridge!.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              runId: outbound.runId,
              taskId: "task_restart1",
              agentId: "helper",
              sessionId: "sub-restart",
            }),
          });
          taskToken = ((await started.json()) as { token: string }).token;
        }
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "x-agent-runtime-instance":
            outbound.runId === "run-before-restart" ? "instance-a" : "instance-b",
        });
        response.end(`${JSON.stringify({ type: "done", text: "ok" })}\n`);
      })();
    });
    const onBackgroundTaskEvent = vi.fn(async () => {});
    const runtime = new AgentScopeAgentRuntime({ baseUrl: fixture.url });
    const first = runRequest("run-before-restart");
    first.tools = [
      {
        name: "read_clock",
        description: "Read",
        inputSchema: {
          type: "object",
          properties: {},
        },
        readOnly: true,
      },
    ];
    first.executeTool = async () => ({ ok: true });
    first.registerBackgroundTask = async () => {};
    first.authorizeBackgroundTool = async () => true;
    first.onBackgroundTaskEvent = onBackgroundTaskEvent;
    for await (const _event of runtime.run(first, runContext(first.runId))) {
      /* consume */
    }
    expect(taskToken).toBeTruthy();
    const second = runRequest("run-after-restart");
    for await (const _event of runtime.run(second, runContext(second.runId))) {
      /* consume */
    }
    expect(onBackgroundTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("restarted"),
      }),
    );
  });

  it("encodes image bytes instead of leaking Uint8Array object keys onto the wire", async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(`${JSON.stringify({ type: "done", text: "" })}\n`);
    });
    const request = runRequest("run-image");
    request.currentTurnImages = [
      { name: "pixel.png", mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
    ];
    const runtime = new AgentScopeAgentRuntime({ baseUrl: fixture.url });
    for await (const _event of runtime.run(request, runContext("run-image"))) {
      // Consume the stream.
    }
    expect(fixture.requests[0]).toMatchObject({
      currentTurnImages: [{ name: "pixel.png", mimeType: "image/png", data: "AQID" }],
    });
  });

  it.each([
    [{ type: "text", text: "unfinished" }],
    [{ type: "done" }],
    [
      { type: "done", text: "finished" },
      { type: "text", text: "late" },
    ],
    [
      { type: "done", text: "finished" },
      { type: "error", message: "save failed" },
    ],
  ])("rejects incomplete or invalid terminal streams: %j", async (...wire) => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(wire.map((event) => JSON.stringify(event)).join("\n"));
    });
    const runtime = new AgentScopeAgentRuntime({ baseUrl: fixture.url });
    const events: AgentRuntimeEvent[] = [];
    await expect(async () => {
      for await (const event of runtime.run(runRequest(), runContext())) events.push(event);
    }).rejects.toThrow();
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("accepts an explicit approval pause without publishing completion", async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(
        [
          { type: "progress", text: "waiting for approval", activity: true },
          { type: "paused", reason: "approval-or-secret" },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n"),
      );
    });
    const runtime = new AgentScopeAgentRuntime({ baseUrl: fixture.url });
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(runRequest(), runContext())) events.push(event);
    expect(events).toEqual([{ type: "progress", text: "waiting for approval", activity: true }]);
  });
});
