import type { RequestListener } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
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
          JSON.stringify({ type: "done" }),
          "",
        ].join("\n"),
      );
    });
    const runtime = new AgentScopeAgentRuntime({ baseUrl: fixture.url });
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(runRequest())) events.push(event);

    expect(events).toEqual([
      { type: "text", text: "hel" },
      { type: "text", text: "lo" },
      { type: "done" },
    ]);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({
      runId: "run-1",
      model: { provider: "openai-compatible", apiKey: "fixture-key" },
    });
  });

  it("rejects remote services before model credentials can leave the trusted network", () => {
    expect(() => new AgentScopeAgentRuntime({ baseUrl: "https://agents.example.test" })).toThrow(
      /loopback or the private Compose service/,
    );
  });

  it("surfaces wire errors as run failures", async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(`${JSON.stringify({ type: "error", message: "model unavailable" })}\n`);
    });
    const runtime = new AgentScopeAgentRuntime({ baseUrl: fixture.url });
    await expect(async () => {
      for await (const _event of runtime.run(runRequest())) {
        // Consume the stream.
      }
    }).rejects.toThrow("model unavailable");
  });
});
