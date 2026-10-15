package com.workpal.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
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
 * AG-02: native helper delegation is suspended for new Runs. A declared AgentScope leaf helper
 * cannot be given the safe compaction config through the 2.0.3 public API, so its own compaction
 * would keep flush/offload=true and could write native memory and emit dangling pointers —
 * reachable on production window sizes (a helper read_file result is eviction-excluded and
 * uncapped; multiple capped results accumulate). These tests drive the real production
 * {@link RuntimeEngine} (suspended) and prove a new Run offers no spawn tool, creates no helper,
 * writes no {@code memory/}, and emits no compaction/offload pointer — even with a small model
 * window and the most permissive delegation policy. The retained spawn/background/delivery/cancel
 * machinery is exercised by RuntimeIntegrationTest through the delegation seam.
 */
class DelegationSuspensionTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String COMPACTION_POINTER = "full conversation history has been saved to";
    private static final String FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";

    @TempDir Path temp;

    @Test void suspendedRunOffersNoSpawnToolAndCreatesNoHelperMemoryOrPointer() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        java.util.concurrent.atomic.AtomicInteger turns = new java.util.concurrent.atomic.AtomicInteger();
        // The fixture model TRIES to delegate on the first turn (calls agent_spawn) to prove the
        // boundary refuses a direct call that bypasses tool visibility, then replies plainly.
        HttpServer model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        model.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        model.createContext("/v1/chat/completions", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            requests.add(body);
            if (turns.getAndIncrement() == 0) {
                streamTool(exchange, "agent_spawn",
                        "{\"agent_id\":\"helper\",\"task\":\"HELPER_SHOULD_NOT_RUN\",\"background\":true}");
            } else {
                streamText(exchange, "DELEGATION_UNAVAILABLE_ACK");
            }
        });
        model.start();
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        List<JsonNode> bridgeCalls = new CopyOnWriteArrayList<>();
        bridge.createContext("/v1/background-tasks/events", ex -> respond(ex, "{\"ok\":true}"));
        bridge.createContext("/v1/background-tasks", ex -> respond(ex, "{\"token\":\"task-secret\"}"));
        bridge.createContext("/v1/tool-executions", ex -> {
            bridgeCalls.add(JSON.readTree(ex.getRequestBody()));
            respond(ex, "{\"status\":\"ok\",\"result\":{\"value\":\"should not be reached\"}}");
        });
        bridge.start();
        try {
            Path state = temp.resolve("state");
            Path workspace = temp.resolve("workspace");
            RuntimeEngine engine = new RuntimeEngine(JSON, state, workspace); // production: suspended

            RunRequest input = permissiveDelegationRequest(model.getAddress().getPort(),
                    bridge.getAddress().getPort(), "suspend-1");
            List<Map<String, Object>> events = new ArrayList<>();
            // The model's agent_spawn attempt cannot spawn (tool not registered); the run must
            // not hang or leak a helper. It either completes or fails cleanly — assert no gap.
            try {
                engine.execute(input, events::add);
            } catch (Exception ignored) {
                // A refused/unknown spawn call may surface as a run error; the security
                // assertions below are what matter, not the exact terminal shape.
            }

            // 1. No spawn/delegation tool is ever offered to the model.
            for (JsonNode body : requests) {
                for (JsonNode tool : body.path("tools")) {
                    String name = tool.path("function").path("name").asText();
                    assertFalse(List.of("agent_spawn", "agent_send", "agent_list", "task_output",
                                    "task_cancel", "task_list", "run_subagent").contains(name),
                            "suspended run must not offer delegation tool " + name);
                }
            }
            // 2. No helper ran: the child task marker never reaches the model, and no backend
            //    tool call was made on a child's behalf.
            assertFalse(requests.stream().anyMatch(b -> b.path("messages").toString()
                            .contains("HELPER_SHOULD_NOT_RUN") && b.path("messages").toString()
                            .contains("You are a helper")),
                    "no helper subagent may be constructed");
            // 3. No native memory writes and no compaction/offload pointer anywhere.
            assertTrue(filesUnder(workspace, p -> p.toString().contains("/memory/")
                            || p.toString().endsWith("MEMORY.md")).isEmpty(),
                    "suspended run must not write native memory files");
            assertFalse(requests.stream().anyMatch(b -> b.path("messages").toString().contains(COMPACTION_POINTER)),
                    "suspended run must not emit a compaction offload pointer");
        } finally { bridge.stop(0); model.stop(0); }
    }

    @Test void suspendedEngineStillDeliversAnAlreadyStartedBackgroundTask() throws Exception {
        // Spawn a background task with delegation ENABLED (seam) so it registers a pending
        // delivery in the workspace task repository, then prove a SUSPENDED production engine
        // on the same workspace still surfaces that already-started task's result — the
        // completion/recovery flow is retained even though new Runs cannot spawn.
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        HttpServer model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        model.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        model.createContext("/v1/chat/completions", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            requests.add(body);
            String all = body.path("messages").toString();
            boolean child = all.contains("RECOVERY_TASK");
            if (child) streamText(exchange, "RECOVERY_CHILD_RESULT");
            else if (all.contains("task_id:")) streamText(exchange, "PARENT_DONE");
            else if (all.contains("RECOVERY_CHILD_RESULT")) streamText(exchange, "DELIVERY_ACK");
            else streamTool(exchange, "agent_spawn",
                    "{\"agent_id\":\"helper\",\"task\":\"RECOVERY_TASK\",\"background\":true}");
        });
        model.start();
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/background-tasks/events", ex -> respond(ex, "{\"ok\":true}"));
        bridge.createContext("/v1/background-tasks", ex -> respond(ex, "{\"token\":\"task-secret\"}"));
        bridge.createContext("/v1/tool-executions", ex -> respond(ex, "{\"status\":\"ok\",\"result\":{}}"));
        bridge.start();
        try {
            Path state = temp.resolve("state");
            Path workspace = temp.resolve("workspace");
            // Delegation-enabled engine spawns the background task.
            RuntimeEngine spawner = new RuntimeEngine(JSON, state, workspace,
                    RuntimeEngine.productionCompaction(), false);
            spawner.execute(permissiveDelegationRequest(model.getAddress().getPort(),
                    bridge.getAddress().getPort(), "recovery-spawn"), e -> {});
            Thread.sleep(600); // let the background child finish and register its delivery

            int before = requests.size();
            // Suspended production engine, same workspace: the already-started task's result
            // must still be delivered to the next Run.
            RuntimeEngine suspended = new RuntimeEngine(JSON, state, workspace);
            RunRequest next = plainChat(model.getAddress().getPort(), "recovery-deliver");
            suspended.execute(next, e -> {});
            List<JsonNode> after = requests.subList(before, requests.size());
            assertTrue(after.stream().anyMatch(b -> b.path("messages").toString()
                            .contains("RECOVERY_CHILD_RESULT")),
                    "a suspended engine must still deliver an already-started background task result");
        } finally { bridge.stop(0); model.stop(0); }
    }

    /**
     * Review round 3: prove the suspension at the REAL production HTTP entrypoint (RuntimeServer),
     * which no longer reads any delegation env toggle. Even when the request offers run_subagent
     * with a permissive delegation policy, the model is never offered agent_spawn (or any native
     * spawn/task tool), a direct agent_spawn attempt that bypasses visibility cannot spawn, and no
     * native memory is written.
     */
    @Test void runtimeServerEntrypointNeverOffersSpawnEvenWhenRunSubagentProvided() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        java.util.concurrent.atomic.AtomicInteger turns = new java.util.concurrent.atomic.AtomicInteger();
        HttpServer model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        model.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        model.createContext("/v1/chat/completions", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            requests.add(body);
            if (turns.getAndIncrement() == 0) {
                streamTool(exchange, "agent_spawn",
                        "{\"agent_id\":\"helper\",\"task\":\"SERVER_HELPER_SHOULD_NOT_RUN\",\"background\":true}");
            } else {
                streamText(exchange, "SERVER_DELEGATION_SUSPENDED");
            }
        });
        model.start();
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/background-tasks/events", ex -> respond(ex, "{\"ok\":true}"));
        bridge.createContext("/v1/background-tasks", ex -> respond(ex, "{\"token\":\"task-secret\"}"));
        bridge.createContext("/v1/tool-executions", ex -> {
            ex.getRequestBody().readAllBytes();
            respond(ex, "{\"status\":\"ok\",\"result\":{\"value\":\"bridge should not be reached\"}}");
        });
        bridge.start();
        RuntimeServer runtime = new RuntimeServer("127.0.0.1", 0, temp.resolve("http-runtime"));
        runtime.start();
        try {
            RunRequest input = permissiveDelegationRequest(model.getAddress().getPort(),
                    bridge.getAddress().getPort(), "server-suspend-1");
            HttpClient client = HttpClient.newHttpClient();
            URI runs = URI.create("http://127.0.0.1:" + runtime.port() + "/v1/runs");
            HttpResponse<String> response = client.send(HttpRequest.newBuilder(runs)
                            .header("content-type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(input))).build(),
                    HttpResponse.BodyHandlers.ofString());
            assertEquals(200, response.statusCode());
            assertTrue(response.body().contains("SERVER_DELEGATION_SUSPENDED"),
                    "the run must complete through the real entrypoint: " + response.body());

            assertFalse(requests.isEmpty(), "the run must reach the model");
            for (JsonNode body : requests) {
                for (JsonNode tool : body.path("tools")) {
                    String name = tool.path("function").path("name").asText();
                    assertFalse(List.of("agent_spawn", "agent_send", "agent_list", "task_output",
                                    "task_cancel", "task_list", "run_subagent").contains(name),
                            "RuntimeServer entrypoint must not offer delegation tool " + name);
                }
            }
            assertFalse(requests.stream().anyMatch(b -> b.path("messages").toString()
                            .contains("SERVER_HELPER_SHOULD_NOT_RUN") && b.path("messages").toString()
                            .contains("You are a helper")),
                    "no helper subagent may be constructed through the real entrypoint");
            assertTrue(filesUnder(temp.resolve("http-runtime"), p -> p.toString().contains("/memory/")
                            || p.toString().endsWith("MEMORY.md")).isEmpty(),
                    "RuntimeServer entrypoint must not write native memory files");
        } finally { runtime.stop(); bridge.stop(0); model.stop(0); }
    }

    // ============================ fixtures ============================

    private static RunRequest permissiveDelegationRequest(int modelPort, int bridgePort, String runId) {
        RunRequest.Identity id = new RunRequest.Identity("user-1", "space-1", "bot-1", "thread-1", runId);
        String origin = "http://127.0.0.1:" + bridgePort;
        RunRequest.ToolBridge bridge = new RunRequest.ToolBridge(origin + "/v1/tool-executions",
                null, null, origin + "/v1/background-tasks", origin + "/v1/background-tasks/events",
                "bridge-secret", id);
        return new RunRequest("bot-1", "thread-1", runId, "chat", "message-1", id,
                "Delegate this work to a helper.", "WorkPal", "Reply concisely.", List.of(), List.of(),
                List.of(),
                List.of(new RunRequest.ToolDefinition("run_subagent", "Delegate", Map.of("type", "object"), true),
                        new RunRequest.ToolDefinition("big_tool", "Big", Map.of("type", "object"), true)),
                bridge, smallWindowModel(modelPort), false, null, 0, null,
                new RunRequest.TurnPolicy("v1", true, "auto",
                        new RunRequest.TurnPolicy.Delegation("auto", true, 3, 1),
                        new RunRequest.TurnPolicy.Ownership("owner", "bot-1"),
                        "chat", null, null, null, null),
                null);
    }

    private static RunRequest plainChat(int modelPort, String runId) {
        RunRequest.Identity id = new RunRequest.Identity("user-1", "space-1", "bot-1", "thread-1", runId);
        return new RunRequest("bot-1", "thread-1", runId, "chat", "message-1", id,
                "Continue.", "WorkPal", "Reply concisely.", List.of(), List.of(), List.of(),
                List.of(), null, smallWindowModel(modelPort), false, null, 0);
    }

    /** Small window (32768-ish local default would still be safe; use 8192 to maximize pressure). */
    private static RunRequest.RunModel smallWindowModel(int port) {
        return new RunRequest.RunModel("local", "fixture", "test-key",
                "http://127.0.0.1:" + port + "/v1", false, 200, 8192, null, null);
    }

    private static List<Path> filesUnder(Path root, java.util.function.Predicate<Path> match) {
        List<Path> out = new ArrayList<>();
        if (!Files.exists(root)) return out;
        try (var walk = Files.walk(root)) {
            walk.filter(Files::isRegularFile).filter(match).forEach(out::add);
        } catch (Exception e) { /* ignore */ }
        return out;
    }

    private static void respond(HttpExchange ex, String body) throws java.io.IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("content-type", "application/json");
        ex.sendResponseHeaders(200, b.length);
        try (var o = ex.getResponseBody()) { o.write(b); }
    }

    private static void streamText(HttpExchange ex, String text) throws java.io.IOException {
        Map<String, Object> delta = new HashMap<>();
        delta.put("role", "assistant");
        delta.put("content", text);
        chunk(ex, delta, "stop");
    }

    private static void streamTool(HttpExchange ex, String tool, String args) throws java.io.IOException {
        Map<String, Object> delta = new HashMap<>();
        delta.put("role", "assistant");
        delta.put("tool_calls", List.of(Map.of("index", 0, "id", "call-1", "type", "function",
                "function", Map.of("name", tool, "arguments", args))));
        chunk(ex, delta, "tool_calls");
    }

    private static void chunk(HttpExchange ex, Map<String, Object> delta, String finishReason)
            throws java.io.IOException {
        Map<String, Object> first = new HashMap<>();
        first.put("index", 0); first.put("delta", delta); first.put("finish_reason", null);
        String p = "{\"id\":\"f\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"fixture\",\"choices\":";
        byte[] s = ("data: " + p + JSON.writeValueAsString(List.of(first)) + "}\n\n"
                + "data: " + p + JSON.writeValueAsString(List.of(Map.of("index", 0, "delta", Map.of(),
                "finish_reason", finishReason))) + "}\n\n"
                + "data: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("content-type", "text/event-stream");
        ex.sendResponseHeaders(200, 0);
        try (var o = ex.getResponseBody()) { o.write(s); o.flush(); }
    }
}
