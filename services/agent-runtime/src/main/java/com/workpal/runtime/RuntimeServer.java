package com.workpal.runtime;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;

/** Private HTTP boundary used by the existing TypeScript AgentRuntime adapter. */
public final class RuntimeServer {
    private final ObjectMapper json = new ObjectMapper();
    private final String instanceId = java.util.UUID.randomUUID().toString();
    private final RuntimeEngine engine;
    private final ConcurrentHashMap<String, Thread> activeRuns = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, RunRequest.Identity> activeIdentities = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> activeSessions = new ConcurrentHashMap<>();
    private final Set<String> purgedBots = ConcurrentHashMap.newKeySet();
    private final Object stateLifecycle = new Object();
    private final HttpServer server;

    RuntimeServer(String host, int port, Path dataRoot) throws IOException {
        engine = new RuntimeEngine(json, dataRoot.resolve("state"), dataRoot.resolve("workspace"));
        server = HttpServer.create(new InetSocketAddress(host, port), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/health", this::health);
        server.createContext("/v1/runs", this::runs);
        server.createContext("/v1/state/bots", this::botState);
        server.createContext("/v1/background-tasks", this::backgroundTasks);
    }

    public void start() { server.start(); }
    public int port() { return server.getAddress().getPort(); }
    public void stop() { server.stop(0); }

    private void health(HttpExchange exchange) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) { reply(exchange, 405, Map.of("error", "method not allowed")); return; }
        reply(exchange, 200, Map.of("ok", true, "service", "workpal-agent-runtime",
                "version", "0.1.0", "agentscope", "2.0.3", "activeRuns", activeRuns.size(),
                "instanceId", instanceId));
    }

    private record BotStateRequest(String userId, String spaceId, String botId) {}

    private void backgroundTasks(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        if (!"DELETE".equals(exchange.getRequestMethod()) ||
                !path.startsWith("/v1/background-tasks/")) {
            reply(exchange, 404, Map.of("error", "not found")); return;
        }
        String taskId = path.substring("/v1/background-tasks/".length());
        if (!taskId.matches("task_[A-Za-z0-9_-]{8,100}")) {
            reply(exchange, 422, Map.of("error", "Invalid task ID")); return;
        }
        RunRequest.Identity identity;
        try {
            byte[] body = exchange.getRequestBody().readNBytes(8193);
            if (body.length > 8192) throw new IllegalArgumentException();
            identity = json.readValue(body, RunRequest.Identity.class);
            if (identity == null || RunRequest.blank(identity.userId()) ||
                    RunRequest.blank(identity.spaceId()) || RunRequest.blank(identity.botId()) ||
                    RunRequest.blank(identity.threadId()) || RunRequest.blank(identity.runId())) {
                throw new IllegalArgumentException();
            }
        } catch (Exception error) {
            reply(exchange, 422, Map.of("error", "Invalid task identity")); return;
        }
        boolean cancelled = engine.cancelTask(identity, taskId);
        reply(exchange, cancelled ? 200 : 404, Map.of("cancelled", cancelled));
    }

    private void botState(HttpExchange exchange) throws IOException {
        if (!"DELETE".equals(exchange.getRequestMethod())) {
            reply(exchange, 405, Map.of("error", "method not allowed")); return;
        }
        BotStateRequest request;
        try {
            byte[] body = exchange.getRequestBody().readNBytes(8193);
            if (body.length > 8192) throw new IllegalArgumentException("State request is too large");
            request = json.readValue(body, BotStateRequest.class);
            if (request == null || RunRequest.blank(request.userId())
                    || RunRequest.blank(request.spaceId()) || RunRequest.blank(request.botId())) {
                throw new IllegalArgumentException("A user, space and bot are required");
            }
        } catch (Exception error) {
            reply(exchange, 422, Map.of("error", "Invalid state request")); return;
        }
        synchronized (stateLifecycle) {
            boolean busy = activeIdentities.values().stream().anyMatch(identity ->
                    request.userId().equals(identity.userId()) && request.spaceId().equals(identity.spaceId())
                            && request.botId().equals(identity.botId()));
            if (busy) { reply(exchange, 409, Map.of("error", "Bot has an active run")); return; }
            try {
                engine.purgeBot(request.userId(), request.spaceId(), request.botId());
                purgedBots.add(botSlot(request.userId(), request.spaceId(), request.botId()));
                reply(exchange, 200, Map.of("ok", true));
            } catch (Exception error) {
                reply(exchange, 500, Map.of("error", "Cannot purge AgentScope state"));
            }
        }
    }

    private void runs(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        if ("DELETE".equals(exchange.getRequestMethod()) && path.startsWith("/v1/runs/")) {
            String runId = path.substring("/v1/runs/".length());
            Thread active = activeRuns.get(runId);
            if (active != null) {
                engine.cancel(runId);
                active.interrupt();
            }
            reply(exchange, 200, Map.of("ok", true, "cancelled", active != null));
            return;
        }
        if (!"POST".equals(exchange.getRequestMethod()) || !"/v1/runs".equals(path)) {
            reply(exchange, 404, Map.of("error", "not found"));
            return;
        }
        RunRequest request;
        try {
            byte[] body = exchange.getRequestBody().readNBytes(64 * 1024 * 1024 + 1);
            if (body.length > 64 * 1024 * 1024) throw new IllegalArgumentException("Run request is too large");
            request = json.readValue(body, RunRequest.class);
            request.validate();
        } catch (Exception e) {
            reply(exchange, 422, Map.of("error", e instanceof IllegalArgumentException ? e.getMessage() : "Invalid run request"));
            return;
        }
        String slot = request.identity().userId() + "\u0000" + request.identity().spaceId()
                + "\u0000" + request.botId() + "\u0000" + request.threadId() + "\u0000" + request.generation()
                + "\u0000" + request.scope() + (request.isChat() ? "" : "\u0000" + request.runId());
        synchronized (stateLifecycle) {
            if (purgedBots.contains(botSlot(request.identity().userId(), request.identity().spaceId(), request.botId()))) {
                reply(exchange, 410, Map.of("error", "Bot runtime state was purged")); return;
            }
            if (activeRuns.putIfAbsent(request.runId(), Thread.currentThread()) != null) {
                reply(exchange, 409, Map.of("error", "Run is already active")); return;
            }
            activeIdentities.put(request.runId(), request.identity());
            if (activeSessions.putIfAbsent(slot, request.runId()) != null) {
                activeRuns.remove(request.runId());
                activeIdentities.remove(request.runId());
                reply(exchange, 409, Map.of("error", "Session already has an active run")); return;
            }
        }
        exchange.getResponseHeaders().set("content-type", "application/x-ndjson");
        exchange.getResponseHeaders().set("cache-control", "no-store");
        exchange.getResponseHeaders().set("x-agent-runtime-instance", instanceId);
        exchange.sendResponseHeaders(200, 0);
        try (var output = exchange.getResponseBody()) {
            RuntimeEngine.EventSink sink = event -> {
                if (Thread.currentThread().isInterrupted()) throw new IOException("Run cancelled");
                output.write(json.writeValueAsBytes(event));
                output.write('\n');
                output.flush();
            };
            try {
                engine.execute(request, sink);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            } catch (Exception error) {
                if (!Thread.currentThread().isInterrupted()) {
                    System.err.println("Agent runtime failure: " + error.getClass().getName());
                    for (int index = 0; index < Math.min(4, error.getStackTrace().length); index++) {
                        System.err.println("  at " + error.getStackTrace()[index]);
                    }
                    sink.emit(Map.of("type", "error", "message", safeError(error)));
                }
            }
        } finally {
            activeRuns.remove(request.runId(), Thread.currentThread());
            activeIdentities.remove(request.runId(), request.identity());
            activeSessions.remove(slot, request.runId());
            exchange.close();
        }
    }

    private static String safeError(Exception error) {
        // Provider and connector exceptions can contain credential-bearing URLs or headers.
        return "Agent execution failed";
    }

    private static String botSlot(String user, String space, String bot) {
        return user + "\u0000" + space + "\u0000" + bot;
    }

    private void reply(HttpExchange exchange, int status, Object value) throws IOException {
        byte[] body = json.writeValueAsBytes(value);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.getResponseHeaders().set("cache-control", "no-store");
        exchange.sendResponseHeaders(status, body.length);
        try (var output = exchange.getResponseBody()) { output.write(body); }
    }

    public static void main(String[] args) throws Exception {
        String host = System.getenv().getOrDefault("AGENT_RUNTIME_HOST", "127.0.0.1");
        int port = Integer.parseInt(System.getenv().getOrDefault("AGENT_RUNTIME_PORT",
                System.getenv().getOrDefault("AGENTSCOPE_PORT", "8090")));
        Path data = Path.of(System.getenv().getOrDefault("AGENT_RUNTIME_DATA_DIR", "data/agent-runtime"));
        RuntimeServer service = new RuntimeServer(host, port, data);
        Runtime.getRuntime().addShutdownHook(new Thread(service::stop));
        service.start();
    }
}
