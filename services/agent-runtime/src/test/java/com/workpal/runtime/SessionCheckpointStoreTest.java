package com.workpal.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.MsgRole;
import io.agentscope.core.message.ToolCallState;
import io.agentscope.core.message.ToolUseBlock;
import io.agentscope.core.state.AgentState;
import io.agentscope.core.state.JsonFileAgentStateStore;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * RT-26: the Runtime proves a shared AgentScope session slot is clean or
 * atomically detaches it into a checkpoint bound to one Run/Attempt/fence/
 * suspension key, and restores only that checkpoint under a new binding.
 *
 * <p>Crash boundaries are injected by rewriting the durable manifest or the
 * slot exactly where a process death would leave them.
 */
class SessionCheckpointStoreTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SESSION_KEY = "agentscope:chat:v1:" + "a".repeat(64) + ":" + "b".repeat(64);
    private static final String CHECKPOINT_ID = "ckpt_aaaaaaa1";

    @TempDir Path temp;

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
                    .content(List.of(new ToolUseBlock("call-1", "ask_user", Map.of(),
                            "{}", Map.of(), ToolCallState.ASKING)))
                    .build());
        }
        new JsonFileAgentStateStore(temp.resolve("state").resolve(SessionSlots.hash(bot)))
                .save(tenant, session, "agent_state", builder.build());
    }

    private Path slotDir(String bot, String tenant, String session) {
        return temp.resolve("state").resolve(SessionSlots.hash(bot)).resolve(tenant).resolve(session);
    }

    private Path manifestPath(String bot, String checkpointId) {
        return temp.resolve("checkpoints").resolve(SessionSlots.hash(bot)).resolve(checkpointId)
                .resolve("manifest.json");
    }

    private Path checkpointSlot(String bot, String checkpointId) {
        return temp.resolve("checkpoints").resolve(SessionSlots.hash(bot)).resolve(checkpointId)
                .resolve("session");
    }

    private void rewriteStatus(String bot, String checkpointId, String status) throws Exception {
        ObjectNode manifest = (ObjectNode) JSON.readTree(Files.readString(manifestPath(bot, checkpointId)));
        manifest.put("status", status);
        Files.writeString(manifestPath(bot, checkpointId), JSON.writeValueAsString(manifest));
    }

    private static void copyTree(Path source, Path target) throws Exception {
        Files.createDirectories(target);
        try (Stream<Path> paths = Files.walk(source)) {
            for (Path path : paths.toList()) {
                Path destination = target.resolve(source.relativize(path).toString());
                if (Files.isDirectory(path)) Files.createDirectories(destination);
                else {
                    Files.createDirectories(destination.getParent());
                    Files.copy(path, destination, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
            }
        }
    }

    @Test void detachesPendingStateAtomicallyAndRepeatsDeterministically() throws Exception {
        String tenant = tenant("user-1", "space-1");
        String session = session("bot-1", "thread-1", 0);
        seedState("bot-1", tenant, session, true);
        SessionCheckpointStore store = store();
        SessionCheckpointStore.Binding binding =
                binding("exec-a", "attempt-a", 3, "susp-a", CHECKPOINT_ID);

        SessionCheckpointStore.Proof proof = store.inspectAndDetach("bot-1", tenant, session, binding);
        assertEquals("detached", proof.kind());
        assertEquals(CHECKPOINT_ID, proof.checkpointId());
        assertTrue(proof.digest().matches("[0-9a-f]{64}"));
        assertEquals(List.of(new SessionCheckpointStore.PendingCall("call-1", "ask_user", "asking")),
                proof.pendingCalls());
        assertFalse(Files.exists(slotDir("bot-1", tenant, session)),
                "the shared slot must be empty after the atomic move");
        assertTrue(Files.exists(checkpointSlot("bot-1", CHECKPOINT_ID).resolve("agent_state.json")));

        Map<String, Object> wire = proof.wire("runtime-1");
        assertEquals("runtime-1", wire.get("runtimeInstanceId"));

        // A crash after the ack, or a retried detach, returns the same proof.
        SessionCheckpointStore.Proof repeated =
                store.inspectAndDetach("bot-1", tenant, session, binding);
        assertEquals(proof.digest(), repeated.digest());
        assertEquals(proof.pendingCalls(), repeated.pendingCalls());
        // Another execution binding can never claim the same checkpoint id.
        assertThrows(SessionCheckpointStore.Conflict.class, () -> store.inspectAndDetach(
                "bot-1", tenant, session,
                binding("exec-b", "attempt-a", 3, "susp-a", CHECKPOINT_ID)));
    }

    @Test void reportsCleanWithoutTouchingAQuiescentSlot() throws Exception {
        String tenant = tenant("user-1", "space-1");
        String session = session("bot-1", "thread-1", 0);
        seedState("bot-1", tenant, session, false);
        SessionCheckpointStore store = store();
        SessionCheckpointStore.Binding binding =
                binding("exec-a", "attempt-a", 3, "susp-a", CHECKPOINT_ID);

        SessionCheckpointStore.Proof proof = store.inspectAndDetach("bot-1", tenant, session, binding);
        assertEquals("clean", proof.kind());
        assertTrue(proof.pendingCalls().isEmpty());
        assertTrue(Files.exists(slotDir("bot-1", tenant, session)),
                "a clean proof leaves the slot for the next owner");
        assertFalse(Files.exists(checkpointSlot("bot-1", CHECKPOINT_ID)));
    }

    @Test void repairsACrashBetweenPreparingAndTheMove() throws Exception {
        String tenant = tenant("user-1", "space-1");
        String session = session("bot-1", "thread-1", 0);
        seedState("bot-1", tenant, session, true);
        SessionCheckpointStore store = store();
        SessionCheckpointStore.Binding binding =
                binding("exec-a", "attempt-a", 3, "susp-a", CHECKPOINT_ID);
        SessionCheckpointStore.Proof first = store.inspectAndDetach("bot-1", tenant, session, binding);

        // Crash before the move: the manifest says preparing, the slot is intact.
        copyTree(checkpointSlot("bot-1", CHECKPOINT_ID), slotDir("bot-1", tenant, session));
        deleteTree(checkpointSlot("bot-1", CHECKPOINT_ID));
        rewriteStatus("bot-1", CHECKPOINT_ID, "preparing");

        SessionCheckpointStore.Proof repaired = store.inspectAndDetach("bot-1", tenant, session, binding);
        assertEquals("detached", repaired.kind());
        assertEquals(first.digest(), repaired.digest());
        assertFalse(Files.exists(slotDir("bot-1", tenant, session)));
        assertEquals("detached", JSON.readTree(Files.readString(manifestPath("bot-1", CHECKPOINT_ID)))
                .path("status").asText());
    }

    @Test void repairsACrashBetweenTheMoveAndTheManifestUpgrade() throws Exception {
        String tenant = tenant("user-1", "space-1");
        String session = session("bot-1", "thread-1", 0);
        seedState("bot-1", tenant, session, true);
        SessionCheckpointStore store = store();
        SessionCheckpointStore.Binding binding =
                binding("exec-a", "attempt-a", 3, "susp-a", CHECKPOINT_ID);
        SessionCheckpointStore.Proof first = store.inspectAndDetach("bot-1", tenant, session, binding);

        // Crash after the atomic move, before the manifest was upgraded.
        rewriteStatus("bot-1", CHECKPOINT_ID, "preparing");
        assertFalse(Files.exists(slotDir("bot-1", tenant, session)));

        SessionCheckpointStore.Proof repaired = store.inspectAndDetach("bot-1", tenant, session, binding);
        assertEquals("detached", repaired.kind());
        assertEquals(first.digest(), repaired.digest());
        assertEquals(first.pendingCalls(), repaired.pendingCalls());
        assertEquals("detached", JSON.readTree(Files.readString(manifestPath("bot-1", CHECKPOINT_ID)))
                .path("status").asText());
    }

    @Test void restoresOnlyUnderANewFenceAndSuspensionAndIsIdempotent() throws Exception {
        String tenant = tenant("user-1", "space-1");
        String session = session("bot-1", "thread-1", 0);
        seedState("bot-1", tenant, session, true);
        SessionCheckpointStore store = store();
        SessionCheckpointStore.Proof proof = store.inspectAndDetach("bot-1", tenant, session,
                binding("exec-a", "attempt-a", 3, "susp-a", CHECKPOINT_ID));

        RunRequest.CheckpointResume resume = new RunRequest.CheckpointResume(CHECKPOINT_ID,
                proof.digest(), SESSION_KEY, "run-a", "attempt-a", "exec-a", 3L, "susp-a",
                "attempt-b", "exec-b", 4L, "susp-b");
        assertTrue(store.restore("bot-1", tenant, session, resume, "run-a"));
        assertTrue(Files.exists(slotDir("bot-1", tenant, session)));
        assertEquals("resumed", JSON.readTree(Files.readString(manifestPath("bot-1", CHECKPOINT_ID)))
                .path("status").asText());
        // A retried restore under the same new binding is a no-op.
        assertTrue(store.restore("bot-1", tenant, session, resume, "run-a"));

        RunRequest.CheckpointResume sameFence = new RunRequest.CheckpointResume(CHECKPOINT_ID,
                proof.digest(), SESSION_KEY, "run-a", "attempt-a", "exec-a", 3L, "susp-a",
                "attempt-b", "exec-b", 3L, "susp-c");
        assertThrows(SessionCheckpointStore.Conflict.class,
                () -> store.restore("bot-1", tenant, session, sameFence, "run-a"));
        RunRequest.CheckpointResume sameSuspension = new RunRequest.CheckpointResume(CHECKPOINT_ID,
                proof.digest(), SESSION_KEY, "run-a", "attempt-a", "exec-a", 3L, "susp-a",
                "attempt-b", "exec-b", 4L, "susp-a");
        assertThrows(SessionCheckpointStore.Conflict.class,
                () -> store.restore("bot-1", tenant, session, sameSuspension, "run-a"));
        RunRequest.CheckpointResume otherRun = new RunRequest.CheckpointResume(CHECKPOINT_ID,
                proof.digest(), SESSION_KEY, "run-b", "attempt-a", "exec-a", 3L, "susp-a",
                "attempt-b", "exec-b", 4L, "susp-b");
        assertThrows(SessionCheckpointStore.Conflict.class,
                () -> store.restore("bot-1", tenant, session, otherRun, "run-b"));
        RunRequest.CheckpointResume wrongDigest = new RunRequest.CheckpointResume(CHECKPOINT_ID,
                "c".repeat(64), SESSION_KEY, "run-a", "attempt-a", "exec-a", 3L, "susp-a",
                "attempt-b", "exec-b", 4L, "susp-b");
        assertThrows(SessionCheckpointStore.Conflict.class,
                () -> store.restore("bot-1", tenant, session, wrongDigest, "run-a"));
    }

    @Test void restoreRepairsACrashAfterTheAtomicMove() throws Exception {
        String tenant = tenant("user-1", "space-1");
        String session = session("bot-1", "thread-1", 0);
        seedState("bot-1", tenant, session, true);
        SessionCheckpointStore store = store();
        SessionCheckpointStore.Proof proof = store.inspectAndDetach("bot-1", tenant, session,
                binding("exec-a", "attempt-a", 3, "susp-a", CHECKPOINT_ID));
        RunRequest.CheckpointResume resume = new RunRequest.CheckpointResume(CHECKPOINT_ID,
                proof.digest(), SESSION_KEY, "run-a", "attempt-a", "exec-a", 3L, "susp-a",
                "attempt-b", "exec-b", 4L, "susp-b");

        // Crash after the restore move, before the manifest says resumed.
        copyTree(checkpointSlot("bot-1", CHECKPOINT_ID), slotDir("bot-1", tenant, session));
        assertTrue(store.restore("bot-1", tenant, session, resume, "run-a"));
        assertEquals("resumed", JSON.readTree(Files.readString(manifestPath("bot-1", CHECKPOINT_ID)))
                .path("status").asText());
    }

    @Test void restoreRefusesASlotThatHoldsAnotherRunsPendingCall() throws Exception {
        String tenant = tenant("user-1", "space-1");
        String session = session("bot-1", "thread-1", 0);
        seedState("bot-1", tenant, session, true);
        SessionCheckpointStore store = store();
        SessionCheckpointStore.Proof proof = store.inspectAndDetach("bot-1", tenant, session,
                binding("exec-a", "attempt-a", 3, "susp-a", CHECKPOINT_ID));
        seedState("bot-1", tenant, session, true);

        RunRequest.CheckpointResume resume = new RunRequest.CheckpointResume(CHECKPOINT_ID,
                proof.digest(), SESSION_KEY, "run-a", "attempt-a", "exec-a", 3L, "susp-a",
                "attempt-b", "exec-b", 4L, "susp-b");
        assertThrows(SessionCheckpointStore.Conflict.class,
                () -> store.restore("bot-1", tenant, session, resume, "run-a"));
    }

    @Test void mergesThreadContextDeterministicallyAndWithinBudget() {
        List<RunRequest.ThreadContextMessage> messages = new ArrayList<>();
        for (int seq = 1; seq <= 45; seq++) {
            messages.add(new RunRequest.ThreadContextMessage(seq, seq % 2 == 0 ? "assistant" : "user",
                    "message-" + seq));
        }
        Msg merged = RuntimeEngine.threadAfterSuspensionContext(messages);
        String text = merged.getTextContent();
        assertNotNull(text);
        assertTrue(text.contains("<workpal_thread_context>"));
        assertFalse(text.contains("[seq 1] message-1"));
        assertTrue(text.contains("[seq 6] Assistant: message-6"));
        assertTrue(text.contains("[seq 45] User: message-45"));
        assertTrue(text.indexOf("[seq 6]") < text.indexOf("[seq 45]"));
        // The same PostgreSQL window always yields the same block.
        assertEquals(text, RuntimeEngine.threadAfterSuspensionContext(messages).getTextContent());
    }

    @Test void engineBindsTheSlotOwnerAndRejectsAnotherBinding() throws Exception {
        HttpServer model = emptyModel();
        try {
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"));
            RunRequest.Identity identity = new RunRequest.Identity(
                    "user-1", "space-1", "bot-1", "thread-1", "run-a");
            String sessionKey = "agentscope:chat:v1:" + SessionSlots.hash("user-1\0space-1") + ":"
                    + SessionSlots.hash("bot-1\0thread-1\0" + 0);
            RunRequest.SessionAdmission admission = new RunRequest.SessionAdmission(
                    sessionKey, "exec-a", "attempt-a", 3L, "susp-a");
            engine.execute(request(model.getAddress().getPort(), identity, admission), event -> {});

            String tenant = tenant("user-1", "space-1");
            String session = session("bot-1", "thread-1", 0);
            seedState("bot-1", tenant, session, true);
            Map<String, Object> proof = engine.inspectAndDetach("runtime-1", identity, sessionKey, 0,
                    "exec-a", "attempt-a", 3L, "susp-a", CHECKPOINT_ID);
            assertEquals("detached", proof.get("kind"));
            assertEquals(CHECKPOINT_ID, proof.get("checkpointId"));

            // Run B (another execution binding, even the same Run id) cannot detach.
            assertThrows(SessionCheckpointStore.Conflict.class, () -> engine.inspectAndDetach(
                    "runtime-1", identity, sessionKey, 0, "exec-b", "attempt-b", 4L, "susp-b",
                    "ckpt_bbbbbbb2"));
            assertThrows(SessionCheckpointStore.Conflict.class, () -> engine.inspectAndDetach(
                    "runtime-1", identity, sessionKey, 0, "exec-a", "attempt-a", 4L, "susp-a",
                    CHECKPOINT_ID));
        } finally {
            model.stop(0);
        }
    }

    private RunRequest request(int port, RunRequest.Identity identity,
            RunRequest.SessionAdmission admission) {
        return new RunRequest("bot-1", "thread-1", identity.runId(), "chat", "message-1",
                identity, "Say hello.", "WorkPal", "Reply concisely.", List.of(), List.of(),
                List.of(), List.of(), null,
                new RunRequest.RunModel("local", "fixture", "test-key",
                        "http://127.0.0.1:" + port + "/v1", false, 200, 8192, null, null),
                false, null, 0, null, null, null, null, null, admission, null, null);
    }

    private static HttpServer emptyModel() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            String first = "{\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"created\":0,"
                    + "\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\","
                    + "\"content\":\"Hello.\"},\"finish_reason\":null}]}";
            String finish = "{\"id\":\"c2\",\"object\":\"chat.completion.chunk\",\"created\":0,"
                    + "\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{},"
                    + "\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,"
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

    private static void deleteTree(Path root) throws Exception {
        try (Stream<Path> paths = Files.walk(root)) {
            for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        }
    }
}
