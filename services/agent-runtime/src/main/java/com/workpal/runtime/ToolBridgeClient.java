package com.workpal.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** WorkPal's run-scoped backend remains the final tool authorization boundary. */
public final class ToolBridgeClient {
    private static final Set<String> TRUSTED_HOSTS = Set.of("127.0.0.1", "localhost", "::1", "api", "worker");
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final ObjectMapper json;
    private final RunRequest request;
    private final ConcurrentHashMap<String, CompletableFuture<TaskCredential>> taskCredentials = new ConcurrentHashMap<>();
    private final AtomicInteger pendingBackgroundSpawns = new AtomicInteger();
    private volatile boolean foregroundOpen = true;

    private record TaskCredential(String taskId, String agentId, String sessionId, String token) {}

    public ToolBridgeClient(ObjectMapper json, RunRequest request) {
        this.json = json;
        this.request = request;
    }

    public static void validateUrl(String raw) {
        try {
            URI uri = URI.create(raw);
            if (!"http".equals(uri.getScheme()) || !TRUSTED_HOSTS.contains(uri.getHost())
                    || uri.getUserInfo() != null || uri.getFragment() != null) {
                throw new IllegalArgumentException("Tool bridge URL is outside the trusted application network");
            }
        } catch (NullPointerException | IllegalArgumentException e) {
            throw new IllegalArgumentException("Tool bridge URL is outside the trusted application network");
        }
    }

    public ToolOutcome execute(String name, String executionId, Map<String, Object> args)
            throws IOException, InterruptedException {
        return execute(name, executionId, args, null);
    }

    public ToolOutcome execute(String name, String executionId, Map<String, Object> args,
            String childSession) throws IOException, InterruptedException {
        if (request.toolBridge() == null) throw new IllegalStateException("Tool bridge unavailable");
        boolean allowed = request.tools() != null && request.tools().stream().anyMatch(tool -> tool.name().equals(name));
        if (!allowed) throw new IllegalArgumentException("Tool is not allowed for this run");
        JsonNode response;
        if (childSession != null && !taskCredentials.containsKey(childSession)
                && pendingBackgroundSpawns.get() > 0) {
            taskCredentials.computeIfAbsent(childSession, ignored -> new CompletableFuture<>());
        }
        if (childSession == null || (childSession != null && !taskCredentials.containsKey(childSession))) {
            if (!foregroundOpen) throw new IOException("Foreground bridge is closed");
            response = post(request.toolBridge().url(), Map.of(
                    "runId", request.runId(), "name", name, "executionId", executionId, "args", args),
                    request.toolBridge().token());
        } else {
            TaskCredential credential;
            try {
                credential = taskCredentials.computeIfAbsent(childSession, ignored -> new CompletableFuture<>())
                        .get(30, TimeUnit.SECONDS);
            } catch (Exception error) {
                throw new IOException("Background task has no authorized bridge credential", error);
            }
            response = post(request.toolBridge().url(), Map.of(
                    "runId", request.runId(), "taskId", credential.taskId(),
                    "agentId", credential.agentId(), "sessionId", childSession,
                    "name", name, "executionId", executionId, "args", args), credential.token());
        }
        String status = response.path("status").asText("");
        if ("paused".equals(status)) return new ToolOutcome(true, null, null);
        if ("error".equals(status)) return new ToolOutcome(false, null, response.path("error").asText("Tool failed"));
        if (!"ok".equals(status)) throw new IOException("Malformed tool bridge result");
        return new ToolOutcome(false, response.get("result"), null);
    }

    public void expectBackgroundSpawn() { pendingBackgroundSpawns.incrementAndGet(); }
    public void finishBackgroundSpawn() { pendingBackgroundSpawns.updateAndGet(value -> Math.max(0, value - 1)); }
    public void closeForeground() { foregroundOpen = false; }

    public JsonNode claimSteering(Set<String> seenIds) throws IOException, InterruptedException {
        if (request.toolBridge() == null || request.toolBridge().steeringUrl() == null) return null;
        return post(request.toolBridge().steeringUrl(), Map.of("runId", request.runId(), "seenIds", seenIds),
                request.toolBridge().token());
    }

    public void registerTask(String taskId, String agentId, String childSession)
            throws IOException, InterruptedException {
        if (request.toolBridge() == null || request.toolBridge().taskUrl() == null) {
            throw new IOException("Background task bridge is unavailable");
        }
        CompletableFuture<TaskCredential> future = taskCredentials.computeIfAbsent(childSession,
                ignored -> new CompletableFuture<>());
        try {
            JsonNode response = post(request.toolBridge().taskUrl(), Map.of("runId", request.runId(),
                    "taskId", taskId, "agentId", agentId, "sessionId", childSession),
                    request.toolBridge().token());
            String token = response.path("token").asText("");
            if (token.isBlank()) throw new IOException("Background task credential is missing");
            future.complete(new TaskCredential(taskId, agentId, childSession, token));
        } catch (IOException | InterruptedException error) {
            future.completeExceptionally(error);
            throw error;
        }
    }

    public void publishTerminal(String taskId, String childSession, String status, String result)
            throws IOException, InterruptedException {
        if (request.toolBridge() == null || request.toolBridge().taskEventUrl() == null) return;
        TaskCredential credential = taskCredentials.get(childSession).getNow(null);
        if (credential == null || !credential.taskId().equals(taskId)) return;
        post(request.toolBridge().taskEventUrl(), Map.of("runId", request.runId(),
                "taskId", taskId, "status", status, "result", result == null ? "" : result),
                credential.token());
    }

    private JsonNode post(String url, Object body, String token) throws IOException, InterruptedException {
        validateUrl(url);
        HttpRequest call = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofMinutes(10))
                .header("authorization", "Bearer " + token)
                .header("content-type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
                .build();
        HttpResponse<String> response = client.send(call, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() / 100 != 2) {
            System.err.println("Tool bridge returned HTTP " + response.statusCode());
            throw new IOException("Tool bridge returned HTTP " + response.statusCode());
        }
        return json.readTree(response.body());
    }

    public record ToolOutcome(boolean paused, JsonNode result, String error) {}
}
