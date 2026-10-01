import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";

type AgentScopeWireEvent = AgentRuntimeEvent | { type: "error"; message: string };

export interface AgentScopeAgentRuntimeOptions {
  baseUrl?: string;
}

const TRUSTED_SERVICE_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "agentscope"]);

function serviceUrl(raw: string | undefined): URL {
  const url = new URL(raw?.trim() || "http://127.0.0.1:8090");
  if (!TRUSTED_SERVICE_HOSTS.has(url.hostname)) {
    throw new Error(
      "AGENTSCOPE_URL must use loopback or the private Compose service name in this release because model credentials are brokered by the application backend",
    );
  }
  return url;
}

function endpoint(base: URL, path: string): URL {
  const normalized = new URL(base);
  normalized.pathname = `${normalized.pathname.replace(/\/$/, "")}${path}`;
  return normalized;
}

function serializableRequest(request: AgentRunRequest) {
  if (request.model.oauth) {
    throw new Error(
      "AgentScope does not support subscription OAuth credentials yet; select an API-key or OpenAI-compatible connection",
    );
  }
  if (
    request.currentTurnImages?.length ||
    request.history.some((message) => message.images?.length)
  ) {
    throw new Error("Image input is not enabled in the first AgentScope delivery slice");
  }
  return {
    botId: request.botId,
    threadId: request.threadId,
    runId: request.runId,
    sourceMessageId: request.sourceMessageId,
    prompt: request.prompt,
    instructions: request.instructions,
    history: request.history.map(({ id, role, content }) => ({ id, role, content })),
    tools: request.tools.map(({ name, description, inputSchema, readOnly }) => ({
      name,
      description,
      inputSchema,
      readOnly,
    })),
    model: {
      provider: request.model.provider,
      id: request.model.id,
      apiKey: request.model.apiKey,
      baseUrl: request.model.baseUrl,
      reasoning: request.model.reasoning,
      maxTokens: request.model.maxTokens,
      contextWindow: request.model.contextWindow,
      thinkingLevel: request.model.thinkingLevel,
    },
    allowSilentEmpty: request.allowSilentEmpty,
    emptyResponseText: request.emptyResponseText,
  };
}

function parseWireEvent(line: string): AgentScopeWireEvent {
  const parsed = JSON.parse(line) as AgentScopeWireEvent;
  if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
    throw new Error("AgentScope returned a malformed event");
  }
  return parsed;
}

export class AgentScopeAgentRuntime implements AgentRuntime {
  private readonly baseUrl: URL;
  private readonly active = new Map<string, AbortController>();

  constructor(options: AgentScopeAgentRuntimeOptions = {}) {
    this.baseUrl = serviceUrl(options.baseUrl);
  }

  describe() {
    return {
      id: "agentscope",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: true, tools: true, scripted: false },
    };
  }

  async abort(runId: string): Promise<void> {
    const controller = this.active.get(runId);
    try {
      await fetch(endpoint(this.baseUrl, `/v1/runs/${encodeURIComponent(runId)}`), {
        method: "DELETE",
        signal: AbortSignal.timeout(1_500),
      });
    } catch {
      // Closing the stream still interrupts the local service on disconnect.
    } finally {
      controller?.abort();
    }
  }

  run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterableIterator<AgentRuntimeEvent> {
    const controller = new AbortController();
    const signal = context?.signal
      ? AbortSignal.any([controller.signal, context.signal])
      : controller.signal;
    const events = this.runEvents(request, controller, signal);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => events.next(),
      return: () => {
        controller.abort();
        return events.return();
      },
      throw: (error) => {
        controller.abort();
        return events.throw(error);
      },
    };
  }

  private async *runEvents(
    request: AgentRunRequest,
    controller: AbortController,
    signal: AbortSignal,
  ): AsyncGenerator<AgentRuntimeEvent, void> {
    if (this.active.has(request.runId)) throw new Error(`Run ${request.runId} is already active`);
    this.active.set(request.runId, controller);
    try {
      const response = await fetch(endpoint(this.baseUrl, "/v1/runs"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify(serializableRequest(request)),
        signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1_000);
        throw new Error(`AgentScope service returned ${response.status}: ${detail}`);
      }
      if (!response.body) throw new Error("AgentScope service returned an empty response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            const event = parseWireEvent(line);
            if (event.type === "error") throw new Error(event.message);
            yield event;
          }
          newline = buffer.indexOf("\n");
        }
        if (done) break;
      }
      if (buffer.trim()) {
        const event = parseWireEvent(buffer.trim());
        if (event.type === "error") throw new Error(event.message);
        yield event;
      }
    } finally {
      this.active.delete(request.runId);
    }
  }
}
