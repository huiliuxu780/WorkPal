package com.workpal.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.agentscope.harness.agent.HarnessAgent;
import io.agentscope.harness.agent.subagent.SubagentDeclaration;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

/**
 * RT-15: production-admission probe for AgentScope 2.0.3 background helpers. Every test drives
 * the real AgentScope Harness through {@link RuntimeEngine}; the HTTP fixture is a model and
 * backend bridge, never a scripted runtime. The package-private delegation seam is used because
 * production keeps delegation suspended (see {@link DelegationSuspensionTest}).
 *
 * <p>What this probe pins:
 * <ul>
 *   <li>the child gets its own AgentScope session id ({@code sub-<uuid>}), never the parent
 *       session, and the child model never receives the parent conversation;</li>
 *   <li>a declared helper that really compacts under 2.0.3's stock config runs the native
 *       memory-flush extraction, appends to the daily memory ledger, and offloads the
 *       conversation transcript: helpers inherit the parent's {@code disableMemoryHooks}, but
 *       {@code ConversationCompactor} calls {@code MemoryFlushManager} directly and stock
 *       {@code CompactionConfig} enables flush/offload before compaction;</li>
 *   <li>registration, delivery to the owning parent session, cancellation only through the
 *       owning identity, and the 2.0.3 failure-flattening gap;</li>
 *   <li>the public SDK surface still cannot configure declared-helper compaction/eviction, and
 *       the production entrypoint still refuses new delegation.</li>
 * </ul>
 */
class AgentScopeBackgroundProbeTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PARENT_SECRET = "PARENT_ONLY_SECRET_7F3A";
    private static final String CHILD_A = "PROBE_CHILD_A";
    private static final String CHILD_B = "PROBE_CHILD_B";
    private static final String CHILD_LONG = "PROBE_CHILD_LONG";
    private static final String CHILD_DELIVER = "PROBE_CHILD_DELIVER";
    private static final String CHILD_CANCEL = "PROBE_CHILD_CANCEL";
    private static final String CHILD_FAIL = "PROBE_CHILD_FAIL";
    /** AgentScope stock compaction summary prompt marker (ConversationCompactor). */
    private static final String SUMMARY_PROMPT = "Context Extraction Assistant";
    /** AgentScope native memory-flush prompt marker (MemoryFlushManager). */
    private static final String FLUSH_PROMPT = "memory extraction assistant";
    /** AgentScope offload summary phrasing, only present when compaction offloads to a file. */
    private static final String OFFLOAD_POINTER = "full conversation history has been saved to";

    @TempDir Path temp;

    // -------------------------------------------------------------------------------
    // 1. Child session identity and parent-conversation isolation.
    // -------------------------------------------------------------------------------

    @Test void childSessionsAreFreshAndNeverReuseTheParentConversation() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<JsonNode> registrations = new CopyOnWriteArrayList<>();
        List<JsonNode> terminals = new CopyOnWriteArrayList<>();
        AtomicInteger spawns = new AtomicInteger();
        HttpServer model = modelServer(requests, body -> {
            String childTask = childTask(body);
            if (childTask != null) return ModelReply.text("CHILD_REPLY_FOR_" + childTask);
            if (spawns.getAndIncrement() < 2) {
                String task = spawns.get() == 1 ? CHILD_A : CHILD_B;
                return ModelReply.spawn(task);
            }
            return ModelReply.text("PARENT_DONE");
        });
        HttpServer bridge = bridge(registrations, terminals, new CopyOnWriteArrayList<>());
        try {
            RuntimeEngine engine = delegationEngine(temp.resolve("state"), temp.resolve("workspace"));
            RunRequest request = chat(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "session-probe", "thread-1", List.of(spawnTool(), noteTool()), 0);
            List<Map<String, Object>> events = new ArrayList<>();
            engine.execute(request, events::add);
            assertEquals("done", events.getLast().get("type"));
            assertTrue(awaitRegistrationCount(registrations, 2), "two spawns must register: " + registrations);
            awaitTerminalCount(terminals, 2);

            assertEquals(2, registrations.size(), registrations.toString());
            Map<String, JsonNode> registrationByTask = new HashMap<>();
            for (JsonNode registration : registrations) {
                registrationByTask.put(registration.path("taskId").asText(), registration);
                assertEquals("helper", registration.path("agentId").asText());
                assertFalse(registration.path("sessionId").asText().isBlank());
            }
            String sessionA = registrationByTask.get(taskIdFor(registrations, 0)).path("sessionId").asText();
            String sessionB = registrationByTask.get(taskIdFor(registrations, 1)).path("sessionId").asText();
            assertNotEquals(sessionA, sessionB,
                    "each background helper must run in a fresh AgentScope session: " + registrations);

            Map<String, JsonNode> records = taskRecords(temp.resolve("workspace"));
            assertEquals(2, records.size(), "native task records: " + records);
            String parentSession = null;
            for (JsonNode registration : registrations) {
                String taskId = registration.path("taskId").asText();
                JsonNode record = records.get(taskId);
                assertNotNull(record, "missing task record for " + taskId + ": " + records.keySet());
                // 2.0.3 leaves TaskRecord.subSessionId null even though the field exists, so the
                // registration body is the only authoritative child-session carrier.
                assertEquals("", record.path("subSessionId").asText(), record.toString());
                assertNotEquals(registration.path("sessionId").asText(),
                        record.path("parentSessionId").asText(),
                        "the child must not reuse the parent session: " + record);
                if (parentSession == null) parentSession = record.path("parentSessionId").asText();
                assertEquals(parentSession, record.path("parentSessionId").asText(),
                        "both siblings belong to the same parent session");
            }
            assertNotNull(parentSession);
            assertFalse(sessionA.equals(parentSession) || sessionB.equals(parentSession));

            for (JsonNode requestBody : requests) {
                String task = childTask(requestBody);
                if (task == null) continue;
                String all = requestBody.path("messages").toString();
                assertFalse(all.contains(PARENT_SECRET),
                        "a child must never receive the parent conversation: " + task);
            }
        } finally { bridge.stop(0); model.stop(0); }
    }

    // -------------------------------------------------------------------------------
    // 2. Real helper compaction and its native side effects.
    // -------------------------------------------------------------------------------

    @Test void declaredHelperCompactionTriggersNativeFlushAndOffloadDespiteSuspension() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<JsonNode> registrations = new CopyOnWriteArrayList<>();
        List<JsonNode> terminals = new CopyOnWriteArrayList<>();
        List<JsonNode> toolCalls = new CopyOnWriteArrayList<>();
        AtomicInteger childCalls = new AtomicInteger();
        HttpServer model = modelServer(requests, body -> {
            String kind = classify(body);
            if ("SUMMARY".equals(kind)) return ModelReply.text("COMPACTED_SUMMARY");
            if ("FLUSH".equals(kind)) return ModelReply.text("- helper memory probe entry");
            if (!isChild(body)) {
                return body.path("messages").toString().contains("task_id:")
                        ? ModelReply.text("PARENT_DONE") : ModelReply.spawn(CHILD_LONG);
            }
            // Six parallel calls per turn, each returning a ~1.8k-char result, put the
            // helper above the stock derived keep budget (8000 tokens) when it crosses
            // the 50-message trigger, so the compactor reaches a non-zero cutoff.
            if (childCalls.incrementAndGet() <= 8) {
                return ModelReply.tools("probe_note", "{\"i\":" + childCalls.get() + "}", 6);
            }
            return ModelReply.text("CHILD_LONG_DONE");
        });
        HttpServer bridge = bridge(registrations, terminals, toolCalls,
                "probe-note " + "x".repeat(1800));
        try {
            RuntimeEngine engine = delegationEngine(temp.resolve("state"), temp.resolve("workspace"));
            RunRequest request = chat(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "compaction-probe", "thread-1", List.of(spawnTool(), noteTool()), 0);
            engine.execute(request, event -> {});
            assertTrue(awaitRegistrationCount(registrations, 1), "helper must register");
            assertTrue(awaitTerminalCount(terminals, 1), "helper must publish a terminal event");

            List<JsonNode> childRequests = requests.stream()
                    .filter(body -> childTask(body) != null || isChild(body)).toList();
            List<String> kinds = childRequests.stream()
                    .map(AgentScopeBackgroundProbeTest::classify).toList();
            List<String> workspaceFiles = filesMatching(temp.resolve("workspace"), path -> true).stream()
                    .map(path -> temp.resolve("workspace").relativize(path).toString()).toList();
            assertTrue(kinds.contains("SUMMARY"),
                    "the helper must really compact for this probe to mean anything: " + kinds);
            // 2.0.3's stock CompactionConfig has flushBeforeCompact=true and
            // offloadBeforeCompact=true. The compactor calls MemoryFlushManager directly,
            // so the parent's disableMemoryHooks does not stop either side effect.
            assertTrue(kinds.contains("FLUSH"),
                    "stock helper compaction must expose the native memory flush; if this stops "
                            + "happening the suspension boundary needs a fresh audit: " + kinds);
            assertTrue(childRequests.stream().anyMatch(body ->
                            body.path("messages").toString().contains(OFFLOAD_POINTER)),
                    "stock helper compaction offloads the transcript and injects the path: " + kinds);
            assertTrue(childRequests.stream().anyMatch(body -> {
                String serialized = body.path("messages").toString();
                return serialized.contains("__compaction_summary__")
                        || serialized.contains("COMPACTED_SUMMARY");
            }), "the compacted summary must be carried into the helper context: " + kinds);
            assertTrue(workspaceFiles.stream().anyMatch(name -> name.contains("/memory/")
                            || name.endsWith("MEMORY.md")),
                    "the flush must be visible as a native memory ledger write; files=" + workspaceFiles);
            assertTrue(workspaceFiles.stream().anyMatch(name -> name.contains("/sessions/")
                            && (name.endsWith(".jsonl") || name.endsWith(".md"))),
                    "the offload must be visible as a native session transcript; files=" + workspaceFiles);
        } finally { bridge.stop(0); model.stop(0); }
    }

    // -------------------------------------------------------------------------------
    // 3. Registration, terminal attribution and delivery bound to the parent session.
    // -------------------------------------------------------------------------------

    @Test void registrationTerminalAndDeliveryStayBoundToTheOwningChildAndSession() throws Exception {
        CountDownLatch parentEnded = new CountDownLatch(1);
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<JsonNode> registrations = new CopyOnWriteArrayList<>();
        List<JsonNode> terminals = new CopyOnWriteArrayList<>();
        HttpServer model = modelServer(requests, body -> {
            String childTask = childTask(body);
            if (childTask != null) {
                awaitQuietly(parentEnded, 10);
                return ModelReply.text("DELIVERED_CHILD_RESULT");
            }
            String all = body.path("messages").toString();
            if (all.contains("DELIVERY_FOLLOW_UP")) return ModelReply.text("DELIVERY_ACK");
            if (all.contains("DELIVERED_CHILD_RESULT")) return ModelReply.text("DELIVERY_ACK");
            return all.contains("task_id:") ? ModelReply.text("PARENT_DONE") : ModelReply.spawn(CHILD_DELIVER);
        });
        HttpServer bridge = bridge(registrations, terminals, new CopyOnWriteArrayList<>());
        try {
            RuntimeEngine engine = delegationEngine(temp.resolve("state"), temp.resolve("workspace"));
            RunRequest parent = chat(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "delivery-parent", "thread-1", List.of(spawnTool()), 0);
            engine.execute(parent, event -> {});
            parentEnded.countDown();
            assertTrue(awaitTerminalCount(terminals, 1), "child terminal event must arrive");
            assertEquals("completed", terminals.getFirst().path("status").asText());
            assertEquals("delivery-parent", terminals.getFirst().path("runId").asText());
            String taskId = terminals.getFirst().path("taskId").asText();
            assertEquals(taskId, registrations.getFirst().path("taskId").asText());
            String childSession = registrations.getFirst().path("sessionId").asText();
            JsonNode record = taskRecords(temp.resolve("workspace")).get(taskId);
            assertNotNull(record, "native task record: " + taskId);
            // AgentScope 2.0.3's TaskRecord has a subSessionId field, but
            // WorkspaceTaskRepository.putTask constructs it with null and nothing ever sets it.
            // WorkPal's registration body (asserted above) is therefore the authoritative
            // carrier of the child session; the native record cannot supply it.
            assertEquals("", record.path("subSessionId").asText(),
                    "if this changes, WorkPal can read the child session from the native record: " + record);
            assertFalse(record.path("parentSessionId").asText().isBlank(), record.toString());
            assertNotEquals(childSession, record.path("parentSessionId").asText());

            // The owning parent session gets the native delivery reminder exactly once.
            RunRequest followUp = chat(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "delivery-follow-up", "thread-1", List.of(), 0, "DELIVERY_FOLLOW_UP same thread");
            engine.execute(followUp, event -> {});
            assertTrue(requests.getLast().path("messages").toString().contains("DELIVERED_CHILD_RESULT"),
                    "same parent session must receive the child result: " + requests.getLast());
            assertNotNull(taskRecords(temp.resolve("workspace")).get(taskId).path("deliveredAt").asText(null),
                    "the delivered task must be marked delivered in the native repository");

            // A different Thread/session must not receive that session's child result.
            RunRequest foreign = chat(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "delivery-foreign", "thread-2", List.of(), 0, "DELIVERY_FOLLOW_UP foreign thread");
            engine.execute(foreign, event -> {});
            assertFalse(requests.getLast().path("messages").toString().contains("DELIVERED_CHILD_RESULT"),
                    "delivery must not leak into another session: " + requests.getLast());
        } finally { parentEnded.countDown(); bridge.stop(0); model.stop(0); }
    }

    // -------------------------------------------------------------------------------
    // 3b. RUNTIME-RELIABILITY-01 regression: the native delivery mark must land in
    //     the same single physical record file the owning child's spawn wrote.
    //     The delegation repository (constructed before the agent exists) and the
    //     temporary delivery repository of a later non-delegation run used to
    //     address the workspace through different views — the agent's manager
    //     applies AgentScope's default USER isolation namespace to filesystem
    //     writes while reads fall back to the un-namespaced path — so
    //     markDelivered created a second, namespaced copy of the record while the
    //     spawn-side file stayed undelivered. Anything walking the session
    //     workspace then saw two divergent records and which one "won" depended on
    //     directory iteration order: the nondeterministic CI failure
    //     "deliveredAt expected not null" at the owning-session probe above.
    // -------------------------------------------------------------------------------

    @Test void deliveryMarkLandsInTheOwningSessionsSingleNativeTaskRecord() throws Exception {
        CountDownLatch parentEnded = new CountDownLatch(1);
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<JsonNode> registrations = new CopyOnWriteArrayList<>();
        List<JsonNode> terminals = new CopyOnWriteArrayList<>();
        HttpServer model = modelServer(requests, body -> {
            String childTask = childTask(body);
            if (childTask != null) {
                awaitQuietly(parentEnded, 10);
                return ModelReply.text("DELIVERED_CHILD_RESULT");
            }
            String all = body.path("messages").toString();
            if (all.contains("DELIVERY_FOLLOW_UP")) return ModelReply.text("DELIVERY_ACK");
            if (all.contains("DELIVERED_CHILD_RESULT")) return ModelReply.text("DELIVERY_ACK");
            return all.contains("task_id:") ? ModelReply.text("PARENT_DONE") : ModelReply.spawn(CHILD_DELIVER);
        });
        HttpServer bridge = bridge(registrations, terminals, new CopyOnWriteArrayList<>());
        try {
            RuntimeEngine engine = delegationEngine(temp.resolve("state"), temp.resolve("workspace"));
            RunRequest parent = chat(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "single-record-parent", "thread-1", List.of(spawnTool()), 0);
            engine.execute(parent, event -> {});
            parentEnded.countDown();
            assertTrue(awaitTerminalCount(terminals, 1), "child terminal event must arrive");
            assertEquals("completed", terminals.getFirst().path("status").asText());
            String taskId = terminals.getFirst().path("taskId").asText();
            assertEquals(taskId, registrations.getFirst().path("taskId").asText());

            // The owning session's follow-up run consumes the delivery through the
            // temporary delivery repository (this run offers no delegation).
            RunRequest followUp = chat(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "single-record-follow-up", "thread-1", List.of(), 0, "DELIVERY_FOLLOW_UP same thread");
            engine.execute(followUp, event -> {});
            assertTrue(requests.getLast().path("messages").toString().contains("DELIVERED_CHILD_RESULT"),
                    "the owning session must receive the child result: " + requests.getLast());

            // The delivery mark must land in the same single physical record the
            // owning child's spawn wrote: one native store per owning session, no
            // divergent second copy left behind by a different addressing view.
            List<Path> recordFiles = taskRecordFilesFor(temp.resolve("workspace"), taskId);
            assertEquals(1, recordFiles.size(),
                    "the owning session's native task record must exist exactly once: " + recordFiles);
            JsonNode record = JSON.readTree(Files.readString(recordFiles.getFirst())).path(taskId);
            assertEquals(TaskStatusView.COMPLETED, TaskStatusView.of(record.path("status").asText()),
                    record.toString());
            assertFalse(record.path("deliveredAt").asText("").isBlank(),
                    "the delivered task must be marked delivered in the native repository: " + record);
            String childSession = registrations.getFirst().path("sessionId").asText();
            assertFalse(record.path("parentSessionId").asText().isBlank(), record.toString());
            assertNotEquals(childSession, record.path("parentSessionId").asText(),
                    "the record stays bound to the owning parent session, never the child session");
        } finally { parentEnded.countDown(); bridge.stop(0); model.stop(0); }
    }

    // -------------------------------------------------------------------------------
    // 4. Cancellation: owner-only, really stops the child, and is attributed by task id.
    // -------------------------------------------------------------------------------

    @Test void cancellationIsOwnerOnlyStopsTheChildAndIsAttributedToItsTask() throws Exception {
        CountDownLatch childStarted = new CountDownLatch(1);
        CountDownLatch releaseChild = new CountDownLatch(1);
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<JsonNode> registrations = new CopyOnWriteArrayList<>();
        List<JsonNode> terminals = new CopyOnWriteArrayList<>();
        List<JsonNode> toolCalls = new CopyOnWriteArrayList<>();
        HttpServer model = modelServer(requests, body -> {
            String childTask = childTask(body);
            if (childTask != null) {
                childStarted.countDown();
                awaitQuietly(releaseChild, 10);
                return ModelReply.tool("probe_note", "{}");
            }
            return body.path("messages").toString().contains("task_id:")
                    ? ModelReply.text("PARENT_DONE") : ModelReply.spawn(CHILD_CANCEL);
        });
        HttpServer bridge = bridge(registrations, terminals, toolCalls);
        try {
            RuntimeEngine engine = delegationEngine(temp.resolve("state"), temp.resolve("workspace"));
            RunRequest parent = chat(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "cancel-parent", "thread-1", List.of(spawnTool(), noteTool()), 0);
            engine.execute(parent, event -> {});
            assertTrue(childStarted.await(5, TimeUnit.SECONDS));
            String taskId = registrations.getFirst().path("taskId").asText();

            RunRequest.Identity foreign = new RunRequest.Identity("other-user", "space-1", "bot-1",
                    "thread-1", "other-run");
            assertFalse(engine.cancelTask(foreign, taskId),
                    "a foreign identity must not cancel another Run's child");
            assertEquals(0, terminals.size(), "foreign cancel must not terminate the task");

            assertTrue(engine.cancelTask(parent.identity(), taskId));
            assertTrue(awaitTerminalCount(terminals, 1), "cancellation must publish a terminal event");
            assertEquals("cancelled", terminals.getFirst().path("status").asText());
            assertEquals(taskId, terminals.getFirst().path("taskId").asText());

            releaseChild.countDown();
            Thread.sleep(400);
            assertTrue(toolCalls.isEmpty(), "a cancelled child must not reach backend tools");
            assertEquals(TaskStatusView.CANCELLED,
                    TaskStatusView.of(taskRecords(temp.resolve("workspace")).get(taskId).path("status").asText()));
        } finally { releaseChild.countDown(); bridge.stop(0); model.stop(0); }
    }

    // -------------------------------------------------------------------------------
    // 5. Failure attribution: 2.0.3 flattens child exceptions into a completed result.
    // -------------------------------------------------------------------------------

    @Test void childFailureIsFlattenedIntoACompletedTerminalInAgentScope203() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<JsonNode> registrations = new CopyOnWriteArrayList<>();
        List<JsonNode> terminals = new CopyOnWriteArrayList<>();
        HttpServer model = modelServer(requests, body -> {
            if (childTask(body) != null) return ModelReply.httpError(500, "child model exploded");
            return body.path("messages").toString().contains("task_id:")
                    ? ModelReply.text("PARENT_DONE") : ModelReply.spawn(CHILD_FAIL);
        });
        HttpServer bridge = bridge(registrations, terminals, new CopyOnWriteArrayList<>());
        try {
            RuntimeEngine engine = delegationEngine(temp.resolve("state"), temp.resolve("workspace"));
            RunRequest parent = chat(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "failure-parent", "thread-1", List.of(spawnTool()), 0);
            engine.execute(parent, event -> {});
            assertTrue(awaitTerminalCount(terminals, 1), "failure terminal must arrive");
            String taskId = registrations.getFirst().path("taskId").asText();
            // AgentSpawnTool.lambda$execSpawnTask$28 catches RuntimeException from the child
            // and returns getMessage() as an ordinary string result, so the repository marks
            // the task COMPLETED. A failed terminal event is therefore NOT observable through
            // this path in 2.0.3; the error only survives as text inside a completed result.
            assertEquals("completed", terminals.getFirst().path("status").asText(),
                    "2.0.3 flattens child exceptions; if this becomes failed, the failure "
                            + "attribution gap is closed: " + terminals.getFirst());
            assertEquals(taskId, terminals.getFirst().path("taskId").asText());
            assertTrue(terminals.getFirst().path("result").asText().contains("Retries exhausted"),
                    "the child error only survives as flattened text: " + terminals.getFirst());
            JsonNode record = taskRecords(temp.resolve("workspace")).get(taskId);
            assertEquals(TaskStatusView.COMPLETED, TaskStatusView.of(record.path("status").asText()));
            assertTrue(record.path("result").asText().contains("Retries exhausted"), record.toString());
        } finally { bridge.stop(0); model.stop(0); }
    }

    // -------------------------------------------------------------------------------
    // 6. SDK API gap and production gate.
    // -------------------------------------------------------------------------------

    @Test void agentScope203StillOffersNoHelperCompactionOrEvictionConfiguration() throws Exception {
        assertTrue(Arrays.stream(SubagentDeclaration.Builder.class.getMethods())
                        .noneMatch(method -> method.getName().toLowerCase().contains("compaction")
                                || method.getName().toLowerCase().contains("eviction")),
                "if this changes, re-audit whether a declared helper can be given the safe config");
        assertNotNull(HarnessAgent.builder().getClass().getMethod("disableToolResultEviction"));
        assertNotNull(HarnessAgent.builder().getClass().getMethod("disableCompaction"));
    }

    @Test void productionConstructorStillRefusesNewDelegation() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        HttpServer model = modelServer(requests, body -> requests.size() == 1
                ? ModelReply.tool("agent_spawn", "{\"agent_id\":\"helper\",\"task\":\"" + CHILD_A
                        + "\",\"timeout_seconds\":0}")
                : ModelReply.text("NO_DELEGATION"));
        HttpServer bridge = bridge(new CopyOnWriteArrayList<>(), new CopyOnWriteArrayList<>(),
                new CopyOnWriteArrayList<>());
        try {
            RuntimeEngine production = new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"));
            RunRequest request = chat(model.getAddress().getPort(), bridge.getAddress().getPort(),
                    "production-gate", "thread-1", List.of(spawnTool()), 0);
            try {
                production.execute(request, event -> {});
            } catch (Exception expected) {
                // A refused spawn may surface as a run error; the gate assertions below matter.
            }
            for (JsonNode body : requests) {
                for (JsonNode tool : body.path("tools")) {
                    assertNotEquals("agent_spawn", tool.path("function").path("name").asText());
                }
            }
            assertTrue(taskRecords(temp.resolve("workspace")).isEmpty(),
                    "the production entrypoint must not register a native child task");
        } finally { bridge.stop(0); model.stop(0); }
    }

    // ============================ fixtures ============================

    private record ToolCall(String name, String arguments) {}

    private record ModelReply(List<ToolCall> calls, String text, int status, String error) {
        static ModelReply spawn(String task) {
            return tool("agent_spawn", "{\"agent_id\":\"helper\",\"task\":\"" + task
                    + "\",\"timeout_seconds\":0}");
        }
        static ModelReply tool(String name, String arguments) {
            return tools(name, arguments, 1);
        }
        static ModelReply tools(String name, String arguments, int count) {
            List<ToolCall> calls = new ArrayList<>();
            for (int index = 0; index < count; index++) calls.add(new ToolCall(name, arguments));
            return new ModelReply(calls, null, 200, null);
        }
        static ModelReply text(String text) { return new ModelReply(List.of(), text, 200, null); }
        static ModelReply httpError(int status, String error) {
            return new ModelReply(List.of(), null, status, error);
        }
    }

    private interface ModelBehavior { ModelReply reply(JsonNode body); }

    private static HttpServer modelServer(List<JsonNode> requests, ModelBehavior behavior) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        AtomicInteger callSequence = new AtomicInteger();
        server.createContext("/v1/chat/completions", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            requests.add(body);
            // AgentScope's native internal calls (memory flush, compaction summary) are not
            // agent turns; answer them directly so a probe fixture never mistakes them for a
            // parent/child turn. Their requests remain in `requests` for assertions.
            String internal = classify(body);
            ModelReply reply = "SUMMARY".equals(internal) ? ModelReply.text("PROBE_SUMMARY")
                    : "FLUSH".equals(internal) ? ModelReply.text("- PROBE_NATIVE_MEMORY_ENTRY")
                    : behavior.reply(body);
            if (reply.status() != 200) {
                byte[] error = ("{\"error\":\"" + reply.error() + "\"}").getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("content-type", "application/json");
                exchange.sendResponseHeaders(reply.status(), error.length);
                try (var output = exchange.getResponseBody()) { output.write(error); }
            } else if (!reply.calls().isEmpty()) {
                // Tool-call ids must be unique across turns; AgentScope matches results by id
                // and silently drops a repeated id, which would hide a second spawn.
                streamTools(exchange, reply.calls(), "call-" + callSequence.incrementAndGet());
            } else {
                streamText(exchange, reply.text());
            }
        });
        server.start();
        return server;
    }

    private static HttpServer bridge(List<JsonNode> registrations, List<JsonNode> terminals,
            List<JsonNode> toolCalls) throws Exception {
        return bridge(registrations, terminals, toolCalls, "note ok");
    }

    private static HttpServer bridge(List<JsonNode> registrations, List<JsonNode> terminals,
            List<JsonNode> toolCalls, String noteResult) throws Exception {
        HttpServer bridge = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        bridge.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        bridge.createContext("/v1/background-tasks", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            assertEquals("Bearer bridge-secret", exchange.getRequestHeaders().getFirst("authorization"));
            registrations.add(body);
            respond(exchange, 200, "{\"token\":\"task-secret\"}");
        });
        bridge.createContext("/v1/background-tasks/events", exchange -> {
            assertEquals("Bearer task-secret", exchange.getRequestHeaders().getFirst("authorization"));
            terminals.add(JSON.readTree(exchange.getRequestBody()));
            respond(exchange, 200, "{\"ok\":true}");
        });
        String toolBody = JSON.writeValueAsString(Map.of("status", "ok",
                "result", Map.of("value", noteResult)));
        bridge.createContext("/v1/tool-executions", exchange -> {
            toolCalls.add(JSON.readTree(exchange.getRequestBody()));
            respond(exchange, 200, toolBody);
        });
        bridge.start();
        return bridge;
    }

    private static RunRequest chat(int modelPort, int bridgePort, String runId, String thread,
            List<RunRequest.ToolDefinition> tools, int sessionGeneration) {
        return chat(modelPort, bridgePort, runId, thread, tools, sessionGeneration,
                "Say hello. " + PARENT_SECRET);
    }

    private static RunRequest chat(int modelPort, int bridgePort, String runId, String thread,
            List<RunRequest.ToolDefinition> tools, int sessionGeneration, String prompt) {
        RunRequest.Identity identity = new RunRequest.Identity("user-1", "space-1", "bot-1", thread, runId);
        String origin = "http://127.0.0.1:" + bridgePort;
        RunRequest.ToolBridge bridge = new RunRequest.ToolBridge(origin + "/v1/tool-executions",
                null, null, origin + "/v1/background-tasks", origin + "/v1/background-tasks/events",
                "bridge-secret", identity);
        return new RunRequest("bot-1", thread, runId, "chat", "message-1", identity,
                prompt, "WorkPal", "Reply concisely.", List.of(), List.of(),
                List.of(), tools, bridge,
                new RunRequest.RunModel("local", "fixture", "test-key",
                        "http://127.0.0.1:" + modelPort + "/v1", false, 200, 200_000, null, null),
                false, null, sessionGeneration);
    }

    private static RunRequest.ToolDefinition spawnTool() {
        return new RunRequest.ToolDefinition("run_subagent", "Delegate", Map.of("type", "object"), true);
    }

    private static RunRequest.ToolDefinition noteTool() {
        return new RunRequest.ToolDefinition("probe_note", "Write a note",
                Map.of("type", "object", "properties", Map.of("i", Map.of("type", "integer"))), true);
    }

    private static RuntimeEngine delegationEngine(Path state, Path workspace) {
        return new RuntimeEngine(JSON, state, workspace, RuntimeEngine.productionCompaction(), false);
    }

    /** Returns the child task marker when this request is a helper call, otherwise null. */
    private static String childTask(JsonNode body) {
        for (JsonNode message : body.path("messages")) {
            if (!"user".equals(message.path("role").asText())) continue;
            String content = message.path("content").toString();
            for (String task : List.of(CHILD_A, CHILD_B, CHILD_LONG, CHILD_DELIVER, CHILD_CANCEL, CHILD_FAIL)) {
                if (content.contains(task)) return task;
            }
        }
        return null;
    }

    private static String classify(JsonNode body) {
        String all = body.path("messages").toString();
        if (all.contains(SUMMARY_PROMPT)) return "SUMMARY";
        if (all.contains(FLUSH_PROMPT)) return "FLUSH";
        return "NORMAL";
    }

    /** Declared helpers carry AgentScope's subagent system prompt on every model call. */
    private static boolean isChild(JsonNode body) {
        JsonNode messages = body.path("messages");
        return !messages.isEmpty()
                && messages.get(0).path("content").toString().contains("spawned by the main agent");
    }

    private static void streamText(HttpExchange exchange, String text) throws java.io.IOException {
        Map<String, Object> delta = new HashMap<>();
        delta.put("role", "assistant");
        delta.put("content", text);
        stream(exchange, delta, "stop");
    }

    private static void streamTools(HttpExchange exchange, List<ToolCall> calls, String idPrefix)
            throws java.io.IOException {
        List<Map<String, Object>> toolCalls = new ArrayList<>();
        for (int index = 0; index < calls.size(); index++) {
            ToolCall call = calls.get(index);
            toolCalls.add(Map.of("index", index, "id", idPrefix + "-" + index, "type", "function",
                    "function", Map.of("name", call.name(), "arguments", call.arguments())));
        }
        Map<String, Object> delta = new HashMap<>();
        delta.put("role", "assistant");
        delta.put("tool_calls", toolCalls);
        stream(exchange, delta, "tool_calls");
    }

    private static void stream(HttpExchange exchange, Map<String, Object> delta, String finish)
            throws java.io.IOException {
        Map<String, Object> first = new HashMap<>();
        first.put("index", 0); first.put("delta", delta); first.put("finish_reason", null);
        String prefix = "{\"id\":\"f\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"fixture\",\"choices\":";
        byte[] stream = ("data: " + prefix + JSON.writeValueAsString(List.of(first)) + "}\n\n"
                + "data: " + prefix + JSON.writeValueAsString(List.of(Map.of("index", 0, "delta", Map.of(),
                "finish_reason", finish))) + "}\n\n"
                + "data: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "text/event-stream");
        exchange.sendResponseHeaders(200, 0);
        try (var output = exchange.getResponseBody()) { output.write(stream); output.flush(); }
    }

    private static void respond(HttpExchange exchange, int status, String body) throws java.io.IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) { output.write(bytes); }
    }

    private static boolean awaitRegistrationCount(List<JsonNode> registrations, int count) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            if (registrations.size() >= count) return true;
            Thread.sleep(50);
        }
        return registrations.size() >= count;
    }

    private static boolean awaitTerminalCount(List<JsonNode> terminals, int count) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
        while (System.nanoTime() < deadline) {
            if (terminals.size() >= count) return true;
            Thread.sleep(50);
        }
        return terminals.size() >= count;
    }

    private static String taskIdFor(List<JsonNode> registrations, int index) {
        return registrations.get(index).path("taskId").asText();
    }

    private static Map<String, JsonNode> taskRecords(Path workspace) throws Exception {
        Map<String, JsonNode> records = new HashMap<>();
        if (!Files.exists(workspace)) return records;
        try (var walk = Files.walk(workspace)) {
            for (Path path : walk.filter(Files::isRegularFile)
                    .filter(path -> path.toString().contains("/tasks/")
                            && path.toString().endsWith(".json")).toList()) {
                JsonNode stored = JSON.readTree(Files.readString(path));
                stored.fieldNames().forEachRemaining(taskId -> records.put(taskId, stored.path(taskId)));
            }
        }
        return records;
    }

    /** Every physical native task-record file in the workspace that carries this task. */
    private static List<Path> taskRecordFilesFor(Path workspace, String taskId) throws Exception {
        List<Path> files = new ArrayList<>();
        if (!Files.exists(workspace)) return files;
        try (var walk = Files.walk(workspace)) {
            for (Path path : walk.filter(Files::isRegularFile)
                    .filter(path -> path.toString().contains("/tasks/")
                            && path.toString().endsWith(".json")).toList()) {
                if (JSON.readTree(Files.readString(path)).has(taskId)) files.add(path);
            }
        }
        return files;
    }

    private static List<Path> filesMatching(Path root, java.util.function.Predicate<Path> match) {
        List<Path> files = new ArrayList<>();
        if (!Files.exists(root)) return files;
        try (var walk = Files.walk(root)) {
            walk.filter(Files::isRegularFile).filter(match).forEach(files::add);
        } catch (Exception ignored) {
            // The assertion message reports what was found; a walk failure means none.
        }
        return files;
    }

    private static void awaitQuietly(CountDownLatch latch, int seconds) {
        try { latch.await(seconds, TimeUnit.SECONDS); } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    /** AgentScope task status values observed in the native record, kept as a small guard. */
    private enum TaskStatusView {
        COMPLETED, FAILED, CANCELLED, OTHER;

        static TaskStatusView of(String value) {
            try { return valueOf(value); } catch (IllegalArgumentException error) { return OTHER; }
        }
    }
}
