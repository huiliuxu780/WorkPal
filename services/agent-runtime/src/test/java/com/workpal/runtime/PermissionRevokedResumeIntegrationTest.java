package com.workpal.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

/**
 * AG-08: a pending tool call resumed after the tool left the live allow-list
 * must consume the call with a model-visible refusal so the next Run on the
 * same session can reach the model. The local fixture is not an injection test.
 */
class PermissionRevokedResumeIntegrationTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir Path temp;

    @Test void revokedPendingCallIsConsumedAndNextRunReachesTheModel() throws Exception {
        List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
        List<JsonNode> toolCalls = new CopyOnWriteArrayList<>();
        AtomicInteger executions = new AtomicInteger();
        HttpServer model = scriptedModel(modelRequests);
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/tool-surface", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            String runId = body.path("runId").asText();
            List<RunRequest.ToolDefinition> tools = "run-pending".equals(runId)
                    ? List.of(keepTool(), flipTool()) : List.of(keepTool());
            writeJson(exchange, 200, Map.of("tools", tools.stream().map(this::wireTool).toList()));
        });
        bridge.createContext("/v1/tool-executions", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            toolCalls.add(body);
            int round = executions.getAndIncrement();
            if (round == 0) {
                writeJson(exchange, 200, Map.of("status", "paused"));
                return;
            }
            writeJson(exchange, 200, Map.of(
                    "status", "error",
                    "error", "permission_revoked: Tool is not allowed for this run",
                    "executed", false));
        });
        bridge.start();
        try {
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"));
            RunRequest.ToolBridge endpoint = new RunRequest.ToolBridge(
                    "http://127.0.0.1:" + bridge.getAddress().getPort() + "/v1/tool-executions",
                    null, null, "bridge-secret",
                    new RunRequest.Identity("user-1", "space-1", "bot-1", "thread-1", "run-pending"));
            List<Map<String, Object>> paused = new ArrayList<>();
            engine.execute(request(model.getAddress().getPort(), "run-pending",
                    List.of(keepTool(), flipTool()), endpoint), paused::add);
            assertEquals("paused", paused.getLast().get("type"), paused.toString());
            assertEquals(1, modelRequests.size());
            assertEquals(List.of("flip_tool"),
                    toolCalls.stream().map(call -> call.path("name").asText()).toList());

            List<Map<String, Object>> resumed = new ArrayList<>();
            engine.execute(request(model.getAddress().getPort(), "run-resume",
                    List.of(keepTool()), endpoint), resumed::add);
            assertEquals("done", resumed.getLast().get("type"), resumed.toString());
            assertTrue(modelRequests.size() >= 2, modelRequests.toString());
            JsonNode refusal = modelRequests.get(1);
            assertTrue(refusal.path("messages").toString().contains("permission_revoked")
                    || refusal.path("messages").toString().contains("not allowed"),
                    refusal.toString());
            assertFalse(toolNames(refusal).contains("flip_tool"));
            assertEquals(2, toolCalls.size());
            assertEquals("flip_tool", toolCalls.get(1).path("name").asText());

            int afterResume = modelRequests.size();
            List<Map<String, Object>> next = new ArrayList<>();
            engine.execute(request(model.getAddress().getPort(), "run-next",
                    List.of(keepTool()), endpoint), next::add);
            assertEquals("done", next.getLast().get("type"), next.toString());
            assertTrue(modelRequests.size() > afterResume, "next Run must reach the model");
            assertEquals(2, toolCalls.size(), "refused call must not replay");
            for (JsonNode body : modelRequests.subList(afterResume, modelRequests.size())) {
                assertFalse(toolNames(body).contains("flip_tool"), body.toString());
            }
        } finally {
            bridge.stop(0);
            model.stop(0);
        }
    }

    private Map<String, Object> wireTool(RunRequest.ToolDefinition tool) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", tool.name());
        body.put("description", tool.description());
        body.put("inputSchema", tool.inputSchema());
        body.put("readOnly", tool.readOnly());
        return body;
    }

    private static RunRequest.ToolDefinition keepTool() {
        return new RunRequest.ToolDefinition("keep_tool", "Always available",
                Map.of("type", "object", "properties", Map.of()), true);
    }

    private static RunRequest.ToolDefinition flipTool() {
        return new RunRequest.ToolDefinition("flip_tool", "Flip",
                Map.of("type", "object", "properties", Map.of()), true);
    }

    private static List<String> toolNames(JsonNode body) {
        List<String> names = new ArrayList<>();
        for (JsonNode tool : body.path("tools")) {
            String name = tool.path("function").path("name").asText(null);
            if (name == null || name.isBlank()) name = tool.path("name").asText(null);
            if (name != null && !name.isBlank()) names.add(name);
        }
        names.removeIf(name -> List.of("plan_enter", "plan_write", "plan_exit",
                "load_skill_through_path").contains(name));
        return names;
    }

    private static void writeJson(HttpExchange exchange, int status, Object payload) throws java.io.IOException {
        byte[] body = JSON.writeValueAsBytes(payload);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, body.length);
        try (var output = exchange.getResponseBody()) { output.write(body); }
    }

    private static RunRequest request(int modelPort, String runId,
            List<RunRequest.ToolDefinition> tools, RunRequest.ToolBridge bridge) {
        RunRequest.Identity identity = new RunRequest.Identity(
                "user-1", "space-1", "bot-1", "thread-1", runId);
        RunRequest.ToolBridge bound = new RunRequest.ToolBridge(
                bridge.url(), bridge.steeringUrl(), bridge.modelUrl(), bridge.token(), identity);
        return new RunRequest("bot-1", "thread-1", runId, "chat", "message-1",
                identity, "Use the live tools.", "WorkPal", "Reply concisely.",
                List.of(), List.of(), List.of(), tools, bound,
                new RunRequest.RunModel("local", "fixture", "test-key",
                        "http://127.0.0.1:" + modelPort + "/v1",
                        false, 200, 8192, null, null), false, null, 0);
    }

    private static HttpServer scriptedModel(List<JsonNode> requests) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            requests.add(JSON.readTree(exchange.getRequestBody()));
            boolean first = requests.size() == 1;
            Map<String, Object> delta = new LinkedHashMap<>();
            delta.put("role", "assistant");
            if (first) {
                delta.put("tool_calls", List.of(Map.of("index", 0, "id", "call-flip",
                        "type", "function", "function", Map.of("name", "flip_tool", "arguments", "{}"))));
            } else delta.put("content", "Completed by native Harness.");
            Map<String, Object> firstChoice = new LinkedHashMap<>();
            firstChoice.put("index", 0);
            firstChoice.put("delta", delta);
            firstChoice.put("finish_reason", null);
            Map<String, Object> lastChoice = Map.of("index", 0, "delta", Map.of(),
                    "finish_reason", first ? "tool_calls" : "stop");
            String prefix = "{\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"fixture\",\"choices\":";
            byte[] stream = ("data: " + prefix + JSON.writeValueAsString(List.of(firstChoice)) + "}\n\n"
                    + "data: " + prefix + JSON.writeValueAsString(List.of(lastChoice)) + "}\n\n"
                    + "data: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try (var output = exchange.getResponseBody()) { output.write(stream); }
        });
        server.start();
        return server;
    }
}
