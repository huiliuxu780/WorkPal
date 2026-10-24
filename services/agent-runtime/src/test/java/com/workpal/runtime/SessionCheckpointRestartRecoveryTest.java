package com.workpal.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.MsgRole;
import io.agentscope.core.message.ToolCallState;
import io.agentscope.core.message.ToolUseBlock;
import io.agentscope.core.state.AgentState;
import io.agentscope.core.state.JsonFileAgentStateStore;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * RT-26 review (P1): a Runtime restart empties the in-memory {@code
 * sessionOwners} map, so the detach probe used to 409 before the durable
 * manifest was ever consulted and an RT-25 recovering admission was stuck
 * forever. The manifest is the persisted ownership binding: a restarted engine
 * re-adopts the owner exactly when the presented binding matches it
 * field-for-field, and keeps refusing every other binding.
 */
class SessionCheckpointRestartRecoveryTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SESSION_KEY =
            "agentscope:chat:v1:" + "a".repeat(64) + ":" + "b".repeat(64);
    private static final String CHECKPOINT_ID = "ckpt_aaaaaaa1";

    @TempDir Path temp;

    @Test void restartedEngineReadoptsOnlyTheExactManifestBinding() throws Exception {
        String tenant = tenant("user-1", "space-1");
        String session = session("bot-1", "thread-1", 0);
        seedState("bot-1", tenant, session, true);
        SessionCheckpointStore store = store();
        SessionCheckpointStore.Binding binding =
                binding("exec-a", "attempt-a", 3, "susp-a", CHECKPOINT_ID);
        SessionCheckpointStore.Proof detached = store.inspectAndDetach("bot-1", tenant, session,
                binding);

        // Process restart: a fresh engine over the SAME durable roots has an
        // empty in-memory sessionOwners map (the "new JVM, same disk" shape).
        RuntimeEngine restarted = new RuntimeEngine(JSON, temp.resolve("state"),
                temp.resolve("workspace"));
        RunRequest.Identity identity = new RunRequest.Identity(
                "user-1", "space-1", "bot-1", "thread-1", "run-a");

        // The exact binding is adopted from the manifest and the detach
        // completes with the same deterministic proof the dying process got.
        Map<String, Object> adopted = restarted.inspectAndDetach("runtime-2", identity,
                SESSION_KEY, 0, "exec-a", "attempt-a", 3L, "susp-a", CHECKPOINT_ID);
        assertEquals("detached", adopted.get("kind"));
        assertEquals(CHECKPOINT_ID, adopted.get("checkpointId"));
        assertEquals(detached.digest(), adopted.get("digest"));
        assertEquals("runtime-2", adopted.get("runtimeInstanceId"));

        // Another engine restart finds the same durable proof — the settle path
        // can retry safely.
        RuntimeEngine restartedAgain = new RuntimeEngine(JSON, temp.resolve("state"),
                temp.resolve("workspace"));
        Map<String, Object> retry = restartedAgain.inspectAndDetach("runtime-3", identity,
                SESSION_KEY, 0, "exec-a", "attempt-a", 3L, "susp-a", CHECKPOINT_ID);
        assertEquals("detached", retry.get("kind"));
        assertEquals(detached.digest(), retry.get("digest"));

        // A third fresh engine holds no owner at all, so every rejection below
        // exercises the adoption refusal path itself (the live-owner mismatch
        // path is pinned by SessionCheckpointStoreTest).
        RuntimeEngine freshAfterRestart = new RuntimeEngine(JSON, temp.resolve("state"),
                temp.resolve("workspace"));
        // A different run can never adopt the checkpoint...
        RunRequest.Identity runB = new RunRequest.Identity(
                "user-1", "space-1", "bot-1", "thread-1", "run-b");
        assertThrows(SessionCheckpointStore.Conflict.class, () ->
                freshAfterRestart.inspectAndDetach("runtime-4", runB, SESSION_KEY, 0,
                        "exec-b", "attempt-b", 4L, "susp-b", CHECKPOINT_ID));
        // ...nor a mismatched fence or suspension key of the owning run...
        assertThrows(SessionCheckpointStore.Conflict.class, () ->
                freshAfterRestart.inspectAndDetach("runtime-4", identity, SESSION_KEY, 0,
                        "exec-a", "attempt-a", 4L, "susp-a", CHECKPOINT_ID));
        assertThrows(SessionCheckpointStore.Conflict.class, () ->
                freshAfterRestart.inspectAndDetach("runtime-4", identity, SESSION_KEY, 0,
                        "exec-a", "attempt-a", 3L, "susp-other", CHECKPOINT_ID));
        // ...nor a binding whose checkpoint has no durable manifest at all.
        assertThrows(SessionCheckpointStore.Conflict.class, () ->
                freshAfterRestart.inspectAndDetach("runtime-4", identity, SESSION_KEY, 0,
                        "exec-a", "attempt-a", 3L, "susp-a", "ckpt_zzzzzzz9"));
    }

    @Test void restartedEngineReadoptsTheOwnerOfARealPausedRun() throws Exception {
        // End to end: a real Run pauses inside a native tool call and detaches;
        // the engine is then "restarted" and the settle path's single
        // inspectAndDetach call adopts the owner from the durable manifest.
        HttpServer model = toolFirstModel();
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.createContext("/v1/tool-surface", exchange -> writeJson(exchange, 200,
                Map.of("tools", List.of(wireTool(new RunRequest.ToolDefinition("external_lookup",
                        "Look up an external record",
                        Map.of("type", "object", "properties", Map.of()), true))))));
        bridge.createContext("/v1/tool-executions", exchange ->
                writeJson(exchange, 200, Map.of("status", "paused")));
        bridge.start();
        try {
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("state"),
                    temp.resolve("workspace"));
            String sessionKey = "agentscope:chat:v1:" + SessionSlots.hash("user-1\0space-1")
                    + ":" + SessionSlots.hash("bot-1\0thread-1\0" + 0);
            RunRequest.ToolBridge endpoint = new RunRequest.ToolBridge(
                    "http://127.0.0.1:" + bridge.getAddress().getPort() + "/v1/tool-executions",
                    null, null, "bridge-secret",
                    new RunRequest.Identity("user-1", "space-1", "bot-1", "thread-1", "run-a"));
            RunRequest runA = request(model.getAddress().getPort(), "run-a",
                    "Ask this user a question.", endpoint,
                    new RunRequest.SessionAdmission(sessionKey, "exec-a", "attempt-a", 3L,
                            "susp-a"), null);
            List<Map<String, Object>> events = new ArrayList<>();
            engine.execute(runA, events::add);
            assertEquals("paused", events.getLast().get("type"), events.toString());

            String checkpointId = "ckpt_aaaaaaa1";
            Map<String, Object> detached = engine.inspectAndDetach("runtime-1", runA.identity(),
                    sessionKey, 0, "exec-a", "attempt-a", 3L, "susp-a", checkpointId);
            assertEquals("detached", detached.get("kind"), detached.toString());

            RuntimeEngine restarted = new RuntimeEngine(JSON, temp.resolve("state"),
                    temp.resolve("workspace"));
            Map<String, Object> adopted = restarted.inspectAndDetach("runtime-2", runA.identity(),
                    sessionKey, 0, "exec-a", "attempt-a", 3L, "susp-a", checkpointId);
            assertEquals("detached", adopted.get("kind"), adopted.toString());
            assertEquals(checkpointId, adopted.get("checkpointId"));
            assertEquals(detached.get("digest"), adopted.get("digest"));

            // The adopted owner behaves like the original one: another binding
            // for the same slot is still a hard conflict.
            RunRequest.Identity runB = new RunRequest.Identity(
                    "user-1", "space-1", "bot-1", "thread-1", "run-b");
            assertThrows(SessionCheckpointStore.Conflict.class, () -> restarted.inspectAndDetach(
                    "runtime-2", runB, sessionKey, 0, "exec-b", "attempt-b", 4L, "susp-b",
                    "ckpt_bbbbbbb2"));
        } finally {
            bridge.stop(0);
            model.stop(0);
        }
    }

    private static Map<String, Object> wireTool(RunRequest.ToolDefinition tool) {
        java.util.LinkedHashMap<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("name", tool.name());
        body.put("description", tool.description());
        body.put("inputSchema", tool.inputSchema());
        body.put("readOnly", tool.readOnly());
        return body;
    }

    private SessionCheckpointStore store() {
        return new SessionCheckpointStore(JSON, temp.resolve("checkpoints"), temp.resolve("state"));
    }

    private static SessionCheckpointStore.Binding binding(String executionId, String attemptId,
            long fence, String suspensionKey, String checkpointId) {
        return new SessionCheckpointStore.Binding(SESSION_KEY, "run-a", executionId, attemptId,
                fence, suspensionKey, checkpointId);
    }

    private String tenant(String user, String space) {
        return SessionSlots.hash(user + "\u0000" + space);
    }

    private String session(String bot, String thread, int generation) {
        return SessionSlots.hash(bot + "\u0000" + thread + "\u0000" + generation);
    }

    private void seedState(String bot, String tenant, String session, boolean pendingCall)
            throws Exception {
        AgentState.Builder builder = AgentState.builder()
                .userId(tenant)
                .sessionId(session)
                .replyId("reply-1")
                .curIter(1)
                .addMessage(Msg.builder().role(MsgRole.USER).textContent("hello").build());
        if (pendingCall) {
            builder.addMessage(Msg.builder().role(MsgRole.ASSISTANT)
                    .content(List.of(new ToolUseBlock("call-1", "external_lookup", Map.of(),
                            "{}", Map.of(), ToolCallState.ASKING)))
                    .build());
        }
        new JsonFileAgentStateStore(temp.resolve("state").resolve(SessionSlots.hash(bot)))
                .save(tenant, session, "agent_state", builder.build());
    }

    private RunRequest request(int modelPort, String runId, String prompt,
            RunRequest.ToolBridge bridge, RunRequest.SessionAdmission admission,
            RunRequest.CheckpointResume resume) {
        RunRequest.Identity identity = new RunRequest.Identity(
                "user-1", "space-1", "bot-1", "thread-1", runId);
        RunRequest.ToolBridge bound = new RunRequest.ToolBridge(
                bridge.url(), bridge.steeringUrl(), bridge.modelUrl(), bridge.token(), identity);
        return new RunRequest("bot-1", "thread-1", runId, "chat", "message-1", identity,
                prompt, "WorkPal", "Reply concisely.", List.of(), List.of(), List.of(),
                List.of(new RunRequest.ToolDefinition("external_lookup",
                        "Look up an external record",
                        Map.of("type", "object", "properties", Map.of()), true)),
                bound,
                new RunRequest.RunModel("local", "fixture", "test-key",
                        "http://127.0.0.1:" + modelPort + "/v1", false, 200, 8192, null, null),
                false, null, 0, null, null, null, null, null, admission, resume, null);
    }

    private static HttpServer toolFirstModel() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            String first = "{\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"created\":0,"
                    + "\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":"
                    + "{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call-1\","
                    + "\"type\":\"function\",\"function\":{\"name\":\"external_lookup\","
                    + "\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}";
            String finish = "{\"id\":\"c2\",\"object\":\"chat.completion.chunk\",\"created\":0,"
                    + "\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{},"
                    + "\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":5,"
                    + "\"completion_tokens\":1,\"total_tokens\":6}}";
            byte[] stream = ("data: " + first + "\n\ndata: " + finish + "\n\ndata: [DONE]\n\n")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try (var output = exchange.getResponseBody()) { output.write(stream); }
        });
        server.start();
        return server;
    }

    private static void writeJson(com.sun.net.httpserver.HttpExchange exchange, int status,
            Object payload) throws java.io.IOException {
        byte[] body = JSON.writeValueAsBytes(payload);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, body.length);
        try (var output = exchange.getResponseBody()) { output.write(body); }
    }
}
