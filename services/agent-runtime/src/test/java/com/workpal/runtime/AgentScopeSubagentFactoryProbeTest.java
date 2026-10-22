package com.workpal.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.agentscope.core.ReActAgent;
import io.agentscope.core.agent.Agent;
import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.event.AgentEvent;
import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.middleware.MiddlewareBase;
import io.agentscope.core.model.ChatResponse;
import io.agentscope.core.middleware.ReasoningInput;
import io.agentscope.core.model.GenerateOptions;
import io.agentscope.core.model.Model;
import io.agentscope.core.model.ToolSchema;
import io.agentscope.core.permission.PermissionBehavior;
import io.agentscope.core.permission.PermissionContextState;
import io.agentscope.core.permission.PermissionMode;
import io.agentscope.core.permission.PermissionRule;
import io.agentscope.core.state.InMemoryAgentStateStore;
import io.agentscope.core.tool.AgentTool;
import io.agentscope.core.tool.ToolCallParam;
import io.agentscope.core.tool.Toolkit;
import io.agentscope.core.message.Msg;
import io.agentscope.harness.agent.HarnessAgent;
import io.agentscope.harness.agent.memory.compaction.CompactionConfig;
import io.agentscope.harness.agent.memory.compaction.TokenCounterUtil;
import io.agentscope.harness.agent.subagent.task.BackgroundTask;
import io.agentscope.harness.agent.subagent.task.TaskStatus;
import io.agentscope.harness.agent.workspace.WorkspaceManager;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import static org.junit.jupiter.api.Assertions.*;

/**
 * RT-15 follow-up: can a public {@code subagentFactory} turn a declared-helper
 * replacement into a safe background adapter? The tests drive a real
 * {@link HarnessAgent}; the HTTP fixture is a model endpoint, not a scripted
 * runtime. Production delegation remains suspended and is not touched here.
 */
class AgentScopeSubagentFactoryProbeTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PARENT_MARK = "CUSTOM_FACTORY_PARENT_PROBE";
    private static final String PARENT_SECRET = "PARENT_ONLY_SECRET_FACTORY_9C1";
    private static final String CHILD_MARK = "CUSTOM_FACTORY_CHILD_PROBE";
    private static final String CHILD_A = "PROBE_FACTORY_CHILD_A";
    private static final String CHILD_B = "PROBE_FACTORY_CHILD_B";
    private static final String CHILD_LONG = "PROBE_FACTORY_CHILD_LONG";
    private static final String CHILD_DELIVER = "PROBE_FACTORY_CHILD_DELIVER";
    private static final String CHILD_CANCEL = "PROBE_FACTORY_CHILD_CANCEL";
    private static final String CHILD_READONLY = "PROBE_FACTORY_CHILD_READONLY";
    private static final String CHILD_BUILTIN = "PROBE_FACTORY_BUILTIN_GENERAL";
    private static final String CHILD_FAIL = "PROBE_FACTORY_CHILD_FAIL";
    private static final String SUMMARY_PROMPT = "Context Extraction Assistant";
    private static final String FLUSH_PROMPT = "memory extraction assistant";
    private static final String OFFLOAD_POINTER = "full conversation history has been saved to";
    private static final Pattern TASK_ID = Pattern.compile("task_id:\\s*([^\\s\\\\\"]+)");
    private static final Pattern SESSION_ID = Pattern.compile("session_id:\\s*([^\\s\\\\\"]+)");

    @TempDir Path temp;

    @Test void customFactoryChildrenUseFreshSessionsAndIsolateParentConversation() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        AtomicInteger parentSpawns = new AtomicInteger();
        HttpServer model = modelServer(requests, body -> {
            if (isChild(body)) return ModelReply.text("CHILD_REPLY_" + childTask(body));
            if (parentSpawns.getAndIncrement() < 2) {
                return ModelReply.spawn(parentSpawns.get() == 1 ? CHILD_A : CHILD_B);
            }
            return ModelReply.text("PARENT_DONE");
        });
        Path parentWorkspace = temp.resolve("parent-workspace");
        Path childWorkspace = temp.resolve("child-workspace");
        Model client = fixtureModel(model);
        HarnessAgent parent = parentAgent(client, parentWorkspace,
                ignored -> normalChild(client, childWorkspace));
        try {
            RuntimeContext context = parentContext("parent-session-1");
            parent.call("Say hello. " + PARENT_SECRET, context).block();

            List<Spawn> spawns = awaitSpawns(requests, 2);
            assertEquals(2, spawns.size(), requests.toString());
            assertNotEquals(spawns.get(0).sessionId(), spawns.get(1).sessionId(),
                    "each factory child must get its own AgentScope session: " + spawns);
            for (Spawn spawn : spawns) {
                assertEquals("helper", spawn.agentId());
                assertTrue(spawn.sessionId().startsWith("sub-"), spawn.toString());
                assertFalse(spawn.sessionId().isBlank());
            }
            assertEquals("parent-session-1", context.getSessionId());
            assertFalse(spawns.get(0).sessionId().equals(context.getSessionId()));

            Collection<BackgroundTask> tasks = awaitTasks(parent, context, 2);
            List<String> taskIds = tasks.stream().map(BackgroundTask::getTaskId).toList();
            for (Spawn spawn : spawns) {
                assertTrue(taskIds.contains(spawn.taskId()),
                        "spawn identity must match the native task record: " + spawn + " / " + taskIds);
            }
            for (BackgroundTask task : tasks) {
                assertTrue(task.waitForCompletion(20_000), "child did not finish: " + task.getTaskId());
                assertEquals(TaskStatus.COMPLETED, task.getTaskStatus(), task.getStatus());
                assertTrue(task.getResult().contains("CHILD_REPLY_"), task.getResult());
            }

            for (JsonNode request : requests) {
                if (!isChild(request)) continue;
                assertFalse(request.path("messages").toString().contains(PARENT_SECRET),
                        "a factory child must never inherit the parent chat: " + request);
            }
            Map<String, JsonNode> records = taskRecords(parentWorkspace);
            assertEquals(2, records.size(), records.toString());
            String parentSession = null;
            for (Spawn spawn : spawns) {
                JsonNode record = records.get(spawn.taskId());
                assertNotNull(record, "missing native task record for " + spawn.taskId() + ": " + records);
                assertEquals("", record.path("subSessionId").asText(),
                        "the native record still cannot carry the child session: " + record);
                assertNotEquals(spawn.sessionId(), record.path("parentSessionId").asText());
                if (parentSession == null) parentSession = record.path("parentSessionId").asText();
                assertEquals(parentSession, record.path("parentSessionId").asText());
            }
        } finally {
            parent.close();
            model.stop(0);
        }
    }

    @Test void safeFactoryCompactionAvoidsNativeMemoryAndTranscriptArtifacts() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        AtomicInteger childCalls = new AtomicInteger();
        HttpServer model = modelServer(requests, body -> {
            if (isChild(body)) {
                // Six parallel results per turn, each ~1.8k chars, keep the helper above
                // the stock 8,000-token keep budget when it crosses 50 messages.
                if (childCalls.incrementAndGet() <= 8) {
                    return ModelReply.tools("probe_read", "{\"i\":" + childCalls.get() + "}", 6);
                }
                return ModelReply.text("CHILD_LONG_DONE");
            }
            return body.path("messages").toString().contains("task_id:")
                    ? ModelReply.text("PARENT_DONE") : ModelReply.spawn(CHILD_LONG);
        });
        Path parentWorkspace = temp.resolve("parent-workspace");
        Path childWorkspace = temp.resolve("child-workspace");
        Model client = fixtureModel(model);
        ContextProbe probe = new ContextProbe();
        HarnessAgent parent = parentAgent(client, parentWorkspace,
                ignored -> normalChild(client, childWorkspace, probe));
        try {
            RuntimeContext context = parentContext("compaction-parent");
            parent.call("Delegate a long read-only task.", context).block();
            List<Spawn> spawns = awaitSpawns(requests, 1);
            assertEquals(1, spawns.size(), requests.toString());
            BackgroundTask task = awaitTasks(parent, context, 1).iterator().next();
            assertTrue(task.waitForCompletion(60_000), "helper did not finish: " + task.getStatus());
            assertEquals(TaskStatus.COMPLETED, task.getTaskStatus(), task.getStatus());

            List<JsonNode> childRequests = requests.stream()
                    .filter(body -> isChild(body) || childTask(body).equals(CHILD_LONG))
                    .toList();
            List<String> kinds = childRequests.stream()
                    .map(AgentScopeSubagentFactoryProbeTest::classify).toList();
            assertTrue(kinds.contains("SUMMARY"),
                    "the safe factory helper must really compact under the stock trigger: " + kinds);
            assertFalse(kinds.contains("FLUSH"),
                    "flushBeforeCompact(false) must prevent the native memory flush: " + kinds);
            assertFalse(childRequests.stream().anyMatch(body ->
                            body.toString().contains(OFFLOAD_POINTER)),
                    "offloadBeforeCompact(false) must prevent a dangling transcript pointer: " + kinds);
            assertTrue(childRequests.stream().anyMatch(body -> {
                String serialized = body.toString();
                return serialized.contains("__compaction_summary__")
                        || serialized.contains("FACTORY_COMPACTED_SUMMARY");
            }), "the compacted summary must be carried into the helper context: " + kinds);
            assertTrue(probe.maxMessages.get() >= 50,
                    "the helper must cross the stock 50-message trigger, not a lowered fixture load: "
                            + probe.maxMessages.get());
            assertTrue(probe.maxTokens.get() > 8_000,
                    "the helper must exceed the 8,000-token keep budget: " + probe.maxTokens.get());

            List<String> childFiles = filesMatching(childWorkspace, path -> true).stream()
                    .map(path -> childWorkspace.relativize(path).toString()).toList();
            assertTrue(childFiles.stream().noneMatch(name -> name.contains("/memory/")
                            || name.endsWith("MEMORY.md")),
                    "safe compaction must not write a native memory ledger: files=" + childFiles);
            assertTrue(childFiles.stream().noneMatch(name -> name.contains("/sessions/")
                            && (name.endsWith(".jsonl") || name.endsWith(".md"))),
                    "safe compaction must not write a native transcript offload: files=" + childFiles);
            JsonNode record = taskRecords(parentWorkspace).get(spawns.getFirst().taskId());
            assertNotNull(record, "native task record: " + taskRecords(parentWorkspace));
            assertEquals("", record.path("subSessionId").asText(), record.toString());
        } finally {
            parent.close();
            model.stop(0);
        }
    }

    @Test void unmodifiedFactoryChildFailureIsStillFlattenedIntoCompleted() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        HttpServer model = modelServer(requests, body -> {
            if (isChild(body)) return ModelReply.httpError(500, "factory child exploded");
            return body.path("messages").toString().contains("task_id:")
                    ? ModelReply.text("PARENT_DONE") : ModelReply.spawn(CHILD_FAIL);
        });
        Path parentWorkspace = temp.resolve("parent-workspace");
        Path childWorkspace = temp.resolve("child-workspace");
        Model client = fixtureModel(model);
        HarnessAgent parent = parentAgent(client, parentWorkspace,
                ignored -> normalChild(client, childWorkspace));
        try {
            RuntimeContext context = parentContext("plain-failure-parent");
            parent.call("Delegate a failing task.", context).block();
            List<Spawn> spawns = awaitSpawns(requests, 1);
            assertEquals(1, spawns.size(), requests.toString());
            BackgroundTask task = awaitTasks(parent, context, 1).iterator().next();
            assertTrue(task.waitForCompletion(30_000), "failing helper did not finish");
            // 2.0.3's AgentSpawnTool catches the child RuntimeException and returns its
            // message as a normal result. A custom factory does not change that boundary.
            assertEquals(TaskStatus.COMPLETED, task.getTaskStatus(), task.getStatus());
            assertTrue(task.getResult().startsWith("Error:"),
                    "the child error only survives as flattened text: " + task.getResult());
            JsonNode record = taskRecords(parentWorkspace).get(spawns.getFirst().taskId());
            assertEquals("COMPLETED", record.path("status").asText(), record.toString());
        } finally {
            parent.close();
            model.stop(0);
        }
    }

    @Test void typedErrorFromFactoryChildModelIsStillFlattenedIntoCompleted() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        HttpServer model = modelServer(requests, body -> body.path("messages").toString().contains("task_id:")
                ? ModelReply.text("PARENT_DONE") : ModelReply.spawn(CHILD_FAIL));
        Path parentWorkspace = temp.resolve("parent-workspace");
        Path childWorkspace = temp.resolve("child-workspace");
        Model client = fixtureModel(model);
        Model failingChildModel = new TypedFailureModel(client);
        HarnessAgent parent = parentAgent(client, parentWorkspace,
                ignored -> normalChild(failingChildModel, childWorkspace));
        try {
            RuntimeContext context = parentContext("typed-failure-parent");
            parent.call("Delegate a typed failure.", context).block();
            List<Spawn> spawns = awaitSpawns(requests, 1);
            assertEquals(1, spawns.size(), requests.toString());
            BackgroundTask task = awaitTasks(parent, context, 1).iterator().next();
            assertTrue(task.waitForCompletion(30_000), "typed failing helper did not finish");
            // Even an Error raised by the child model is converted into an ordinary result
            // before the task repository sees it; a custom factory cannot change this
            // boundary in 2.0.3. Pin the unsafe behavior rather than treating text as failure.
            assertEquals(TaskStatus.COMPLETED, task.getTaskStatus(), task.getStatus());
            assertTrue(task.getResult().startsWith("Error:"), task.getResult());
            assertTrue(task.getResult().contains("TypedFailureError"), task.getResult());
            JsonNode record = taskRecords(parentWorkspace).get(spawns.getFirst().taskId());
            assertEquals("COMPLETED", record.path("status").asText(), record.toString());
        } finally {
            parent.close();
            model.stop(0);
        }
    }

    @Test void factoryChildCancellationIsOwnerBoundAndStopsWork() throws Exception {
        CountDownLatch childStarted = new CountDownLatch(1);
        CountDownLatch releaseChild = new CountDownLatch(1);
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        AtomicInteger childCalls = new AtomicInteger();
        HttpServer model = modelServer(requests, body -> {
            if (isChild(body)) {
                if (childCalls.incrementAndGet() == 1) {
                    childStarted.countDown();
                    awaitQuietly(releaseChild, 10);
                    return ModelReply.tool("probe_read", "{}");
                }
                return ModelReply.text("CHILD_CANCEL_DONE");
            }
            return body.path("messages").toString().contains("task_id:")
                    ? ModelReply.text("PARENT_DONE") : ModelReply.spawn(CHILD_CANCEL);
        });
        Path parentWorkspace = temp.resolve("parent-workspace");
        Path childWorkspace = temp.resolve("child-workspace");
        Model client = fixtureModel(model);
        ProbeTool probeRead = new ProbeTool("probe_read", "Read probe", true);
        Toolkit childToolkit = new Toolkit();
        childToolkit.registerAgentTool(probeRead);
        HarnessAgent parent = parentAgent(client, parentWorkspace,
                ignored -> childAgent(client, childWorkspace, childToolkit, true));
        try {
            RuntimeContext context = parentContext("cancel-parent");
            parent.call("Delegate a task I will cancel.", context).block();
            List<Spawn> spawns = awaitSpawns(requests, 1);
            assertEquals(1, spawns.size(), requests.toString());
            assertTrue(childStarted.await(10, TimeUnit.SECONDS), "child model must start");
            BackgroundTask task = awaitTasks(parent, context, 1).iterator().next();
            assertEquals(TaskStatus.RUNNING, task.getTaskStatus(), task.getStatus());

            RuntimeContext foreign = RuntimeContext.builder().userId("other-user")
                    .sessionId("foreign-parent").build();
            assertFalse(parent.getTaskRepository().cancelTask(foreign, foreign.getSessionId(),
                    spawns.getFirst().taskId()), "a foreign parent session must not cancel the child");
            assertFalse(task.waitForCompletion(500),
                    "a foreign cancellation must not interrupt or settle the blocked child worker");
            assertEquals(TaskStatus.RUNNING, task.getTaskStatus(), task.getStatus());

            assertTrue(parent.getTaskRepository().cancelTask(context, context.getSessionId(),
                    spawns.getFirst().taskId()), "the owning parent session must cancel the child");
            assertTrue(task.waitForCompletion(10_000), "cancellation must settle the task");
            assertEquals(TaskStatus.CANCELLED, task.getTaskStatus(), task.getStatus());
            releaseChild.countDown();
            Thread.sleep(500);
            assertEquals(0, probeRead.calls(), "a cancelled factory child must not execute tools");
            JsonNode record = taskRecords(parentWorkspace).get(spawns.getFirst().taskId());
            assertEquals("CANCELLED", record.path("status").asText(), record.toString());
        } finally {
            releaseChild.countDown();
            parent.close();
            model.stop(0);
        }
    }

    @Test void factoryDeliveryStaysInTheOwningParentSession() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        HttpServer model = modelServer(requests, body -> {
            if (isChild(body)) return ModelReply.text("DELIVERED_FACTORY_CHILD_RESULT");
            String all = body.path("messages").toString();
            if (all.contains("DELIVERY_FOLLOW_UP") || all.contains("DELIVERY_FOREIGN")) {
                return ModelReply.text("DELIVERY_ACK");
            }
            return all.contains("task_id:")
                    ? ModelReply.text("PARENT_DONE") : ModelReply.spawn(CHILD_DELIVER);
        });
        Path parentWorkspace = temp.resolve("parent-workspace");
        Path childWorkspace = temp.resolve("child-workspace");
        Model client = fixtureModel(model);
        HarnessAgent parent = parentAgent(client, parentWorkspace,
                ignored -> normalChild(client, childWorkspace));
        try {
            RuntimeContext context = parentContext("delivery-parent");
            parent.call("Delegate a delivery probe.", context).block();
            List<Spawn> spawns = awaitSpawns(requests, 1);
            assertEquals(1, spawns.size(), requests.toString());
            BackgroundTask task = awaitTasks(parent, context, 1).iterator().next();
            assertTrue(task.waitForCompletion(20_000), "child did not finish");
            assertEquals(TaskStatus.COMPLETED, task.getTaskStatus(), task.getStatus());
            JsonNode record = taskRecords(parentWorkspace).get(spawns.getFirst().taskId());
            assertNotNull(record, record.toString());
            assertEquals(context.getSessionId(), record.path("parentSessionId").asText());
            assertNotEquals(spawns.getFirst().sessionId(), record.path("parentSessionId").asText());
            assertEquals("", record.path("subSessionId").asText(), record.toString());

            parent.call("DELIVERY_FOLLOW_UP same parent session", context).block();
            assertTrue(requests.getLast().path("messages").toString()
                            .contains("DELIVERED_FACTORY_CHILD_RESULT"),
                    "the owning parent session must receive the child result: " + requests.getLast());
            assertNotNull(taskRecords(parentWorkspace).get(spawns.getFirst().taskId())
                    .path("deliveredAt").asText(null), "delivery must be marked persisted");

            RuntimeContext foreign = parentContext("delivery-foreign");
            parent.call("DELIVERY_FOREIGN other parent session", foreign).block();
            assertFalse(requests.getLast().path("messages").toString()
                            .contains("DELIVERED_FACTORY_CHILD_RESULT"),
                    "delivery must not leak into another parent session: " + requests.getLast());
        } finally {
            parent.close();
            model.stop(0);
        }
    }

    @Test void factoryChildCannotNestOrSeeMutatingTools() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        AtomicInteger childCalls = new AtomicInteger();
        HttpServer model = modelServer(requests, body -> {
            if (isChild(body)) {
                if (childCalls.incrementAndGet() == 1) {
                    return ModelReply.calls(
                            new ToolCall("agent_spawn",
                                    "{\"agent_id\":\"helper\",\"task\":\"NESTED_CHILD_PROBE\"}"),
                            new ToolCall("probe_write", "{}"));
                }
                return ModelReply.text("READONLY_CHILD_DONE");
            }
            return body.path("messages").toString().contains("task_id:")
                    ? ModelReply.text("PARENT_DONE") : ModelReply.spawn(CHILD_READONLY);
        });
        Path parentWorkspace = temp.resolve("parent-workspace");
        Path childWorkspace = temp.resolve("child-workspace");
        Model client = fixtureModel(model);
        HarnessAgent parent = parentAgent(client, parentWorkspace,
                ignored -> normalChild(client, childWorkspace));
        try {
            RuntimeContext context = parentContext("readonly-parent");
            parent.call("Delegate a read-only probe.", context).block();
            List<Spawn> spawns = awaitSpawns(requests, 1);
            assertEquals(1, spawns.size(), requests.toString());
            BackgroundTask task = awaitTasks(parent, context, 1).iterator().next();
            assertTrue(task.waitForCompletion(20_000), "child did not finish");
            assertEquals(TaskStatus.COMPLETED, task.getTaskStatus(), task.getStatus());

            JsonNode childRequest = requests.stream().filter(AgentScopeSubagentFactoryProbeTest::isChild)
                    .findFirst().orElseThrow();
            List<String> childTools = new ArrayList<>();
            for (JsonNode tool : childRequest.path("tools")) {
                childTools.add(tool.path("function").path("name").asText());
            }
            assertTrue(childTools.contains("probe_read"), childTools.toString());
            assertFalse(childTools.contains("probe_write"),
                    "the custom factory child must not inherit mutating tools: " + childTools);
            assertFalse(childTools.contains("agent_spawn"),
                    "the custom factory child must not be able to nest delegation: " + childTools);
            assertFalse(childTools.contains("task_cancel"),
                    "the custom factory child must not control background tasks: " + childTools);
            assertEquals(1, taskRecords(parentWorkspace).size(),
                    "a factory child must not create a grandchild task: " + taskRecords(parentWorkspace));
        } finally {
            parent.close();
            model.stop(0);
        }
    }

    @Test void customFactoryDoesNotRemoveBuiltInGeneralPurposeAgent() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        HttpServer model = modelServer(requests, body -> {
            if (childTask(body).equals(CHILD_BUILTIN) && isAnyChild(body)) {
                return ModelReply.text("BUILTIN_GENERAL_DONE");
            }
            return body.path("messages").toString().contains("task_id:")
                    ? ModelReply.text("PARENT_DONE")
                    : ModelReply.spawn("general-purpose", CHILD_BUILTIN);
        });
        Path parentWorkspace = temp.resolve("parent-workspace");
        Path childWorkspace = temp.resolve("child-workspace");
        Model client = fixtureModel(model);
        HarnessAgent parent = parentAgent(client, parentWorkspace,
                ignored -> normalChild(client, childWorkspace));
        try {
            RuntimeContext context = parentContext("builtin-general-parent");
            parent.call("Delegate to the built-in general-purpose agent.", context).block();
            List<Spawn> spawns = awaitSpawns(requests, 1);
            assertEquals(1, spawns.size(), requests.toString());
            BackgroundTask task = awaitTasks(parent, context, 1).iterator().next();
            assertTrue(task.waitForCompletion(20_000), "built-in helper did not finish");
            assertEquals(TaskStatus.COMPLETED, task.getTaskStatus(), task.getStatus());

            JsonNode builtInRequest = requests.stream()
                    .filter(AgentScopeSubagentFactoryProbeTest::isAnyChild)
                    .findFirst().orElseThrow();
            List<String> tools = new ArrayList<>();
            for (JsonNode tool : builtInRequest.path("tools")) {
                tools.add(tool.path("function").path("name").asText());
            }
            assertTrue(tools.contains("probe_write"),
                    "the built-in general-purpose helper still inherits the parent's mutating "
                            + "toolkit, so a custom factory alone does not make every helper read-only: "
                            + tools);
        } finally {
            parent.close();
            model.stop(0);
        }
    }

    // ============================ parent/child construction ============================

    private HarnessAgent parentAgent(Model model, Path parentWorkspace,
            java.util.function.Function<String, Agent> factory) {
        Toolkit toolkit = new Toolkit();
        toolkit.registerAgentTool(new ProbeTool("probe_read", "Read probe", true));
        toolkit.registerAgentTool(new ProbeTool("probe_write", "Write probe", false));
        PermissionContextState.Builder permissions = PermissionContextState.builder()
                .mode(PermissionMode.DEFAULT);
        for (String name : List.of("probe_read", "probe_write", "agent_spawn", "agent_send",
                "agent_list", "task_output", "task_cancel", "task_list")) {
            permissions.addAllowRule(name,
                    new PermissionRule(name, null, PermissionBehavior.ALLOW, "factory-probe"));
        }
        return HarnessAgent.builder()
                .name("factory-parent")
                .agentId("factory-parent")
                .sysPrompt("You are the parent. " + PARENT_MARK)
                .model(model)
                .toolkit(toolkit)
                .permissionContext(permissions.build())
                .workspace(parentWorkspace)
                .stateStore(new InMemoryAgentStateStore())
                .taskRepository(new InterruptibleTaskRepository(
                        new WorkspaceManager(parentWorkspace), "factory-parent",
                        true, 10, new AtomicInteger()))
                .maxIters(6)
                .compaction(safeCompaction())
                .subagentFactory("helper", "Read-only background helper", factory)
                .disableFilesystemTools()
                .disableShellTool()
                .disableMemoryTools()
                .disableMemoryHooks()
                .disableToolResultEviction()
                .disableDefaultWorkspaceSkills()
                .disableDynamicSubagents()
                .build();
    }

    private HarnessAgent normalChild(Model model, Path childWorkspace) {
        return normalChild(model, childWorkspace, null);
    }

    private HarnessAgent normalChild(Model model, Path childWorkspace, ContextProbe probe) {
        Toolkit toolkit = new Toolkit();
        toolkit.registerAgentTool(new ProbeTool("probe_read", "Read probe", true));
        return childAgent(model, childWorkspace, toolkit, true, probe);
    }

    private HarnessAgent childAgent(Model model, Path childWorkspace, Toolkit toolkit, boolean allowRead) {
        return childAgent(model, childWorkspace, toolkit, allowRead, null);
    }

    private HarnessAgent childAgent(Model model, Path childWorkspace, Toolkit toolkit, boolean allowRead,
            ContextProbe probe) {
        PermissionContextState.Builder permissions = PermissionContextState.builder()
                .mode(PermissionMode.DEFAULT);
        if (allowRead) {
            permissions.addAllowRule("probe_read",
                    new PermissionRule("probe_read", null, PermissionBehavior.ALLOW, "factory-child"));
        }
        HarnessAgent.Builder builder = HarnessAgent.builder()
                .name("helper")
                .agentId("helper")
                .sysPrompt("You are a read-only background helper. " + CHILD_MARK)
                .model(model)
                .toolkit(toolkit)
                .permissionContext(permissions.build())
                .workspace(childWorkspace)
                .stateStore(new InMemoryAgentStateStore())
                .maxIters(12)
                .compaction(safeCompaction())
                .disableFilesystemTools()
                .disableShellTool()
                .disableMemoryTools()
                .disableMemoryHooks()
                .disableToolResultEviction()
                .disableDefaultWorkspaceSkills()
                .disableDynamicSubagents()
                .disableSubagents()
                .disableSessionPersistence()
                .disableTranscript();
        if (probe != null) builder.middleware(probe);
        return builder.build();
    }

    private static CompactionConfig safeCompaction() {
        return CompactionConfig.builder()
                .flushBeforeCompact(false)
                .offloadBeforeCompact(false)
                .build();
    }

    private static RuntimeContext parentContext(String session) {
        return RuntimeContext.builder().userId("user-1").sessionId(session).build();
    }

    private static Model fixtureModel(HttpServer server) {
        return ModelFactory.create(new RunRequest.RunModel("local", "fixture", "test-key",
                "http://127.0.0.1:" + server.getAddress().getPort() + "/v1",
                false, 200, 200_000, null, null));
    }

    // ============================ fixtures ============================

    private record ToolCall(String name, String arguments) {}

    private record ModelReply(List<ToolCall> calls, String text, int status, String error) {
        static ModelReply spawn(String task) {
            return spawn("helper", task);
        }
        static ModelReply spawn(String agentId, String task) {
            return tool("agent_spawn", "{\"agent_id\":\"" + agentId + "\",\"task\":\"" + task
                    + "\",\"timeout_seconds\":0}");
        }
        static ModelReply tool(String name, String arguments) {
            return tools(name, arguments, 1);
        }
        static ModelReply calls(ToolCall... calls) {
            return new ModelReply(List.of(calls), null, 200, null);
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
            String internal = classify(body);
            ModelReply reply = "SUMMARY".equals(internal) ? ModelReply.text("FACTORY_COMPACTED_SUMMARY")
                    : "FLUSH".equals(internal) ? ModelReply.text("- FACTORY_FLUSH_MUST_NOT_APPEAR")
                    : behavior.reply(body);
            if (reply.status() != 200) {
                byte[] error = ("{\"error\":\"" + reply.error() + "\"}").getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("content-type", "application/json");
                exchange.sendResponseHeaders(reply.status(), error.length);
                try (var output = exchange.getResponseBody()) { output.write(error); }
            } else if (!reply.calls().isEmpty()) {
                streamTools(exchange, reply.calls(), "factory-call-" + callSequence.incrementAndGet());
            } else {
                streamText(exchange, reply.text());
            }
        });
        server.start();
        return server;
    }

    private static String classify(JsonNode body) {
        String all = body.path("messages").toString();
        if (all.contains(SUMMARY_PROMPT)) return "SUMMARY";
        if (all.contains(FLUSH_PROMPT)) return "FLUSH";
        return "NORMAL";
    }

    private static boolean isChild(JsonNode body) {
        JsonNode messages = body.path("messages");
        return !messages.isEmpty()
                && messages.get(0).path("content").toString().contains(CHILD_MARK);
    }

    /** Built-in general-purpose helpers do not carry the custom factory's system marker. */
    private static boolean isAnyChild(JsonNode body) {
        JsonNode messages = body.path("messages");
        return !messages.isEmpty()
                && messages.get(0).path("content").toString().contains("spawned by the main agent");
    }

    private static String childTask(JsonNode body) {
        for (JsonNode message : body.path("messages")) {
            if (!"user".equals(message.path("role").asText())) continue;
            String content = message.path("content").toString();
            for (String task : List.of(CHILD_A, CHILD_B, CHILD_LONG, CHILD_DELIVER, CHILD_CANCEL,
                    CHILD_READONLY, CHILD_BUILTIN, CHILD_FAIL)) {
                if (content.contains(task)) return task;
            }
        }
        return "unknown";
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

    private static final class TypedFailureError extends Error {
        TypedFailureError(String message) { super(message); }
    }

    /** Converts a child model failure into a typed Error so AgentSpawnTool's RuntimeException
     * catch cannot flatten it into a completed string; the native task future then fails. */
    private static final class TypedFailureModel implements Model {
        private final Model delegate;

        TypedFailureModel(Model delegate) { this.delegate = delegate; }

        @Override public Flux<ChatResponse> stream(List<Msg> messages, List<ToolSchema> tools,
                GenerateOptions options) {
            return Flux.error(new TypedFailureError("typed factory child model failure"));
        }

        @Override public String getModelName() { return delegate.getModelName(); }
        @Override public int getContextWindowSize() { return delegate.getContextWindowSize(); }
    }

    private static final class ContextProbe implements MiddlewareBase {
        final AtomicInteger maxMessages = new AtomicInteger();
        final AtomicInteger maxTokens = new AtomicInteger();

        @Override public Flux<AgentEvent> onReasoning(Agent agent, RuntimeContext context,
                ReasoningInput input, Function<ReasoningInput, Flux<AgentEvent>> next) {
            try {
                var contextMessages = ((ReActAgent) agent).getAgentState(context).getContext();
                maxMessages.accumulateAndGet(contextMessages.size(), Math::max);
                maxTokens.accumulateAndGet(TokenCounterUtil.calculateToken(contextMessages), Math::max);
            } catch (RuntimeException ignored) {
                // The assertion reports the observed maximum; a missing state means none.
            }
            return next.apply(input);
        }
    }

    private static final class ProbeTool implements AgentTool {
        private final String name;
        private final String description;
        private final boolean readOnly;
        private final AtomicInteger calls = new AtomicInteger();

        ProbeTool(String name, String description, boolean readOnly) {
            this.name = name;
            this.description = description;
            this.readOnly = readOnly;
        }

        @Override public String getName() { return name; }
        @Override public String getDescription() { return description; }
        @Override public Map<String, Object> getParameters() {
            return Map.of("type", "object", "properties",
                    Map.of("i", Map.of("type", "integer")));
        }
        @Override public boolean isReadOnly() { return readOnly; }
        @Override public Mono<ToolResultBlock> callAsync(ToolCallParam param) {
            calls.incrementAndGet();
            return Mono.just(ToolResultBlock.text("probe-read " + "x".repeat(1800)));
        }
        int calls() { return calls.get(); }
    }

    private record Spawn(String taskId, String agentId, String sessionId) {}

    private static List<Spawn> awaitSpawns(List<JsonNode> requests, int count) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline) {
            List<Spawn> spawns = spawns(requests);
            if (spawns.size() >= count) return spawns;
            Thread.sleep(50);
        }
        return spawns(requests);
    }

    private static List<Spawn> spawns(List<JsonNode> requests) {
        Map<String, Spawn> found = new LinkedHashMap<>();
        for (JsonNode request : requests) {
            for (JsonNode message : request.path("messages")) {
                String content = message.toString();
                Matcher task = TASK_ID.matcher(content);
                Matcher session = SESSION_ID.matcher(content);
                if (task.find() && session.find()) {
                    String taskId = task.group(1);
                    found.putIfAbsent(taskId, new Spawn(taskId, "helper", session.group(1)));
                }
            }
        }
        return new ArrayList<>(found.values());
    }

    private static Collection<BackgroundTask> awaitTasks(HarnessAgent parent, RuntimeContext context,
            int count) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            Collection<BackgroundTask> tasks = parent.getTaskRepository()
                    .listTasks(context, context.getSessionId(), null);
            if (tasks.size() >= count) return tasks;
            Thread.sleep(50);
        }
        return parent.getTaskRepository().listTasks(context, context.getSessionId(), null);
    }

    private static Map<String, JsonNode> taskRecords(Path workspace) throws Exception {
        Map<String, JsonNode> records = new HashMap<>();
        if (!Files.exists(workspace)) return records;
        try (var walk = Files.walk(workspace)) {
            for (Path path : walk.filter(Files::isRegularFile)
                    .filter(path -> path.toString().contains("/tasks/") && path.toString().endsWith(".json"))
                    .toList()) {
                JsonNode stored = JSON.readTree(Files.readString(path));
                stored.fieldNames().forEachRemaining(taskId -> records.put(taskId, stored.path(taskId)));
            }
        }
        return records;
    }

    private static List<Path> filesMatching(Path root, java.util.function.Predicate<Path> match) {
        List<Path> files = new ArrayList<>();
        if (!Files.exists(root)) return files;
        try (var walk = Files.walk(root)) {
            walk.filter(Files::isRegularFile).filter(match).forEach(files::add);
        } catch (Exception ignored) {
            // The assertion reports what was found.
        }
        return files;
    }

    private static void awaitQuietly(CountDownLatch latch, int seconds) {
        try { latch.await(seconds, TimeUnit.SECONDS); } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }
}
