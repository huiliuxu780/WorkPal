package com.workpal.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.HashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class RuntimeIntegrationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    @TempDir Path temp;

    @Test void streamsAndResumesSessionWithRealHarnessAgent() throws Exception {
        List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
        HttpServer model = fakeModel(modelRequests, false);
        try {
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"));
            List<Map<String, Object>> first = new ArrayList<>();
            engine.execute(request(model.getAddress().getPort(), "run-1", "user-1", "space-1", List.of(), null), first::add);
            assertTrue(first.stream().anyMatch(event -> "text".equals(event.get("type"))));
            assertEquals("Hello from Java Harness.", first.getLast().get("text"));

            List<Map<String, Object>> second = new ArrayList<>();
            engine.execute(request(model.getAddress().getPort(), "run-2", "user-1", "space-1", List.of(), null), second::add);
            assertEquals("done", second.getLast().get("type"));
            assertTrue(modelRequests.size() >= 2);
            assertTrue(modelRequests.getLast().path("messages").toString().contains("Hello from Java Harness."));
        } finally { model.stop(0); }
    }

    @Test void externalToolUsesTheAuthorizedBridgeAndReturnsToHarness() throws Exception {
        List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
        List<JsonNode> toolCalls = new CopyOnWriteArrayList<>();
        HttpServer model = fakeModel(modelRequests, true);
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/tool-executions", exchange -> {
            assertEquals("Bearer bridge-secret", exchange.getRequestHeaders().getFirst("authorization"));
            toolCalls.add(JSON.readTree(exchange.getRequestBody()));
            byte[] body = "{\"status\":\"ok\",\"result\":{\"kind\":\"agent_tool_result\",\"content\":[{\"type\":\"text\",\"text\":\"clock ok\"}]}}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (var output = exchange.getResponseBody()) { output.write(body); }
        });
        bridge.start();
        try {
            RunRequest.Identity identity = new RunRequest.Identity("user-1", "space-1", "bot-1", "thread-1", "run-tool");
            RunRequest.ToolBridge endpoint = new RunRequest.ToolBridge(
                    "http://127.0.0.1:" + bridge.getAddress().getPort() + "/v1/tool-executions",
                    null, null, "bridge-secret", identity);
            RunRequest.ToolDefinition tool = new RunRequest.ToolDefinition("test_clock", "Check the clock",
                    Map.of("type", "object", "properties", Map.of("timezone", Map.of("type", "string"))), true);
            RunRequest request = request(model.getAddress().getPort(), "run-tool", "user-1", "space-1", List.of(tool), endpoint);
            List<Map<String, Object>> events = new ArrayList<>();
            new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace")).execute(request, events::add);
            assertEquals("done", events.getLast().get("type"));
            assertTrue(events.stream().anyMatch(event -> "tool".equals(event.get("type"))));
            assertEquals("call-1", toolCalls.getFirst().path("executionId").asText());
            assertFalse(toolCalls.isEmpty());
            assertEquals("test_clock", toolCalls.getFirst().path("name").asText());
            assertTrue(modelRequests.getLast().path("messages").toString().contains("clock ok"));
        } finally { bridge.stop(0); model.stop(0); }
    }

    @Test void exposesOnlyTheCurrentRunsSkills() throws Exception {
        List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
        HttpServer model = scriptedModel(modelRequests,
                List.of(new ToolStep("load_skill_through_path",
                        "{\"skillId\":\"project-rules_workpal\",\"path\":\"SKILL.md\"}")));
        try {
            RunRequest base = request(model.getAddress().getPort(), "skill-1", "user-1", "space-1", List.of(), null);
            RunRequest allowed = new RunRequest(base.botId(), base.threadId(), base.runId(), base.executionScope(),
                    base.sourceMessageId(), base.identity(), base.prompt(), base.productName(), base.instructions(),
                    base.history(), base.currentTurnImages(),
                    List.of(new RunRequest.SkillDefinition("skill-1", "project-rules", "Project rules", "SKILL_PRIVATE_MARKER")),
                    base.tools(), base.toolBridge(), base.model(), base.allowSilentEmpty(), base.emptyResponseText(), base.sessionGeneration());
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"));
            engine.execute(allowed, event -> {});
            assertTrue(modelRequests.stream().anyMatch(message -> message.toString().contains("project-rules")));
            assertTrue(modelRequests.stream().anyMatch(message -> message.toString().contains("SKILL_PRIVATE_MARKER")));
            assertFalse(modelRequests.stream().anyMatch(message -> message.toString().contains("\"name\":\"web_fetch\"")
                    || message.toString().contains("\"name\":\"memory_save\"")));
            int beforeOtherUser = modelRequests.size();
            engine.execute(request(model.getAddress().getPort(), "skill-2", "user-2", "space-1", List.of(), null), event -> {});
            assertTrue(modelRequests.size() > beforeOtherUser);
            assertFalse(modelRequests.subList(beforeOtherUser, modelRequests.size()).stream()
                    .anyMatch(message -> message.toString().contains("project-rules")
                            || message.toString().contains("SKILL_PRIVATE_MARKER")));
        } finally { model.stop(0); }
    }

    @Test void nativePlanLifecyclePausesForApprovalAndResumes() throws Exception {
        List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
        HttpServer model = scriptedModel(modelRequests, List.of(
                new ToolStep("plan_enter", "{}"),
                new ToolStep("plan_write", "{\"content\":\"# Plan\\n1. Inspect\\n2. Execute\"}"),
                new ToolStep("plan_exit", "{\"summary\":\"Execute the plan\"}")));
        try {
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"));
            List<Map<String, Object>> first = new ArrayList<>();
            engine.execute(request(model.getAddress().getPort(), "plan-1", "user-1", "space-1", List.of(), null), first::add);
            assertTrue(first.stream().anyMatch(event -> "tool".equals(event.get("type")) && "plan_enter".equals(event.get("name"))));
            assertTrue(first.stream().anyMatch(event -> "tool".equals(event.get("type")) && "plan_write".equals(event.get("name"))));
            assertTrue(first.stream().anyMatch(event -> "ask".equals(event.get("type"))));
            assertEquals("paused", first.getLast().get("type"));
            RunRequest base = request(model.getAddress().getPort(), "plan-2", "user-1", "space-1", List.of(), null);
            RunRequest resume = new RunRequest(base.botId(), base.threadId(), base.runId(), base.executionScope(),
                    base.sourceMessageId(), base.identity(), "Original task with approval context", base.productName(), base.instructions(),
                    base.history(), base.currentTurnImages(), base.skills(), base.tools(), base.toolBridge(),
                    base.model(), base.allowSilentEmpty(), base.emptyResponseText(), base.sessionGeneration(), "approve");
            List<Map<String, Object>> second = new ArrayList<>();
            engine.execute(resume, second::add);
            assertEquals("done", second.getLast().get("type"));
            assertTrue(modelRequests.size() >= 4);
        } finally { model.stop(0); }
    }

    @Test void nativeSubagentReturnsItsResultToParent() throws Exception {
        List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
        List<JsonNode> toolCalls = new CopyOnWriteArrayList<>();
        HttpServer model = scriptedModel(modelRequests,
                List.of(new ToolStep("agent_spawn", "{\"agent_id\":\"helper\",\"task\":\"Inspect the fixture\",\"background\":true}"),
                        new ToolStep("test_clock", "{\"timezone\":\"UTC\"}")));
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/tool-executions", exchange -> {
            toolCalls.add(JSON.readTree(exchange.getRequestBody()));
            byte[] body = "{\"status\":\"ok\",\"result\":{\"value\":\"child tool result\"}}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (var output = exchange.getResponseBody()) { output.write(body); }
        });
        bridge.start();
        try {
            RunRequest base = request(model.getAddress().getPort(), "subagent-1", "user-1", "space-1", List.of(), null);
            RunRequest.Identity identity = base.identity();
            RunRequest.ToolBridge endpoint = new RunRequest.ToolBridge(
                    "http://127.0.0.1:" + bridge.getAddress().getPort() + "/v1/tool-executions",
                    null, null, "bridge-secret", identity);
            RunRequest.ToolDefinition delegation = new RunRequest.ToolDefinition("run_subagent",
                    "Delegate a short task", Map.of("type", "object"), true);
            RunRequest.ToolDefinition clock = new RunRequest.ToolDefinition("test_clock",
                    "Read the clock", Map.of("type", "object"), true);
            RunRequest request = new RunRequest(base.botId(), base.threadId(), base.runId(), base.executionScope(),
                    base.sourceMessageId(), identity, base.prompt(), base.productName(), base.instructions(),
                    base.history(), base.currentTurnImages(), base.skills(), List.of(delegation, clock), endpoint,
                    base.model(), base.allowSilentEmpty(), base.emptyResponseText(), base.sessionGeneration());
            List<Map<String, Object>> events = new ArrayList<>();
            new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace")).execute(request, events::add);
            assertEquals("done", events.getLast().get("type"));
            assertTrue(events.stream().anyMatch(event -> "tool".equals(event.get("type"))
                    && "agent_spawn".equals(event.get("name"))));
            assertTrue(modelRequests.size() >= 3);
            assertTrue(events.stream().anyMatch(event -> "subagent".equals(event.get("type"))));
            assertTrue(events.stream().anyMatch(event -> "subagent".equals(event.get("type"))
                    && "completed".equals(event.get("status"))), events.toString());
            assertFalse(toolCalls.isEmpty());
            assertEquals("test_clock", toolCalls.getFirst().path("name").asText());
            assertTrue(modelRequests.getLast().toString().contains("Completed by native Harness."));
        } finally { bridge.stop(0); model.stop(0); }
    }

    @Test void backgroundTaskCallsToolAfterParentEndsAndDeliversNextTurnReminder() throws Exception {
        CountDownLatch parentEnded = new CountDownLatch(1);
        CountDownLatch allowChildTool = new CountDownLatch(1);
        CountDownLatch backgroundEnded = new CountDownLatch(1);
        List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
        List<JsonNode> backgroundCalls = new CopyOnWriteArrayList<>();
        AtomicReference<String> taskId = new AtomicReference<>();
        AtomicBoolean nextTurn = new AtomicBoolean();
        HttpServer model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        model.createContext("/v1/chat/completions", exchange -> {
            JsonNode input = JSON.readTree(exchange.getRequestBody());
            modelRequests.add(input);
            String messages = input.path("messages").toString();
            boolean child = false;
            for (JsonNode message : input.path("messages")) {
                if ("user".equals(message.path("role").asText()) &&
                        message.path("content").toString().contains("BACKGROUND_CASE")) child = true;
            }
            try {
                if (child && !messages.contains("child tool result")) {
                    assertTrue(parentEnded.await(10, TimeUnit.SECONDS));
                    assertTrue(allowChildTool.await(10, TimeUnit.SECONDS));
                    modelReply(exchange, "test_clock", "{\"timezone\":\"UTC\"}", null);
                } else if (child) {
                    modelReply(exchange, null, null, "BACKGROUND_CHILD_RESULT");
                } else if (nextTurn.get()) {
                    modelReply(exchange, null, null, "REMINDER_ACK");
                } else if (messages.contains("task_id:")) {
                    modelReply(exchange, null, null, "PARENT_DONE");
                } else {
                    modelReply(exchange, "agent_spawn",
                            "{\"agent_id\":\"helper\",\"task\":\"BACKGROUND_CASE\",\"timeout_seconds\":0}", null);
                }
            } catch (Exception error) { exchange.close(); }
        });
        model.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        model.start();
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/background-tasks/events", exchange -> {
            assertEquals("Bearer task-secret", exchange.getRequestHeaders().getFirst("authorization"));
            JsonNode input = JSON.readTree(exchange.getRequestBody());
            assertEquals(taskId.get(), input.path("taskId").asText());
            assertEquals("completed", input.path("status").asText());
            assertTrue(input.path("result").asText().contains("BACKGROUND_CHILD_RESULT"));
            respond(bridgeBody("{\"ok\":true}"), exchange);
            backgroundEnded.countDown();
        });
        bridge.createContext("/v1/background-tasks", exchange -> {
            assertEquals("Bearer bridge-secret", exchange.getRequestHeaders().getFirst("authorization"));
            JsonNode input = JSON.readTree(exchange.getRequestBody());
            taskId.set(input.path("taskId").asText());
            assertEquals("helper", input.path("agentId").asText());
            respond(bridgeBody("{\"token\":\"task-secret\"}"), exchange);
        });
        bridge.createContext("/v1/tool-executions", exchange -> {
            JsonNode input = JSON.readTree(exchange.getRequestBody());
            if (input.has("taskId")) {
                assertEquals(0, parentEnded.getCount());
                assertEquals("Bearer task-secret", exchange.getRequestHeaders().getFirst("authorization"));
                backgroundCalls.add(input);
            }
            respond(bridgeBody("{\"status\":\"ok\",\"result\":{\"value\":\"child tool result\"}}"), exchange);
        });
        bridge.start();
        try {
            RunRequest base = request(model.getAddress().getPort(), "background-1", "user-1", "space-1", List.of(), null);
            String origin = "http://127.0.0.1:" + bridge.getAddress().getPort();
            RunRequest.ToolBridge endpoint = new RunRequest.ToolBridge(origin + "/v1/tool-executions",
                    null, null, origin + "/v1/background-tasks",
                    origin + "/v1/background-tasks/events", "bridge-secret", base.identity());
            RunRequest input = new RunRequest(base.botId(), base.threadId(), base.runId(), base.executionScope(),
                    base.sourceMessageId(), base.identity(), base.prompt(), base.productName(), base.instructions(),
                    base.history(), base.currentTurnImages(), base.skills(), List.of(
                        new RunRequest.ToolDefinition("run_subagent", "Delegate", Map.of("type", "object"), true),
                        new RunRequest.ToolDefinition("test_clock", "Clock", Map.of("type", "object"), true)),
                    endpoint, base.model(), base.allowSilentEmpty(), base.emptyResponseText(), base.sessionGeneration());
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"));
            List<Map<String, Object>> events = new ArrayList<>();
            engine.execute(input, events::add);
            assertEquals("done", events.getLast().get("type"));
            assertEquals("PARENT_DONE", events.getLast().get("text"));
            parentEnded.countDown();
            RunRequest concurrentBase = request(model.getAddress().getPort(), "background-concurrent",
                    "user-1", "space-1", List.of(), null);
            nextTurn.set(true);
            List<Map<String, Object>> concurrentEvents = new ArrayList<>();
            engine.execute(concurrentBase, concurrentEvents::add);
            assertEquals("done", concurrentEvents.getLast().get("type"));
            assertTrue(backgroundCalls.isEmpty(), "New main Run must coexist with the background task");
            allowChildTool.countDown();
            assertTrue(backgroundEnded.await(10, TimeUnit.SECONDS),
                    "task=" + taskId.get() + " modelRequests=" + modelRequests.size()
                            + " calls=" + backgroundCalls.size() + " events=" + events);
            assertFalse(backgroundCalls.isEmpty());
            String nativeRecord;
            Path nativeTaskPath;
            try (var files = java.nio.file.Files.walk(temp.resolve("workspace"))) {
                nativeTaskPath = files.filter(path -> path.toString().contains("/tasks/")
                                && path.toString().endsWith(".json"))
                        .findFirst().orElseThrow();
            }
            nativeRecord = java.nio.file.Files.readString(nativeTaskPath);
            assertTrue(nativeRecord.contains(taskId.get()), "TaskRepository did not persist the task");
            var nativeRepo = new io.agentscope.harness.agent.subagent.task.WorkspaceTaskRepository(
                    new io.agentscope.harness.agent.workspace.WorkspaceManager(
                            nativeTaskPath.getParent().getParent().getParent().getParent()),
                    JSON.readTree(nativeRecord).path(taskId.get()).path("parentAgentId").asText());
            String parentSession = JSON.readTree(nativeRecord).path(taskId.get()).path("parentSessionId").asText();
            var nativeContext = io.agentscope.core.agent.RuntimeContext.builder()
                    .userId("test").sessionId(parentSession).build();
            assertEquals(1, nativeRepo.findPendingDeliveries(nativeContext, parentSession).size());
            nativeRepo.shutdown();
            RunRequest baseNext = request(model.getAddress().getPort(), "background-2", "user-1", "space-1",
                    List.of(), null);
            RunRequest.ToolBridge nextBridge = new RunRequest.ToolBridge(origin + "/v1/tool-executions",
                    null, null, "bridge-secret", baseNext.identity());
            RunRequest next = new RunRequest(baseNext.botId(), baseNext.threadId(), baseNext.runId(),
                    baseNext.executionScope(), baseNext.sourceMessageId(), baseNext.identity(),
                    baseNext.prompt(), baseNext.productName(), baseNext.instructions(), baseNext.history(),
                    baseNext.currentTurnImages(), baseNext.skills(), List.of(
                        new RunRequest.ToolDefinition("run_subagent", "Delegate", Map.of("type", "object"), true)),
                    nextBridge, baseNext.model(), baseNext.allowSilentEmpty(),
                    baseNext.emptyResponseText(), baseNext.sessionGeneration());
            engine.execute(next, event -> {});
            assertTrue(modelRequests.getLast().path("messages").toString().contains("BACKGROUND_CHILD_RESULT"),
                    "The native TaskRepository reminder must enter the next main turn;"
                            + " nativeRecord=" + nativeRecord);
        } finally { parentEnded.countDown(); allowChildTool.countDown(); bridge.stop(0); model.stop(0); }
    }

    @Test void cancellingNativeBackgroundTaskStopsItsModelAndFutureToolCalls() throws Exception {
        CountDownLatch childStarted = new CountDownLatch(1);
        CountDownLatch releaseChild = new CountDownLatch(1);
        CountDownLatch cancelledEvent = new CountDownLatch(1);
        AtomicReference<String> taskId = new AtomicReference<>();
        List<JsonNode> calls = new CopyOnWriteArrayList<>();
        HttpServer model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        model.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        model.createContext("/v1/chat/completions", exchange -> {
            JsonNode input = JSON.readTree(exchange.getRequestBody());
            String messages = input.path("messages").toString();
            boolean child = false;
            for (JsonNode message : input.path("messages")) {
                if ("user".equals(message.path("role").asText()) &&
                        message.path("content").toString().contains("CANCEL_CASE")) child = true;
            }
            if (child) {
                childStarted.countDown();
                try { releaseChild.await(10, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
                modelReply(exchange, "test_clock", "{}", null);
            } else if (messages.contains("task_id:")) modelReply(exchange, null, null, "PARENT_DONE");
            else modelReply(exchange, "agent_spawn",
                    "{\"agent_id\":\"helper\",\"task\":\"CANCEL_CASE\",\"timeout_seconds\":0}", null);
        });
        model.start();
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/background-tasks/events", exchange -> {
            JsonNode input = JSON.readTree(exchange.getRequestBody());
            if ("cancelled".equals(input.path("status").asText())) cancelledEvent.countDown();
            respond(bridgeBody("{\"ok\":true}"), exchange);
        });
        bridge.createContext("/v1/background-tasks", exchange -> {
            JsonNode input = JSON.readTree(exchange.getRequestBody());
            taskId.set(input.path("taskId").asText());
            respond(bridgeBody("{\"token\":\"task-secret\"}"), exchange);
        });
        bridge.createContext("/v1/tool-executions", exchange -> {
            calls.add(JSON.readTree(exchange.getRequestBody()));
            respond(bridgeBody("{\"status\":\"ok\",\"result\":{}}"), exchange);
        });
        bridge.start();
        try {
            RunRequest base = request(model.getAddress().getPort(), "cancel-background", "user-1", "space-1",
                    List.of(), null);
            String origin = "http://127.0.0.1:" + bridge.getAddress().getPort();
            RunRequest.ToolBridge endpoint = new RunRequest.ToolBridge(origin + "/v1/tool-executions",
                    null, null, origin + "/v1/background-tasks", origin + "/v1/background-tasks/events",
                    "bridge-secret", base.identity());
            RunRequest input = new RunRequest(base.botId(), base.threadId(), base.runId(), base.executionScope(),
                    base.sourceMessageId(), base.identity(), base.prompt(), base.productName(), base.instructions(),
                    base.history(), base.currentTurnImages(), base.skills(), List.of(
                        new RunRequest.ToolDefinition("run_subagent", "Delegate", Map.of("type", "object"), true),
                        new RunRequest.ToolDefinition("test_clock", "Clock", Map.of("type", "object"), true)),
                    endpoint, base.model(), base.allowSilentEmpty(), base.emptyResponseText(), base.sessionGeneration());
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("cancel-state"), temp.resolve("cancel-workspace"));
            List<Map<String, Object>> events = new ArrayList<>();
            engine.execute(input, events::add);
            assertEquals("done", events.getLast().get("type"));
            assertTrue(childStarted.await(5, TimeUnit.SECONDS));
            assertTrue(engine.cancelTask(base.identity(), taskId.get()));
            assertTrue(cancelledEvent.await(5, TimeUnit.SECONDS));
            releaseChild.countDown();
            Thread.sleep(250);
            assertTrue(calls.isEmpty(), "Cancelled child must not reach backend tools");
        } finally { releaseChild.countDown(); bridge.stop(0); model.stop(0); }
    }

    private static byte[] bridgeBody(String value) { return value.getBytes(StandardCharsets.UTF_8); }

    private static void respond(byte[] body, com.sun.net.httpserver.HttpExchange exchange) throws java.io.IOException {
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(200, body.length);
        try (var output = exchange.getResponseBody()) { output.write(body); }
    }

    private static void modelReply(com.sun.net.httpserver.HttpExchange exchange, String tool,
            String arguments, String text) throws java.io.IOException {
        Map<String, Object> delta = new HashMap<>();
        delta.put("role", "assistant");
        if (tool != null) delta.put("tool_calls", List.of(Map.of("index", 0, "id", "call-bg",
                "type", "function", "function", Map.of("name", tool, "arguments", arguments))));
        else delta.put("content", text);
        Map<String, Object> firstChoice = new HashMap<>();
        firstChoice.put("index", 0);
        firstChoice.put("delta", delta);
        firstChoice.put("finish_reason", null);
        String prefix = "{\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"fixture\",\"choices\":";
        byte[] stream = ("data: " + prefix + JSON.writeValueAsString(List.of(firstChoice)) + "}\n\n"
                + "data: " + prefix + JSON.writeValueAsString(List.of(Map.of("index", 0,
                "delta", Map.of(), "finish_reason", tool == null ? "stop" : "tool_calls"))) + "}\n\n"
                + "data: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "text/event-stream");
        exchange.sendResponseHeaders(200, 0);
        try (var output = exchange.getResponseBody()) { output.write(stream); }
    }

    @Test void backendWebToolOverridesHarnessBuiltin() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<JsonNode> bridgeCalls = new CopyOnWriteArrayList<>();
        HttpServer model = scriptedModel(requests,
                List.of(new ToolStep("web_search", "{\"query\":\"fixture\"}")));
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/tool-executions", exchange -> {
            bridgeCalls.add(JSON.readTree(exchange.getRequestBody()));
            byte[] body = "{\"status\":\"ok\",\"result\":{\"value\":\"WORKPAL_AUTHORIZED_WEB_MARKER\"}}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (var output = exchange.getResponseBody()) { output.write(body); }
        });
        bridge.start();
        try {
            RunRequest base = request(model.getAddress().getPort(), "web-1", "user-1", "space-1", List.of(), null);
            RunRequest.ToolBridge endpoint = new RunRequest.ToolBridge(
                    "http://127.0.0.1:" + bridge.getAddress().getPort() + "/v1/tool-executions",
                    null, null, "bridge-secret", base.identity());
            RunRequest.ToolDefinition web = new RunRequest.ToolDefinition("web_search",
                    "Authorized WorkPal web search", Map.of("type", "object"), true);
            RunRequest input = new RunRequest(base.botId(), base.threadId(), base.runId(), base.executionScope(),
                    base.sourceMessageId(), base.identity(), base.prompt(), base.productName(), base.instructions(),
                    base.history(), base.currentTurnImages(), base.skills(), List.of(web), endpoint,
                    base.model(), base.allowSilentEmpty(), base.emptyResponseText(), base.sessionGeneration());
            List<Map<String, Object>> events = new ArrayList<>();
            new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace")).execute(input, events::add);
            assertEquals("done", events.getLast().get("type"));
            assertEquals("web_search", bridgeCalls.getFirst().path("name").asText());
            assertTrue(requests.stream().anyMatch(body -> body.toString().contains("WORKPAL_AUTHORIZED_WEB_MARKER")));
        } finally { bridge.stop(0); model.stop(0); }
    }

    @Test void deleteRunInterruptsAnActiveModelStream() throws Exception {
        CountDownLatch modelStarted = new CountDownLatch(1);
        CountDownLatch releaseModel = new CountDownLatch(1);
        HttpServer model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        model.createContext("/v1/chat/completions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().set("content-type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try (var output = exchange.getResponseBody()) {
                output.write(("data: {\"id\":\"slow\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"waiting\"},\"finish_reason\":null}]}\n\n")
                        .getBytes(StandardCharsets.UTF_8));
                output.flush();
                modelStarted.countDown();
                releaseModel.await(10, TimeUnit.SECONDS);
                output.write("data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
            } catch (Exception ignored) { modelStarted.countDown(); }
        });
        model.start();
        RuntimeServer runtime = new RuntimeServer("127.0.0.1", 0, temp.resolve("http-runtime"));
        runtime.start();
        try {
            HttpClient client = HttpClient.newHttpClient();
            URI runs = URI.create("http://127.0.0.1:" + runtime.port() + "/v1/runs");
            RunRequest input = request(model.getAddress().getPort(), "cancel-1", "user-1", "space-1", List.of(), null);
            var response = client.sendAsync(HttpRequest.newBuilder(runs)
                    .header("content-type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(input))).build(),
                    HttpResponse.BodyHandlers.ofInputStream());
            assertTrue(modelStarted.await(5, TimeUnit.SECONDS));
            URI cancel = URI.create(runs + "/cancel-1");
            var stopped = client.send(HttpRequest.newBuilder(cancel).DELETE().build(),
                    HttpResponse.BodyHandlers.ofString());
            assertEquals(200, stopped.statusCode());
            assertTrue(JSON.readTree(stopped.body()).path("cancelled").asBoolean());
            boolean cleared = false;
            for (int attempt = 0; attempt < 50; attempt++) {
                var health = client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"
                                + runtime.port() + "/health")).GET().build(), HttpResponse.BodyHandlers.ofString());
                if (JSON.readTree(health.body()).path("activeRuns").asInt() == 0) { cleared = true; break; }
                Thread.sleep(100);
            }
            assertTrue(cleared, "DELETE must stop the model stream and release the run");
            response.thenAccept(value -> { try { value.body().close(); } catch (Exception ignored) {} });
        } finally { releaseModel.countDown(); runtime.stop(); model.stop(0); }
    }

    @Test void privateStateEndpointPurgesBotAndRejectsLaterRuns() throws Exception {
        RuntimeServer runtime = new RuntimeServer("127.0.0.1", 0, temp.resolve("purge-http"));
        runtime.start();
        try {
            HttpClient client = HttpClient.newHttpClient();
            URI base = URI.create("http://127.0.0.1:" + runtime.port());
            var purge = client.send(HttpRequest.newBuilder(base.resolve("/v1/state/bots"))
                    .header("content-type", "application/json")
                    .method("DELETE", HttpRequest.BodyPublishers.ofString(
                            "{\"userId\":\"user-1\",\"spaceId\":\"space-1\",\"botId\":\"bot-1\"}"))
                    .build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(200, purge.statusCode());
            RunRequest request = request(12345, "after-purge", "user-1", "space-1", List.of(), null);
            var run = client.send(HttpRequest.newBuilder(base.resolve("/v1/runs"))
                    .header("content-type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(request)))
                    .build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(410, run.statusCode());
        } finally { runtime.stop(); }
    }

    @Test void separatesUserSpaceBotAndThreadSessionState() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        HttpServer model = fakeModel(requests, false);
        try {
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"));
            RunRequest initial = request(model.getAddress().getPort(), "isolation-a", "user-a", "space-a", List.of(), null);
            engine.execute(withIdentity(initial, "user-a", "space-a", "bot-1", "thread-1", "TENANT_A_MARKER"), event -> {});
            String[][] boundaries = {
                    {"user-b", "space-a", "bot-1", "thread-1"},
                    {"user-a", "space-b", "bot-1", "thread-1"},
                    {"user-a", "space-a", "bot-2", "thread-1"},
                    {"user-a", "space-a", "bot-1", "thread-2"}
            };
            for (String[] boundary : boundaries) {
                int before = requests.size();
                RunRequest base = request(model.getAddress().getPort(), "isolation-" + before,
                        boundary[0], boundary[1], List.of(), null);
                engine.execute(withIdentity(base, boundary[0], boundary[1], boundary[2], boundary[3],
                        "OTHER_TENANT_MARKER"), event -> {});
                assertTrue(requests.size() > before);
                assertFalse(requests.subList(before, requests.size()).stream()
                        .anyMatch(body -> body.toString().contains("TENANT_A_MARKER")));
            }
        } finally { model.stop(0); }
    }

    @Test void purgesOnlyTheDeletedBotsDurableState() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        HttpServer model = fakeModel(requests, false);
        try {
            Path state = temp.resolve("state");
            Path workspace = temp.resolve("workspace");
            RuntimeEngine engine = new RuntimeEngine(JSON, state, workspace);
            RunRequest original = request(model.getAddress().getPort(), "purge-1", "user-1", "space-1", List.of(), null);
            engine.execute(withIdentity(original, "user-1", "space-1", "bot-1", "thread-1",
                    "PRIVATE_SESSION_MARKER"), event -> {});
            engine.purgeBot("user-2", "space-1", "bot-1");
            RunRequest beforePurge = request(model.getAddress().getPort(), "purge-2", "user-1", "space-1", List.of(), null);
            engine.execute(beforePurge, event -> {});
            assertTrue(requests.getLast().toString().contains("PRIVATE_SESSION_MARKER"));
            engine.purgeBot("user-1", "space-1", "bot-1");
            RunRequest afterPurge = request(model.getAddress().getPort(), "purge-3", "user-1", "space-1", List.of(), null);
            engine.execute(afterPurge, event -> {});
            assertFalse(requests.getLast().toString().contains("PRIVATE_SESSION_MARKER"));
        } finally { model.stop(0); }
    }

    @Test void threadClearGenerationStartsAFreshHarnessSession() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        HttpServer model = fakeModel(requests, false);
        try {
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"));
            RunRequest initial = request(model.getAddress().getPort(), "generation-1", "user-1", "space-1", List.of(), null);
            engine.execute(withIdentity(initial, "user-1", "space-1", "bot-1", "thread-1",
                    "CLEARED_HISTORY_MARKER"), event -> {});
            RunRequest base = request(model.getAddress().getPort(), "generation-2", "user-1", "space-1", List.of(), null);
            RunRequest cleared = new RunRequest(base.botId(), base.threadId(), base.runId(), base.executionScope(),
                    base.sourceMessageId(), base.identity(), "Fresh thread", base.productName(), base.instructions(),
                    base.history(), base.currentTurnImages(), base.skills(), base.tools(), base.toolBridge(),
                    base.model(), base.allowSilentEmpty(), base.emptyResponseText(), 1);
            engine.execute(cleared, event -> {});
            assertFalse(requests.getLast().toString().contains("CLEARED_HISTORY_MARKER"));
        } finally { model.stop(0); }
    }

    @Test void constructsSupportedApiKeyModelAdapters() {
        for (String provider : List.of("openai", "openrouter", "openai-compatible", "local",
                "anthropic", "google", "dashscope", "xai", "deepseek", "minimax",
                "minimax-cn", "moonshotai", "moonshotai-cn")) {
            RunRequest.RunModel selected = new RunRequest.RunModel(provider, "fixture-model", "fixture-key",
                    provider.equals("local") || provider.equals("openai-compatible")
                            ? "http://127.0.0.1:12345/v1" : null,
                    false, 100, 8192, null, null);
            assertNotNull(ModelFactory.create(selected), provider);
        }
    }

    private static RunRequest withIdentity(RunRequest base, String user, String space, String bot,
            String thread, String prompt) {
        RunRequest.Identity identity = new RunRequest.Identity(user, space, bot, thread, base.runId());
        return new RunRequest(bot, thread, base.runId(), base.executionScope(), base.sourceMessageId(),
                identity, prompt, base.productName(), base.instructions(), base.history(),
                base.currentTurnImages(), base.skills(), base.tools(), base.toolBridge(), base.model(),
                base.allowSilentEmpty(), base.emptyResponseText(), base.sessionGeneration());
    }

    private record ToolStep(String name, String arguments) {}

    private static HttpServer scriptedModel(List<JsonNode> requests, List<ToolStep> steps) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            requests.add(JSON.readTree(exchange.getRequestBody()));
            int index = requests.size() - 1;
            boolean tool = index < steps.size();
            Map<String, Object> delta = new HashMap<>();
            delta.put("role", "assistant");
            if (tool) {
                ToolStep step = steps.get(index);
                delta.put("tool_calls", List.of(Map.of("index", 0, "id", "call-" + index,
                        "type", "function", "function", Map.of("name", step.name(), "arguments", step.arguments()))));
            } else delta.put("content", "Completed by native Harness.");
            Map<String, Object> firstChoice = new HashMap<>();
            firstChoice.put("index", 0); firstChoice.put("delta", delta); firstChoice.put("finish_reason", null);
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

    private static RunRequest request(int port, String runId, String user, String space,
            List<RunRequest.ToolDefinition> tools, RunRequest.ToolBridge bridge) {
        return new RunRequest("bot-1", "thread-1", runId, "chat", "message-1",
                new RunRequest.Identity(user, space, "bot-1", "thread-1", runId),
                "Say hello.", "WorkPal", "Reply concisely.", List.of(), List.of(), List.of(), tools, bridge,
                new RunRequest.RunModel("local", "fixture", "test-key", "http://127.0.0.1:" + port + "/v1",
                        false, 200, 8192, null, null), false, null, 0);
    }

    private static HttpServer fakeModel(List<JsonNode> requests, boolean toolFirst) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            requests.add(body);
            boolean tool = toolFirst && body.path("messages").toString().contains("clock ok") == false;
            String first = tool
                    ? "{\"id\":\"chatcmpl-tool\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":{\"name\":\"test_clock\",\"arguments\":\"{\\\"timezone\\\":\\\"UTC\\\"}\"}}]},\"finish_reason\":null}]}"
                    : "{\"id\":\"chatcmpl-text\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello from Java Harness.\"},\"finish_reason\":null}]}";
            String finish = "{\"id\":\"chatcmpl-end\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\""
                    + (tool ? "tool_calls" : "stop")
                    + "\"}],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":5,\"total_tokens\":25}}";
            byte[] stream = ("data: " + first + "\n\ndata: " + finish + "\n\ndata: [DONE]\n\n")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try (var output = exchange.getResponseBody()) { output.write(stream); output.flush(); }
        });
        server.start();
        return server;
    }
}
