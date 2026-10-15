package com.workpal.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

/**
 * AG-02: tool-result eviction boundary. AgentScope 2.0.3's native
 * {@code ToolResultEvictionMiddleware} offloads any non-excluded tool result whose text exceeds
 * 80,000 chars to {@code large_tool_results/} in the Java workspace and shows the model a
 * "saved to <path>, use read_file" pointer. WorkPal disables native filesystem tools and its
 * backend {@code read_file} reads the Bot computer (not the Java workspace), so that pointer is
 * unreadable. These tests drive the real {@link RuntimeEngine} and prove:
 * <ul>
 *   <li>the main agent (eviction disabled) leaves no offload file and no pointer;</li>
 *   <li>a declared leaf helper — which cannot be configured through AgentScope's public API —
 *       also produces no pointer, because {@code resultBlock} bounds non-excluded tool text
 *       below the eviction threshold;</li>
 *   <li>an excluded tool ({@code read_file}) is never capped or evicted, preserving the
 *       backend's own sizing.</li>
 * </ul>
 */
class ToolResultEvictionBoundaryTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    /** Eviction placeholder text (ToolResultEvictionMiddleware.buildPlaceholder). */
    private static final String EVICTION_PLACEHOLDER = "Tool output was too large";
    /** Compaction offload pointer text (ConversationCompactor.buildSummaryMessage, offload enabled). */
    private static final String COMPACTION_POINTER = "full conversation history has been saved to";
    private static final String CAP_MARKER = "tool result truncated from";
    private static final String BIG = "X".repeat(100_000);
    /**
     * Production models report large context windows. These eviction tests use a realistic
     * large window so a single (capped) tool result stays well under the derived compaction
     * token trigger and the test isolates eviction behavior. The small-window helper-compaction
     * interaction is a separate, API-blocked gap documented in the delivery note.
     */
    private static final int PROD_CONTEXT_WINDOW = 200_000;

    @TempDir Path temp;

    @Test void mainAgentLargeToolResultStaysInlineWithoutEvictionPointer() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        HttpServer model = toolThenDoneModel(requests, "big_tool", "BIG_MAIN_RESULT");
        HttpServer bridge = bridgeReturning("BIG_MAIN_RESULT " + BIG);
        try {
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"));
            List<Map<String, Object>> events = new ArrayList<>();
            engine.execute(request(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "evict-main", "big_tool"), events::add);
            assertEquals("done", events.getLast().get("type"));

            // No native offload artifact and no dangling pointer reaches the model.
            assertTrue(filesNamed("large_tool_results").isEmpty(),
                    "eviction must not write large_tool_results: " + filesNamed("large_tool_results"));
            assertFalse(anyMessageContains(requests, EVICTION_PLACEHOLDER),
                    "no eviction placeholder may reach the model");
            assertFalse(anyMessageContains(requests, "large_tool_results"),
                    "no eviction path may reach the model");
            // The non-excluded result is bounded and honest, not silently dropped or pointed away.
            assertTrue(anyMessageContains(requests, CAP_MARKER),
                    "a non-excluded oversized result must be truncated with an inline marker");
            assertFalse(anyMessageContains(requests, "X".repeat(80_000)),
                    "the full oversized result must not remain inline");
            assertTrue(anyMessageContains(requests, "BIG_MAIN_RESULT"),
                    "the readable head of the result must remain");
        } finally { bridge.stop(0); model.stop(0); }
    }

    @Test void declaredHelperLargeToolResultProducesNoEvictionPointer() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        HttpServer model = helperModel(requests, "big_tool", "BIG_HELPER_RESULT");
        HttpServer bridge = helperBridgeReturning("BIG_HELPER_RESULT " + BIG);
        try {
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"));
            List<Map<String, Object>> events = new ArrayList<>();
            engine.execute(helperRequest(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "evict-helper"), events::add);
            Thread.sleep(400);
            assertEquals("done", events.getLast().get("type"));

            // The helper's own eviction cannot be disabled via AgentScope's public API, so the
            // resultBlock bound is what keeps its oversized result below the 80k eviction
            // threshold. Under a production-like window the capped result also stays under the
            // helper's derived compaction trigger, so neither pointer nor offload file appears.
            assertFalse(anyMessageContains(requests, EVICTION_PLACEHOLDER),
                    "no eviction placeholder may reach the helper or parent model");
            assertTrue(filesNamed("large_tool_results").isEmpty(),
                    "helper eviction must not write large_tool_results: " + filesNamed("large_tool_results"));
            assertTrue(anyMessageContains(requests, CAP_MARKER),
                    "the helper's oversized non-excluded result must be bounded inline");
        } finally { bridge.stop(0); model.stop(0); }
    }

    @Test void excludedReadFileResultIsNeitherCappedNorEvicted() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        HttpServer model = toolThenDoneModel(requests, "read_file", "BIG_READ_RESULT");
        HttpServer bridge = bridgeReturning("BIG_READ_RESULT " + BIG);
        try {
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"));
            List<Map<String, Object>> events = new ArrayList<>();
            engine.execute(request(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "evict-read", "read_file"), events::add);
            assertEquals("done", events.getLast().get("type"));

            // read_file is on AgentScope's eviction exclusion list, so it is never evicted; the
            // WorkPal cap must also leave it untouched to preserve the backend's own sizing.
            assertTrue(filesNamed("large_tool_results").isEmpty(), "read_file must not be evicted");
            assertFalse(anyMessageContains(requests, EVICTION_PLACEHOLDER), "read_file must not produce a pointer");
            assertFalse(anyMessageContains(requests, CAP_MARKER),
                    "an excluded tool result must not be truncated by the WorkPal cap");
            assertTrue(anyMessageContains(requests, "X".repeat(80_000)),
                    "the full excluded-tool result must remain inline and readable");
        } finally { bridge.stop(0); model.stop(0); }
    }

    // ============================ fixtures ============================

    private List<Path> filesNamed(String dirFragment) {
        List<Path> out = new ArrayList<>();
        Path ws = temp.resolve("workspace");
        if (!Files.exists(ws)) return out;
        try (var walk = Files.walk(ws)) {
            walk.filter(Files::isRegularFile).filter(p -> p.toString().contains(dirFragment)).forEach(out::add);
        } catch (Exception e) { /* ignore */ }
        return out;
    }

    private static boolean anyMessageContains(List<JsonNode> requests, String needle) {
        for (JsonNode body : requests) {
            for (JsonNode message : body.path("messages")) {
                if (message.path("content").toString().contains(needle)) return true;
            }
        }
        return false;
    }

    /** Main-agent request carrying one authorized backend tool. */
    private static RunRequest request(int modelPort, int bridgePort, String runId, String toolName) {
        RunRequest.Identity id = new RunRequest.Identity("user-1", "space-1", "bot-1", "thread-1", runId);
        RunRequest.ToolBridge bridge = new RunRequest.ToolBridge(
                "http://127.0.0.1:" + bridgePort + "/v1/tool-executions", null, null, "bridge-secret", id);
        RunRequest.ToolDefinition tool = new RunRequest.ToolDefinition(toolName, "Returns a lot",
                Map.of("type", "object"), true);
        return new RunRequest("bot-1", "thread-1", runId, "chat", "message-1", id,
                "Call the tool.", "WorkPal", "Reply concisely.", List.of(), List.of(), List.of(),
                List.of(tool), bridge, model(modelPort), false, null, 0);
    }

    /** Chat request offering run_subagent + a read-only big_tool, with background-task endpoints. */
    private static RunRequest helperRequest(int modelPort, int bridgePort, String runId) {
        RunRequest.Identity id = new RunRequest.Identity("user-1", "space-1", "bot-1", "thread-1", runId);
        String origin = "http://127.0.0.1:" + bridgePort;
        RunRequest.ToolBridge bridge = new RunRequest.ToolBridge(origin + "/v1/tool-executions",
                null, null, origin + "/v1/background-tasks", origin + "/v1/background-tasks/events",
                "bridge-secret", id);
        return new RunRequest("bot-1", "thread-1", runId, "chat", "message-1", id,
                "Delegate to helper.", "WorkPal", "Reply concisely.", List.of(), List.of(), List.of(),
                List.of(new RunRequest.ToolDefinition("run_subagent", "Delegate", Map.of("type", "object"), true),
                        new RunRequest.ToolDefinition("big_tool", "Big", Map.of("type", "object"), true)),
                bridge, model(modelPort), false, null, 0);
    }

    private static RunRequest.RunModel model(int port) {
        return new RunRequest.RunModel("local", "fixture", "test-key",
                "http://127.0.0.1:" + port + "/v1", false, 200, PROD_CONTEXT_WINDOW, null, null);
    }

    /** Model that calls `tool` once (recognizing `resultMarker` to then finish). */
    private static HttpServer toolThenDoneModel(List<JsonNode> requests, String tool, String resultMarker)
            throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/v1/chat/completions", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            requests.add(body);
            if (body.path("messages").toString().contains(resultMarker)) streamText(exchange, null, null, "DONE_AFTER_TOOL");
            else streamText(exchange, tool, "{\"a\":1}", null);
        });
        server.start();
        return server;
    }

    /** Parent spawns helper; helper calls `tool`; parent finishes after the helper result returns. */
    private static HttpServer helperModel(List<JsonNode> requests, String tool, String resultMarker)
            throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/v1/chat/completions", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            requests.add(body);
            String all = body.path("messages").toString();
            boolean child = all.contains("HELPER_EVICT_TASK");
            if (child && !all.contains(resultMarker)) streamText(exchange, tool, "{\"a\":1}", null);
            else if (child) streamText(exchange, null, null, "CHILD_DONE");
            else if (all.contains("task_id:") || all.contains("CHILD_DONE")) streamText(exchange, null, null, "PARENT_DONE");
            else streamText(exchange, "agent_spawn",
                    "{\"agent_id\":\"helper\",\"task\":\"HELPER_EVICT_TASK\",\"background\":true}", null);
        });
        server.start();
        return server;
    }

    private static HttpServer bridgeReturning(String text) throws Exception {
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/tool-executions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            respond(exchange, JSON.writeValueAsBytes(Map.of("status", "ok", "result",
                    Map.of("kind", "agent_tool_result", "content",
                            List.of(Map.of("type", "text", "text", text))))));
        });
        bridge.start();
        return bridge;
    }

    private static HttpServer helperBridgeReturning(String text) throws Exception {
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/background-tasks/events", ex -> respond(ex, "{\"ok\":true}".getBytes(StandardCharsets.UTF_8)));
        bridge.createContext("/v1/background-tasks", ex -> respond(ex, "{\"token\":\"task-secret\"}".getBytes(StandardCharsets.UTF_8)));
        bridge.createContext("/v1/tool-executions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            respond(exchange, JSON.writeValueAsBytes(Map.of("status", "ok", "result",
                    Map.of("kind", "agent_tool_result", "content",
                            List.of(Map.of("type", "text", "text", text))))));
        });
        bridge.start();
        return bridge;
    }

    private static void respond(HttpExchange ex, byte[] body) throws java.io.IOException {
        ex.getResponseHeaders().set("content-type", "application/json");
        ex.sendResponseHeaders(200, body.length);
        try (var o = ex.getResponseBody()) { o.write(body); }
    }

    private static void streamText(HttpExchange ex, String tool, String args, String text)
            throws java.io.IOException {
        Map<String, Object> delta = new HashMap<>();
        delta.put("role", "assistant");
        if (tool != null) delta.put("tool_calls", List.of(Map.of("index", 0, "id", "call-1",
                "type", "function", "function", Map.of("name", tool, "arguments", args))));
        else delta.put("content", text);
        Map<String, Object> first = new HashMap<>();
        first.put("index", 0); first.put("delta", delta); first.put("finish_reason", null);
        String p = "{\"id\":\"f\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"fixture\",\"choices\":";
        byte[] s = ("data: " + p + JSON.writeValueAsString(List.of(first)) + "}\n\n"
                + "data: " + p + JSON.writeValueAsString(List.of(Map.of("index", 0, "delta", Map.of(),
                "finish_reason", tool == null ? "stop" : "tool_calls"))) + "}\n\n"
                + "data: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("content-type", "text/event-stream");
        ex.sendResponseHeaders(200, 0);
        try (var o = ex.getResponseBody()) { o.write(s); o.flush(); }
    }
}
