import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentToolCompletion,
  ConnectorTool,
} from "@rakazo/adapter-kit";

type AgentScopeWireEvent = AgentRuntimeEvent | { type: "error"; message: string };

export interface AgentScopeAgentRuntimeOptions {
  baseUrl?: string;
  toolBridgeBindHost?: string;
  toolBridgePort?: number;
  toolBridgeUrl?: string;
}

interface ActiveBridgeRun {
  token: string;
  request: AgentRunRequest;
  tools: Map<string, ConnectorTool>;
  identity: {
    userId: string;
    spaceId: string;
    botId: string;
    threadId: string;
    runId: string;
  };
}

interface ToolBridgeCall {
  runId: string;
  name: string;
  executionId: string;
  args: Record<string, unknown>;
}

const TRUSTED_SERVICE_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "agentscope"]);
const TRUSTED_BRIDGE_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "api", "worker"]);
const MAX_BRIDGE_BODY_BYTES = 48 * 1024 * 1024;

export const AGENTSCOPE_API_KEY_PROVIDERS = new Set([
  "openai",
  "openrouter",
  "openai-compatible",
  "local",
  "anthropic",
  "google",
  "xai",
  "deepseek",
  "minimax",
  "minimax-cn",
  "moonshotai",
  "moonshotai-cn",
  "dashscope",
]);

export function agentScopeSupportsProvider(provider: string): boolean {
  return AGENTSCOPE_API_KEY_PROVIDERS.has(provider);
}

function serviceUrl(raw: string | undefined): URL {
  const url = new URL(raw?.trim() || "http://127.0.0.1:8090");
  if (!TRUSTED_SERVICE_HOSTS.has(url.hostname)) {
    throw new Error(
      "AGENTSCOPE_URL must use loopback or the private Compose service name because model credentials are brokered by the application backend",
    );
  }
  return url;
}

function bridgeUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !TRUSTED_BRIDGE_HOSTS.has(url.hostname)) {
    throw new Error(
      "AGENTSCOPE_TOOL_BRIDGE_URL must be an HTTP loopback URL or the private api/worker Compose service",
    );
  }
  return url;
}

function endpoint(base: URL, path: string): URL {
  const normalized = new URL(base);
  normalized.pathname = `${normalized.pathname.replace(/\/$/, "")}${path}`;
  return normalized;
}

function isPausedToolResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = result as { kind?: unknown; details?: unknown; terminate?: unknown };
  if (value.kind !== "agent_tool_result" || !value.details || typeof value.details !== "object") {
    return false;
  }
  const details = value.details as { approval?: unknown; secret?: unknown };
  return value.terminate === true && (details.approval === "paused" || details.secret === "paused");
}

function secureTokenEquals(expected: string, presented: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BRIDGE_BODY_BYTES) throw new Error("Tool bridge request is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function parseToolCall(value: unknown): ToolBridgeCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid tool bridge request");
  }
  const raw = value as Partial<ToolBridgeCall>;
  if (
    typeof raw.runId !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.executionId !== "string" ||
    !raw.args ||
    typeof raw.args !== "object" ||
    Array.isArray(raw.args)
  ) {
    throw new Error("Invalid tool bridge request");
  }
  return raw as ToolBridgeCall;
}

function serializeImage(image: NonNullable<AgentRunRequest["currentTurnImages"]>[number]) {
  return {
    name: image.name,
    mimeType: image.mimeType,
    data: Buffer.from(image.data).toString("base64"),
  };
}

function trustedIdentity(
  request: AgentRunRequest,
  context: Partial<AdapterContext> | undefined,
): ActiveBridgeRun["identity"] | undefined {
  if (!context?.userId || !context.spaceId) return undefined;
  if (context.botId && context.botId !== request.botId) {
    throw new Error("AgentScope run bot identity mismatch");
  }
  if (context.runId && context.runId !== request.runId) {
    throw new Error("AgentScope run identity mismatch");
  }
  return {
    userId: context.userId,
    spaceId: context.spaceId,
    botId: request.botId,
    threadId: request.threadId,
    runId: request.runId,
  };
}

class AgentScopeToolBridge {
  private readonly active = new Map<string, ActiveBridgeRun>();
  private starting?: Promise<URL>;

  constructor(
    private readonly bindHost: string,
    private readonly port: number,
    private readonly advertisedUrl?: URL,
  ) {}

  async register(
    request: AgentRunRequest,
    context: Partial<AdapterContext> | undefined,
  ): Promise<{
    url: string;
    steeringUrl?: string;
    modelUrl?: string;
    token: string;
    identity: ActiveBridgeRun["identity"];
  }> {
    if (request.tools.length > 0 && !request.executeTool) {
      throw new Error("AgentScope tools require the backend executor");
    }
    if (!context?.userId || !context.spaceId) {
      throw new Error("AgentScope tools require trusted user and space context");
    }
    if (context.botId && context.botId !== request.botId) {
      throw new Error("AgentScope tool bridge bot identity mismatch");
    }
    if (context.runId && context.runId !== request.runId) {
      throw new Error("AgentScope tool bridge run identity mismatch");
    }
    if (this.active.has(request.runId)) {
      throw new Error(`Tool bridge already has run ${request.runId}`);
    }
    const url = await this.start();
    const token = randomBytes(32).toString("base64url");
    const identity = {
      userId: context.userId,
      spaceId: context.spaceId,
      botId: request.botId,
      threadId: request.threadId,
      runId: request.runId,
    };
    this.active.set(request.runId, {
      token,
      request,
      tools: new Map(request.tools.map((tool) => [tool.name, tool])),
      identity,
    });
    return {
      url: endpoint(url, "/v1/tool-executions").toString(),
      ...(request.claimSteering ? { steeringUrl: endpoint(url, "/v1/steering").toString() } : {}),
      ...(request.resolveModel
        ? { modelUrl: endpoint(url, "/v1/model-resolutions").toString() }
        : {}),
      token,
      identity,
    };
  }

  unregister(runId: string) {
    this.active.delete(runId);
  }

  private start(): Promise<URL> {
    if (this.starting) return this.starting;
    this.starting = new Promise<URL>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response);
      });
      server.unref();
      server.once("error", reject);
      server.listen(this.port, this.bindHost, () => {
        server.off("error", reject);
        if (this.advertisedUrl) {
          resolve(this.advertisedUrl);
          return;
        }
        const address = server.address() as AddressInfo;
        resolve(new URL(`http://127.0.0.1:${address.port}`));
      });
    });
    return this.starting;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    if (
      request.method !== "POST" ||
      !["/v1/tool-executions", "/v1/steering", "/v1/model-resolutions"].includes(request.url ?? "")
    ) {
      writeJson(response, 404, { error: "not found" });
      return;
    }
    try {
      const body = await readJson(request);
      const runId =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as { runId?: unknown }).runId
          : undefined;
      if (typeof runId !== "string") throw new Error("Invalid bridge request");
      const run = this.active.get(runId);
      const authorization = request.headers.authorization ?? "";
      const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!run || !secureTokenEquals(run.token, presented)) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.url === "/v1/steering") {
        const seenIdsRaw = (body as { seenIds?: unknown }).seenIds;
        const seenIds = Array.isArray(seenIdsRaw)
          ? seenIdsRaw.filter((value): value is string => typeof value === "string")
          : [];
        const messages = run.request.claimSteering ? await run.request.claimSteering(seenIds) : [];
        writeJson(response, 200, {
          messages: messages.map((message) => ({
            ...message,
            images: message.images?.map(serializeImage) ?? [],
          })),
        });
        return;
      }
      if (request.url === "/v1/model-resolutions") {
        const provider = (body as { provider?: unknown }).provider;
        const modelId = (body as { modelId?: unknown }).modelId;
        if (typeof provider !== "string" || typeof modelId !== "string") {
          throw new Error("Invalid model resolution request");
        }
        if (!run.request.resolveModel) {
          writeJson(response, 403, { error: "Subagent model selection is unavailable" });
          return;
        }
        const model = await run.request.resolveModel(provider, modelId);
        if (model.oauth) {
          writeJson(response, 422, {
            error: "The selected subagent model uses OAuth, which AgentScope cannot consume",
          });
          return;
        }
        writeJson(response, 200, {
          model: {
            provider: model.provider,
            id: model.id,
            apiKey: model.apiKey,
            baseUrl: model.baseUrl,
            reasoning: model.reasoning,
            acceptsImages: model.acceptsImages,
            maxImagesPerPrompt: model.maxImagesPerPrompt,
            maxTokens: model.maxTokens,
            contextWindow: model.contextWindow,
            thinkingLevel: model.thinkingLevel,
          },
        });
        return;
      }
      const call = parseToolCall(body);
      const tool = run.tools.get(call.name);
      if (!tool) {
        writeJson(response, 403, { error: `Tool ${call.name} is not authorized for this run` });
        return;
      }
      const startedAt = Date.now();
      let result: unknown;
      let failure: unknown;
      try {
        result = tool.route
          ? await run.request.executeTool!(call.name, call.args, call.executionId, tool.route)
          : await run.request.executeTool!(call.name, call.args, call.executionId);
        writeJson(response, 200, {
          status: isPausedToolResult(result) ? "paused" : "ok",
          result,
        });
      } catch (error) {
        failure = error;
        writeJson(response, 500, {
          status: "error",
          error: error instanceof Error ? error.message : "Tool execution failed",
        });
      } finally {
        const completion: AgentToolCompletion = {
          name: call.name,
          executionId: call.executionId,
          durationMs: Math.max(0, Date.now() - startedAt),
          ...(result === undefined ? {} : { result }),
          ...(failure === undefined ? {} : { error: failure }),
          ...(isPausedToolResult(result) ? { paused: true } : {}),
        };
        try {
          void Promise.resolve(run.request.onToolCompleted?.(completion)).catch(() => undefined);
        } catch {
          // Audit callbacks are best effort and must not alter tool behavior.
        }
      }
    } catch (error) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid tool bridge request",
      });
    }
  }
}

function serializableRequest(
  request: AgentRunRequest,
  toolBridge?: Awaited<ReturnType<AgentScopeToolBridge["register"]>>,
  identity?: ActiveBridgeRun["identity"],
) {
  if (request.model.oauth) {
    throw new Error(
      "AgentScope does not support this subscription OAuth credential; select an API-key connection",
    );
  }
  return {
    botId: request.botId,
    threadId: request.threadId,
    runId: request.runId,
    sourceMessageId: request.sourceMessageId,
    identity,
    prompt: request.prompt,
    instructions: request.instructions,
    history: request.history.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      images: message.images?.map(serializeImage),
    })),
    currentTurnImages: request.currentTurnImages?.map(serializeImage),
    skills: request.skills?.map(({ id, name, description, content }) => ({
      id,
      name,
      description,
      content,
    })),
    tools: request.tools.map(({ name, description, inputSchema, readOnly }) => ({
      name,
      description,
      inputSchema,
      readOnly,
    })),
    toolBridge,
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
  private readonly toolBridge: AgentScopeToolBridge;

  constructor(options: AgentScopeAgentRuntimeOptions = {}) {
    this.baseUrl = serviceUrl(options.baseUrl);
    const advertised = options.toolBridgeUrl ? bridgeUrl(options.toolBridgeUrl) : undefined;
    this.toolBridge = new AgentScopeToolBridge(
      options.toolBridgeBindHost?.trim() || "127.0.0.1",
      options.toolBridgePort ?? 0,
      advertised,
    );
  }

  describe() {
    return {
      id: "agentscope",
      contractVersion: "1",
      adapterVersion: "0.2.0",
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
    const events = this.runEvents(request, context, controller, signal);
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
    context: Partial<AdapterContext> | undefined,
    controller: AbortController,
    signal: AbortSignal,
  ): AsyncGenerator<AgentRuntimeEvent, void> {
    if (this.active.has(request.runId)) throw new Error(`Run ${request.runId} is already active`);
    this.active.set(request.runId, controller);
    let bridgeRegistration: Awaited<ReturnType<AgentScopeToolBridge["register"]>> | undefined;
    try {
      const identity = trustedIdentity(request, context);
      if (!identity) {
        throw new Error("AgentScope runs require trusted user and space context");
      }
      if (request.tools.length > 0 || request.claimSteering || request.resolveModel) {
        bridgeRegistration = await this.toolBridge.register(request, context);
      }
      const response = await fetch(endpoint(this.baseUrl, "/v1/runs"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify(
          serializableRequest(
            request,
            bridgeRegistration,
            bridgeRegistration?.identity ?? identity,
          ),
        ),
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
      if (bridgeRegistration) this.toolBridge.unregister(request.runId);
      this.active.delete(request.runId);
    }
  }
}
