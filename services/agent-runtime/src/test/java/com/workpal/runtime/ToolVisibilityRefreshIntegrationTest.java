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
 * AG-05: the locked AgentScope 2.0.3 jar refreshes model-visible tools on
 * every provider HTTP call inside one Run. The model is a local protocol
 * fixture; this proves construction and execution, not injection resistance.
 */
class ToolVisibilityRefreshIntegrationTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir Path temp;

    @Test void sameRunRefreshesToolsAcrossThreeModelCallsIncludingSchemaChange() throws Exception {
        List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
        List<JsonNode> toolCalls = new CopyOnWriteArrayList<>();
        List<JsonNode> surfaceRequests = new CopyOnWriteArrayList<>();
        AtomicInteger surfaceRound = new AtomicInteger();
        HttpServer model = scriptedModel(modelRequests, List.of(
                new ToolStep("keep_tool", "{}"),
                new ToolStep("keep_tool", "{}"),
                new ToolStep("flip_tool", "{\"mode\":\"restored\"}")));
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/tool-surface", exchange -> {
            surfaceRequests.add(JSON.readTree(exchange.getRequestBody()));
            int round = surfaceRound.getAndIncrement();
            List<RunRequest.ToolDefinition> tools = round == 0
                    ? List.of(keepTool(), flipTool("v1"))
                    : round == 1 ? List.of(keepTool()) : List.of(keepTool(), flipTool("v2"));
            writeJson(exchange, Map.of("tools", tools.stream().map(this::wireTool).toList()));
        });
        bridge.createContext("/v1/tool-executions", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            toolCalls.add(body);
            writeJson(exchange, Map.of("status", "ok", "result", Map.of(
                    "kind", "agent_tool_result",
                    "content", List.of(Map.of("type", "text", "text", body.path("name").asText() + " ok")))));
        });
        bridge.start();
        try {
            RunRequest.Identity identity = new RunRequest.Identity(
                    "user-1", "space-1", "bot-1", "thread-1", "run-surface");
            RunRequest.ToolBridge endpoint = new RunRequest.ToolBridge(
                    "http://127.0.0.1:" + bridge.getAddress().getPort() + "/v1/tool-executions",
                    null, null, "bridge-secret", identity);
            RunRequest request = request(model.getAddress().getPort(), "run-surface",
                    List.of(keepTool(), flipTool("v1")), endpoint);
            List<Map<String, Object>> events = new ArrayList<>();
            new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"))
                    .execute(request, events::add);
            assertEquals("done", events.getLast().get("type"));
            assertTrue(modelRequests.size() >= 3, modelRequests.toString());
            assertEquals(modelRequests.size(), surfaceRequests.size(),
                    "every model call must consult the live surface");
            assertEquals(List.of("keep_tool", "flip_tool"), toolNames(modelRequests.get(0)));
            assertEquals(List.of("keep_tool"), toolNames(modelRequests.get(1)));
            assertEquals(List.of("keep_tool", "flip_tool"), toolNames(modelRequests.get(2)));
            assertFalse(schemaOf(modelRequests.get(0), "flip_tool").toString().contains("mode"));
            assertTrue(schemaOf(modelRequests.get(2), "flip_tool").toString().contains("mode"),
                    "re-authorized tool must publish the current schema, not the start-of-run copy");
            assertEquals(List.of("keep_tool", "keep_tool", "flip_tool"),
                    toolCalls.stream().map(call -> call.path("name").asText()).toList());
            assertTrue(events.stream().anyMatch(event ->
                    "tool".equals(event.get("type")) && "flip_tool".equals(event.get("name"))));
        } finally {
            bridge.stop(0);
            model.stop(0);
        }
    }

    @Test void hallucinatedRevokedToolIsRefusedWithoutProviderExecution() throws Exception {
        List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
        List<JsonNode> toolCalls = new CopyOnWriteArrayList<>();
        AtomicInteger surfaceRound = new AtomicInteger();
        HttpServer model = scriptedModel(modelRequests, List.of(
                new ToolStep("keep_tool", "{}"),
                new ToolStep("flip_tool", "{}")));
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/tool-surface", exchange -> {
            exchange.getRequestBody().readAllBytes();
            int round = surfaceRound.getAndIncrement();
            List<RunRequest.ToolDefinition> tools = round == 0
                    ? List.of(keepTool(), flipTool("v1")) : List.of(keepTool());
            writeJson(exchange, Map.of("tools", tools.stream().map(this::wireTool).toList()));
        });
        bridge.createContext("/v1/tool-executions", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            toolCalls.add(body);
            writeJson(exchange, Map.of("status", "ok", "result", Map.of(
                    "kind", "agent_tool_result",
                    "content", List.of(Map.of("type", "text", "text", "keep ok")))));
        });
        bridge.start();
        try {
            RunRequest.Identity identity = new RunRequest.Identity(
                    "user-1", "space-1", "bot-1", "thread-1", "run-refuse");
            RunRequest.ToolBridge endpoint = new RunRequest.ToolBridge(
                    "http://127.0.0.1:" + bridge.getAddress().getPort() + "/v1/tool-executions",
                    null, null, "bridge-secret", identity);
            RunRequest request = request(model.getAddress().getPort(), "run-refuse",
                    List.of(keepTool(), flipTool("v1")), endpoint);
            List<Map<String, Object>> events = new ArrayList<>();
            Exception failure = null;
            try {
                new RuntimeEngine(JSON, temp.resolve("refuse-state"), temp.resolve("refuse-workspace"))
                        .execute(request, events::add);
            } catch (Exception error) {
                failure = error;
            }
            assertTrue(modelRequests.size() >= 2, modelRequests.toString());
            assertFalse(toolNames(modelRequests.get(1)).contains("flip_tool"),
                    "revoked tool must leave the next model request: " + toolNames(modelRequests.get(1)));
            assertEquals(List.of("keep_tool"),
                    toolCalls.stream().map(call -> call.path("name").asText()).toList());
            boolean observed = (failure != null && String.valueOf(failure.getMessage()).contains("not allowed"))
                    || events.stream().anyMatch(event ->
                            String.valueOf(event).toLowerCase().contains("not allowed"))
                    || modelRequests.stream().skip(1).anyMatch(body ->
                            body.path("messages").toString().contains("not allowed"));
            assertTrue(observed, "revoked-tool refusal must be observable without a provider call: events="
                    + events + " failure=" + failure);
        } finally {
            bridge.stop(0);
            model.stop(0);
        }
    }

    @Test void twoRunsRefreshWithoutMixingToolSurfaces() throws Exception {
        List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
        HttpServer model = fakeTextModel(modelRequests);
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/tool-surface", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            String runId = body.path("runId").asText();
            RunRequest.ToolDefinition tool = "run-a".equals(runId)
                    ? namedTool("alpha_tool", "Alpha") : namedTool("beta_tool", "Beta");
            writeJson(exchange, Map.of("tools", List.of(wireTool(tool))));
        });
        bridge.createContext("/v1/tool-executions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            writeJson(exchange, Map.of("status", "ok", "result", Map.of("ok", true)));
        });
        bridge.start();
        try {
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("iso-state"), temp.resolve("iso-workspace"));
            RunRequest a = requestFor(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "run-a", "thread-a", "user-a", List.of(namedTool("alpha_tool", "Alpha")));
            RunRequest b = requestFor(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "run-b", "thread-b", "user-b", List.of(namedTool("beta_tool", "Beta")));
            List<Map<String, Object>> eventsA = new ArrayList<>();
            List<Map<String, Object>> eventsB = new ArrayList<>();
            Thread first = Thread.ofVirtual().start(() -> {
                try { engine.execute(a, eventsA::add); }
                catch (Exception error) { throw new RuntimeException(error); }
            });
            Thread second = Thread.ofVirtual().start(() -> {
                try { engine.execute(b, eventsB::add); }
                catch (Exception error) { throw new RuntimeException(error); }
            });
            first.join();
            second.join();
            assertEquals("done", eventsA.getLast().get("type"));
            assertEquals("done", eventsB.getLast().get("type"));
            List<JsonNode> aRequests = modelRequests.stream()
                    .filter(body -> toolNames(body).contains("alpha_tool")).toList();
            List<JsonNode> bRequests = modelRequests.stream()
                    .filter(body -> toolNames(body).contains("beta_tool")).toList();
            assertFalse(aRequests.isEmpty());
            assertFalse(bRequests.isEmpty());
            for (JsonNode body : aRequests) assertFalse(toolNames(body).contains("beta_tool"), body.toString());
            for (JsonNode body : bRequests) assertFalse(toolNames(body).contains("alpha_tool"), body.toString());
        } finally {
            bridge.stop(0);
            model.stop(0);
        }
    }

    @Test void failedSurfaceFetchKeepsThePreviousAllowList() throws Exception {
        List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
        AtomicInteger surfaceRound = new AtomicInteger();
        HttpServer model = scriptedModel(modelRequests, List.of(new ToolStep("keep_tool", "{}")));
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/tool-surface", exchange -> {
            exchange.getRequestBody().readAllBytes();
            int round = surfaceRound.getAndIncrement();
            if (round == 0) {
                writeJson(exchange, Map.of("tools", List.of(wireTool(keepTool()), wireTool(flipTool("v1")))));
                return;
            }
            byte[] body = "{\"error\":\"unavailable\"}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", "application/json");
            exchange.sendResponseHeaders(500, body.length);
            try (var output = exchange.getResponseBody()) { output.write(body); }
        });
        bridge.createContext("/v1/tool-executions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            writeJson(exchange, Map.of("status", "ok", "result", Map.of(
                    "kind", "agent_tool_result",
                    "content", List.of(Map.of("type", "text", "text", "keep ok")))));
        });
        bridge.start();
        try {
            RunRequest.Identity identity = new RunRequest.Identity(
                    "user-1", "space-1", "bot-1", "thread-1", "run-failclosed");
            RunRequest.ToolBridge endpoint = new RunRequest.ToolBridge(
                    "http://127.0.0.1:" + bridge.getAddress().getPort() + "/v1/tool-executions",
                    null, null, "bridge-secret", identity);
            List<Map<String, Object>> events = new ArrayList<>();
            new RuntimeEngine(JSON, temp.resolve("fail-state"), temp.resolve("fail-workspace"))
                    .execute(request(model.getAddress().getPort(), "run-failclosed",
                            List.of(keepTool(), flipTool("v1")), endpoint), events::add);
            assertEquals("done", events.getLast().get("type"));
            assertTrue(modelRequests.size() >= 2, modelRequests.toString());
            assertEquals(List.of("keep_tool", "flip_tool"), toolNames(modelRequests.get(0)));
            assertEquals(List.of("keep_tool", "flip_tool"), toolNames(modelRequests.get(1)),
                    "a failed refresh must not drop the previous allow-list");
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
        return namedTool("keep_tool", "Always available");
    }

    private static RunRequest.ToolDefinition flipTool(String version) {
        Map<String, Object> properties = new LinkedHashMap<>();
        if ("v2".equals(version)) properties.put("mode", Map.of("type", "string"));
        return new RunRequest.ToolDefinition("flip_tool", "Flip " + version,
                Map.of("type", "object", "properties", properties), true);
    }

    private static RunRequest.ToolDefinition namedTool(String name, String description) {
        return new RunRequest.ToolDefinition(name, description,
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

    private static JsonNode schemaOf(JsonNode body, String name) {
        for (JsonNode tool : body.path("tools")) {
            String candidate = tool.path("function").path("name").asText("");
            if (name.equals(candidate) || name.equals(tool.path("name").asText())) return tool;
        }
        return JSON.missingNode();
    }

    private static void writeJson(HttpExchange exchange, Object payload) throws java.io.IOException {
        byte[] body = JSON.writeValueAsBytes(payload);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(200, body.length);
        try (var output = exchange.getResponseBody()) { output.write(body); }
    }

    private static RunRequest request(int modelPort, String runId,
            List<RunRequest.ToolDefinition> tools, RunRequest.ToolBridge bridge) {
        return requestFor(modelPort, 0, runId, "thread-1", "user-1", tools, bridge);
    }

    private static RunRequest requestFor(int modelPort, int bridgePort, String runId, String thread,
            String user, List<RunRequest.ToolDefinition> tools) {
        RunRequest.Identity identity = new RunRequest.Identity(user, "space-1", "bot-1", thread, runId);
        RunRequest.ToolBridge bridge = new RunRequest.ToolBridge(
                "http://127.0.0.1:" + bridgePort + "/v1/tool-executions",
                null, null, "bridge-secret", identity);
        return requestFor(modelPort, bridgePort, runId, thread, user, tools, bridge);
    }

    private static RunRequest requestFor(int modelPort, int ignoredBridgePort, String runId, String thread,
            String user, List<RunRequest.ToolDefinition> tools, RunRequest.ToolBridge bridge) {
        return new RunRequest("bot-1", thread, runId, "chat", "message-1",
                new RunRequest.Identity(user, "space-1", "bot-1", thread, runId),
                "Use the live tools.", "WorkPal", "Reply concisely.", List.of(), List.of(), List.of(), tools, bridge,
                new RunRequest.RunModel("local", "fixture", "test-key", "http://127.0.0.1:" + modelPort + "/v1",
                        false, 200, 8192, null, null), false, null, 0);
    }

    private record ToolStep(String name, String arguments) {}

    private static HttpServer scriptedModel(List<JsonNode> requests, List<ToolStep> steps) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            requests.add(JSON.readTree(exchange.getRequestBody()));
            int index = requests.size() - 1;
            boolean tool = index < steps.size();
            Map<String, Object> delta = new LinkedHashMap<>();
            delta.put("role", "assistant");
            if (tool) {
                ToolStep step = steps.get(index);
                delta.put("tool_calls", List.of(Map.of("index", 0, "id", "call-" + index,
                        "type", "function", "function", Map.of("name", step.name(), "arguments", step.arguments()))));
            } else delta.put("content", "Completed by native Harness.");
            Map<String, Object> firstChoice = new LinkedHashMap<>();
            firstChoice.put("index", 0);
            firstChoice.put("delta", delta);
            firstChoice.put("finish_reason", null);
            Map<String, Object> lastChoice = Map.of("index", 0, "delta", Map.of(),
                    "finish_reason", tool ? "tool_calls" : "stop");
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

    private static HttpServer fakeTextModel(List<JsonNode> requests) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            requests.add(JSON.readTree(exchange.getRequestBody()));
            String first = "{\"id\":\"chatcmpl-text\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello from Java Harness.\"},\"finish_reason\":null}]}";
            String finish = "{\"id\":\"chatcmpl-end\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}";
            byte[] stream = ("data: " + first + "\n\ndata: " + finish + "\n\ndata: [DONE]\n\n")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try (var output = exchange.getResponseBody()) { output.write(stream); }
        });
        server.start();
        return server;
    }
}
