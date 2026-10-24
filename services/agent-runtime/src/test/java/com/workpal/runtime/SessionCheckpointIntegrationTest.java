package com.workpal.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * RT-26 end to end on the real native Harness: a paused Run detaches its
 * pending state, another Run uses the shared slot cleanly, the owning Run
 * resumes its checkpoint under a NEW fence and suspension key, and its second
 * pause detaches again under another binding.
 */
class SessionCheckpointIntegrationTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir Path temp;

    @Test void detachesRunAFromRunBAndResumesUnderANewBinding() throws Exception {
        List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
        List<JsonNode> toolCalls = new CopyOnWriteArrayList<>();
        HttpServer model = toolFirstModel(modelRequests);
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/tool-surface", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            String runId = body.path("runId").asText();
            writeJson(exchange, 200, Map.of("tools", List.of(wireTool(askTool()))));
        });
        bridge.createContext("/v1/tool-executions", exchange -> {
            toolCalls.add(JSON.readTree(exchange.getRequestBody()));
            // Every attempt pauses: the Run keeps a native pending call.
            writeJson(exchange, 200, Map.of("status", "paused"));
        });
        bridge.start();
        try {
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("state"),
                    temp.resolve("workspace"));
            String sessionKey = "agentscope:chat:v1:" + SessionSlots.hash("user-1\0space-1") + ":"
                    + SessionSlots.hash("bot-1\0thread-1\0" + 0);
            RunRequest.ToolBridge endpoint = new RunRequest.ToolBridge(
                    "http://127.0.0.1:" + bridge.getAddress().getPort() + "/v1/tool-executions",
                    null, null, "bridge-secret",
                    new RunRequest.Identity("user-1", "space-1", "bot-1", "thread-1", "run-a"));

            // Run A pauses inside a native tool call under fence 3.
            RunRequest runA = request(model.getAddress().getPort(), "run-a",
                    "Ask this user a question.", endpoint,
                    new RunRequest.SessionAdmission(sessionKey, "exec-a", "attempt-a", 3L, "susp-a"),
                    null);
            List<Map<String, Object>> paused = new ArrayList<>();
            engine.execute(runA, paused::add);
            assertEquals("paused", paused.getLast().get("type"), paused.toString());
            assertEquals(1, toolCalls.size(), toolCalls.toString());

            Map<String, Object> detached = engine.inspectAndDetach("runtime-1", runA.identity(),
                    sessionKey, 0, "exec-a", "attempt-a", 3L, "susp-a", "ckpt_aaaaaaa1");
            assertEquals("detached", detached.get("kind"), detached.toString());
            assertEquals("ckpt_aaaaaaa1", detached.get("checkpointId"));
            assertEquals(
                    List.of(Map.of("id", "call-1", "name", "external_lookup", "state", "ALLOWED")),
                    detached.get("pendingCalls"));

            // Run B is a different execution binding and must start from a clean slot.
            RunRequest runB = request(model.getAddress().getPort(), "run-b",
                    "Run B prompt.", endpoint,
                    new RunRequest.SessionAdmission(sessionKey, "exec-b", "attempt-b", 4L, "susp-b"),
                    null);
            List<Map<String, Object>> bEvents = new ArrayList<>();
            engine.execute(runB, bEvents::add);
            assertEquals("done", bEvents.getLast().get("type"), bEvents.toString());
            assertEquals(2, modelRequests.size());
            assertFalse(modelRequests.get(1).path("messages").toString().contains("Ask this user"),
                    "Run B must not inherit Run A's native pending state");
            assertEquals(1, toolCalls.size(), "Run B must not replay Run A's pending call");

            // Run A resumes only its own acknowledged checkpoint under fence 4.
            RunRequest.CheckpointResume resume = new RunRequest.CheckpointResume("ckpt_aaaaaaa1",
                    (String) detached.get("digest"), sessionKey, "run-a", "attempt-a", "exec-a", 3L,
                    "susp-a", "attempt-a2", "exec-a2", 4L, "susp-a2");
            RunRequest resumed = request(model.getAddress().getPort(), "run-a",
                    "Ask this user a question.", endpoint,
                    new RunRequest.SessionAdmission(sessionKey, "exec-a2", "attempt-a2", 4L,
                            "susp-a2"),
                    resume);
            List<Map<String, Object>> resumedEvents = new ArrayList<>();
            engine.execute(resumed, resumedEvents::add);
            assertEquals("paused", resumedEvents.getLast().get("type"), resumedEvents.toString());
            // The restored pending call was consumed without a new model turn.
            assertEquals(2, modelRequests.size());
            assertEquals(2, toolCalls.size(), "the restored pending call runs exactly once");
            assertEquals("external_lookup", toolCalls.get(1).path("name").asText());
            assertEquals("call-1", toolCalls.get(1).path("executionId").asText());

            // Its second pause detaches under the new fence and suspension key.
            Map<String, Object> second = engine.inspectAndDetach("runtime-1", runA.identity(),
                    sessionKey, 0, "exec-a2", "attempt-a2", 4L, "susp-a2", "ckpt_bbbbbbb2");
            assertEquals("detached", second.get("kind"), second.toString());
            assertEquals("ckpt_bbbbbbb2", second.get("checkpointId"));
            Path botRoot = temp.resolve("checkpoints").resolve(SessionSlots.hash("bot-1"));
            assertEquals("resumed", JSON.readTree(Files.readString(
                    botRoot.resolve("ckpt_aaaaaaa1").resolve("manifest.json"))).path("status").asText());
            assertEquals("detached", JSON.readTree(Files.readString(
                    botRoot.resolve("ckpt_bbbbbbb2").resolve("manifest.json"))).path("status").asText());

            // The old binding can never detach the second checkpoint.
            assertThrows(SessionCheckpointStore.Conflict.class, () -> engine.inspectAndDetach(
                    "runtime-1", runA.identity(), sessionKey, 0, "exec-a", "attempt-a", 3L, "susp-a",
                    "ckpt_bbbbbbb2"));

            // A fresh Run after the second detach still reaches the model.
            RunRequest runC = request(model.getAddress().getPort(), "run-c",
                    "Run C prompt.", endpoint,
                    new RunRequest.SessionAdmission(sessionKey, "exec-c", "attempt-c", 5L, "susp-c"),
                    null);
            List<Map<String, Object>> cEvents = new ArrayList<>();
            engine.execute(runC, cEvents::add);
            assertEquals("done", cEvents.getLast().get("type"), cEvents.toString());
            assertEquals(3, modelRequests.size());
            assertTrue(Files.exists(botRoot.resolve("ckpt_bbbbbbb2").resolve("session")));
        } finally {
            bridge.stop(0);
            model.stop(0);
        }
    }

    private static RunRequest.ToolDefinition askTool() {
        return new RunRequest.ToolDefinition("external_lookup", "Look up an external record",
                Map.of("type", "object", "properties", Map.of()), true);
    }

    private static Map<String, Object> wireTool(RunRequest.ToolDefinition tool) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", tool.name());
        body.put("description", tool.description());
        body.put("inputSchema", tool.inputSchema());
        body.put("readOnly", tool.readOnly());
        return body;
    }

    private static RunRequest request(int modelPort, String runId, String prompt,
            RunRequest.ToolBridge bridge, RunRequest.SessionAdmission admission,
            RunRequest.CheckpointResume resume) {
        RunRequest.Identity identity = new RunRequest.Identity(
                "user-1", "space-1", "bot-1", "thread-1", runId);
        RunRequest.ToolBridge bound = new RunRequest.ToolBridge(
                bridge.url(), bridge.steeringUrl(), bridge.modelUrl(), bridge.token(), identity);
        return new RunRequest("bot-1", "thread-1", runId, "chat", "message-1", identity,
                prompt, "WorkPal", "Reply concisely.", List.of(), List.of(), List.of(),
                List.of(askTool()), bound,
                new RunRequest.RunModel("local", "fixture", "test-key",
                        "http://127.0.0.1:" + modelPort + "/v1", false, 200, 8192, null, null),
                false, null, 0, null, null, null, null, null, admission, resume, null);
    }

    private static HttpServer toolFirstModel(List<JsonNode> requests) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            requests.add(JSON.readTree(exchange.getRequestBody()));
            boolean tool = requests.getLast().path("messages").toString()
                    .contains("Ask this user a question.");
            String first = tool
                    ? "{\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"created\":0,"
                            + "\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":"
                            + "{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call-1\","
                            + "\"type\":\"function\",\"function\":{\"name\":\"external_lookup\","
                            + "\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}"
                    : "{\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"created\":0,"
                            + "\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":"
                            + "{\"role\":\"assistant\",\"content\":\"Done natively.\"},"
                            + "\"finish_reason\":null}]}";
            String finish = "{\"id\":\"c2\",\"object\":\"chat.completion.chunk\",\"created\":0,"
                    + "\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{},"
                    + "\"finish_reason\":\"" + (tool ? "tool_calls" : "stop")
                    + "\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":1,"
                    + "\"total_tokens\":6}}";
            byte[] stream = ("data: " + first + "\n\ndata: " + finish + "\n\ndata: [DONE]\n\n")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try (var output = exchange.getResponseBody()) { output.write(stream); }
        });
        server.start();
        return server;
    }

    private static void writeJson(HttpExchange exchange, int status, Object payload)
            throws java.io.IOException {
        byte[] body = JSON.writeValueAsBytes(payload);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, body.length);
        try (var output = exchange.getResponseBody()) { output.write(body); }
    }
}
