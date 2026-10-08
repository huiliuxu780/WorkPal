package com.workpal.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.event.AgentEvent;
import io.agentscope.core.event.AgentResultEvent;
import io.agentscope.core.event.ConfirmResult;
import io.agentscope.core.event.ModelCallEndEvent;
import io.agentscope.core.event.RequireExternalExecutionEvent;
import io.agentscope.core.event.RequireUserConfirmEvent;
import io.agentscope.core.event.TextBlockDeltaEvent;
import io.agentscope.core.event.ThinkingBlockDeltaEvent;
import io.agentscope.core.event.ToolCallDeltaEvent;
import io.agentscope.core.event.ToolCallEndEvent;
import io.agentscope.core.event.ToolCallStartEvent;
import io.agentscope.core.event.ToolResultEndEvent;
import io.agentscope.core.event.ToolResultTextDeltaEvent;
import io.agentscope.core.message.Base64Source;
import io.agentscope.core.message.ContentBlock;
import io.agentscope.core.message.DataBlock;
import io.agentscope.core.message.ImageBlock;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.MsgRole;
import io.agentscope.core.message.TextBlock;
import io.agentscope.core.message.ToolCallState;
import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.message.ToolResultState;
import io.agentscope.core.message.ToolUseBlock;
import io.agentscope.core.message.UserMessage;
import io.agentscope.core.model.ToolSchema;
import io.agentscope.core.permission.PermissionBehavior;
import io.agentscope.core.permission.PermissionContextState;
import io.agentscope.core.permission.PermissionMode;
import io.agentscope.core.permission.PermissionRule;
import io.agentscope.core.state.AgentState;
import io.agentscope.core.state.JsonFileAgentStateStore;
import io.agentscope.core.tool.Toolkit;
import io.agentscope.harness.agent.HarnessAgent;
import io.agentscope.harness.agent.memory.compaction.CompactionConfig;
import io.agentscope.harness.agent.subagent.SubagentDeclaration;
import io.agentscope.harness.agent.subagent.task.BackgroundTask;
import io.agentscope.harness.agent.subagent.task.TaskDelivery;
import io.agentscope.harness.agent.subagent.task.TaskRepository;
import io.agentscope.harness.agent.subagent.task.TaskStatus;
import io.agentscope.harness.agent.subagent.task.WorkspaceTaskRepository;
import io.agentscope.harness.agent.workspace.WorkspaceManager;
import io.agentscope.harness.agent.tool.AgentSpawnTool;
import io.agentscope.harness.agent.tools.ToolsConfig;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import reactor.core.Disposable;
import reactor.core.Disposables;

/** WorkPal protocol adapter around AgentScope's own reasoning and tool lifecycle. */
public final class RuntimeEngine {
    @FunctionalInterface public interface EventSink { void emit(Map<String, Object> event) throws IOException; }

    private final ObjectMapper json;
    private final Path stateRoot;
    private final Path workspaceRoot;
    private final ConcurrentHashMap<String, RunningAgent> running = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, BackgroundHandle> background = new ConcurrentHashMap<>();

    private record RunningAgent(HarnessAgent agent, RuntimeContext context, Disposable.Swap stream) {}
    private record BackgroundHandle(RunRequest request, HarnessAgent agent, RuntimeContext context,
            ToolBridgeClient bridge, String taskId, String childSession) {}

    public RuntimeEngine(ObjectMapper json, Path stateRoot, Path workspaceRoot) {
        this.json = json;
        this.stateRoot = stateRoot;
        this.workspaceRoot = workspaceRoot;
    }

    public void cancel(String runId) {
        RunningAgent active = running.get(runId);
        if (active != null) {
            active.stream().dispose();
            active.agent().interrupt(active.context());
        }
    }

    public boolean cancelTask(RunRequest.Identity identity, String taskId) {
        BackgroundHandle handle = background.get(taskId);
        if (handle == null || identity == null) return false;
        RunRequest.Identity owner = handle.request().identity();
        if (!owner.userId().equals(identity.userId()) || !owner.spaceId().equals(identity.spaceId())
                || !owner.botId().equals(identity.botId()) || !owner.threadId().equals(identity.threadId())) {
            return false;
        }
        return handle.agent().getTaskRepository().cancelTask(handle.context(),
                handle.context().getSessionId(), taskId);
    }

    public void execute(RunRequest request, EventSink sink) throws Exception {
        request.validate();
        String tenant = hash(request.identity().userId() + "\u0000" + request.identity().spaceId());
        String session = hash(request.botId() + "\u0000" + request.threadId() + "\u0000" + request.generation()
                + (request.isChat() ? "" : "\u0000" + request.scope() + "\u0000" + request.runId()));
        Path workspace = workspaceRoot.resolve(tenant).resolve(hash(request.botId())).resolve(session);
        Files.createDirectories(workspace);
        JsonFileAgentStateStore store = new JsonFileAgentStateStore(stateRoot.resolve(hash(request.botId())));
        String userSlot = tenant;
        String sessionSlot = session;
        AgentState loaded = store.get(userSlot, sessionSlot, "agent_state", AgentState.class).orElse(null);
        boolean fresh = loaded == null;
        List<ToolUseBlock> pendingFromPreviousAttempt = pendingToolCalls(loaded);
        RuntimeContext context = RuntimeContext.builder().userId(userSlot).sessionId(sessionSlot).build();
        ToolBridgeClient bridge = new ToolBridgeClient(json, request);
        Set<String> pausedToolCalls = ConcurrentHashMap.newKeySet();
        Toolkit toolkit = new Toolkit();
        var permissions = PermissionContextState.builder().mode(PermissionMode.DEFAULT);
        List<String> backendToolNames = new ArrayList<>();
        List<String> childToolNames = new ArrayList<>();
        boolean allowSubagents = request.tools() != null
                && request.tools().stream().anyMatch(tool -> "run_subagent".equals(tool.name()));
        if (request.tools() != null) {
            for (RunRequest.ToolDefinition tool : request.tools()) {
                if ("run_subagent".equals(tool.name())) continue;
                toolkit.registerAgentTool(new BackendSchemaTool(tool, bridge, json, sessionSlot, pausedToolCalls));
                backendToolNames.add(tool.name());
                if (Boolean.TRUE.equals(tool.readOnly())) childToolNames.add(tool.name());
                permissions.addAllowRule(tool.name(), new PermissionRule(
                        tool.name(), null, PermissionBehavior.ALLOW, "workpal-run-allowlist"));
            }
        }
        List<String> harnessTools = new ArrayList<>(List.of("plan_enter", "plan_write",
                "load_skill_through_path"));
        if (allowSubagents) harnessTools.addAll(List.of("agent_spawn", "agent_send", "agent_list",
                "task_output", "task_cancel", "task_list"));
        for (String name : harnessTools) permissions.addAllowRule(name,
                new PermissionRule(name, null, PermissionBehavior.ALLOW, "workpal-harness"));
        permissions.addAskRule("plan_exit", new PermissionRule(
                "plan_exit", null, PermissionBehavior.ASK, "workpal-plan-approval"));
        ToolsConfig toolFilter = new ToolsConfig();
        List<String> visibleTools = new ArrayList<>(backendToolNames);
        visibleTools.addAll(harnessTools);
        visibleTools.add("plan_exit");
        toolFilter.setAllow(visibleTools);
        toolFilter.setDeny(List.of("web_fetch", "web_search", "memory_save", "memory_search",
                "memory_get", "session_search", "session_list", "session_history",
                "task", "wait_async_results").stream()
                .filter(name -> !backendToolNames.contains(name)).toList());
        var builder = HarnessAgent.builder()
                .name("assistant")
                .agentId(hash(request.botId()))
                .sysPrompt(PromptComposer.compose(request))
                .model(ModelFactory.create(request.model()))
                .toolkit(toolkit)
                .permissionContext(permissions.build())
                .workspace(workspace)
                .stateStore(store)
                .maxIters(20)
                .compaction(CompactionConfig.builder().triggerMessages(30).keepMessages(10).build())
                .toolsConfig(toolFilter)
                .disableFilesystemTools()
                .disableShellTool()
                .disableMemoryTools()
                .disableMemoryHooks()
                .disableDefaultWorkspaceSkills()
                .enablePlanMode();
        if (allowSubagents) {
            builder.taskRepository(new InterruptibleTaskRepository(
                    new WorkspaceManager(workspace), hash(request.botId())));
            builder.subagent(SubagentDeclaration.builder()
                    .name("helper")
                    .description("Complete a focused delegated task using the parent's authorized capabilities.")
                    .inlineAgentsBody("You are a helper inside the parent WorkPal run. Return a concise result.")
                    .tools(childToolNames)
                    .build());
        } else {
            builder.disableSubagents();
        }
        if (request.skills() != null && !request.skills().isEmpty()) {
            builder.skillRepository(new RequestSkillRepository(request.skills()));
        }
        HarnessAgent agent = builder.build();
        TaskRepository deliveryRepository = agent.getTaskRepository();
        boolean temporaryDeliveryRepository = deliveryRepository == null;
        if (temporaryDeliveryRepository) {
            deliveryRepository = new WorkspaceTaskRepository(agent.getWorkspaceManager(), hash(request.botId()));
        }
        // A fresh HarnessAgent is built for each WorkPal Run. Its middleware renders the
        // persisted task summary, but 2.0.3 does not inject the terminal delivery into this
        // freshly restored agent's first model call. Read the same native repository here.
        List<TaskDelivery> pendingDeliveries = deliveryRepository.findPendingDeliveries(context, sessionSlot);
        // Harness registers its own Web tools after the caller's toolkit. Restore backend-owned
        // tools with colliding names so model calls still cross WorkPal authorization and audit.
        if (request.tools() != null) for (RunRequest.ToolDefinition tool : request.tools()) {
            if (!"run_subagent".equals(tool.name())) {
                agent.getDelegate().getToolkit().registerAgentTool(
                        new BackendSchemaTool(tool, bridge, json, sessionSlot, pausedToolCalls));
            }
        }
        // AgentScope restores the previous session's permission context from durable state.
        // The backend's per-run allow-list must replace it before every call, including resume.
        agent.getDelegate().replacePermissionContext(userSlot, sessionSlot, permissions.build());
        RunningAgent active = new RunningAgent(agent, context, Disposables.swap());
        running.put(request.runId(), active);
        try {
        Set<String> seenSteering = new HashSet<>();
        String prompt = request.prompt();
        List<RunRequest.InputImage> currentImages = new ArrayList<>(request.currentTurnImages() == null
                ? List.of() : request.currentTurnImages());
        if (request.isChat() && pendingFromPreviousAttempt.isEmpty()) {
            JsonNode steering = bridge.claimSteering(seenSteering);
            if (steering != null && steering.path("messages").isArray()) {
                for (JsonNode item : steering.path("messages")) {
                    if (item.hasNonNull("id")) seenSteering.add(item.path("id").asText());
                    if (item.hasNonNull("text")) prompt += "\n\nAdditional user context:\n" + item.path("text").asText();
                    if (item.path("images").isArray()) for (JsonNode image : item.path("images")) {
                        currentImages.add(new RunRequest.InputImage(image.path("name").asText(),
                                image.path("mimeType").asText(), image.path("data").asText()));
                    }
                }
            }
        }
        List<Msg> input;
        if (!pendingFromPreviousAttempt.isEmpty()) {
            if (pendingFromPreviousAttempt.stream().anyMatch(call -> call.getState() == ToolCallState.ASKING)) {
                input = resumeConfirmation(pendingFromPreviousAttempt, request, sink);
            } else {
                input = resumeTools(pendingFromPreviousAttempt, request, bridge, sink, seenSteering, true);
            }
            if (input == null) return;
        } else {
            input = new ArrayList<>();
            if (fresh && request.history() != null) {
                for (RunRequest.HistoryMessage item : request.history()) {
                    if (item.id() != null && item.id().equals(request.sourceMessageId())) continue;
                    if ("user".equals(item.role())) input.add(userMessage(item.content(), item.images()));
                    if ("assistant".equals(item.role())) input.add(Msg.builder().role(MsgRole.ASSISTANT)
                            .textContent(item.content() == null ? "" : item.content()).build());
                }
            }
            input.add(userMessage(prompt, currentImages));
        }

        StringBuilder finalText = new StringBuilder();
        for (int resume = 0; resume < 40; resume++) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedException("Run cancelled");
            EventMapper mapper = new EventMapper(request, sink, finalText, agent, context, bridge);
            CountDownLatch streamFinished = new CountDownLatch(1);
            AtomicReference<Throwable> streamError = new AtomicReference<>();
            List<Msg> modelInput = input;
            if (resume == 0 && !pendingDeliveries.isEmpty()) {
                modelInput = new ArrayList<>(input);
                modelInput.add(taskReminder(pendingDeliveries));
            }
            Disposable subscription = agent.streamEvents(modelInput, context).subscribe(mapper::accept,
                    error -> { streamError.set(error); streamFinished.countDown(); },
                    streamFinished::countDown);
            active.stream().replace(subscription);
            try {
                streamFinished.await();
            } finally {
                subscription.dispose();
            }
            if (streamError.get() instanceof Exception error) throw error;
            if (streamError.get() != null) throw new RuntimeException(streamError.get());
            if (!pausedToolCalls.isEmpty()) {
                String name = mapper.toolNames.getOrDefault(pausedToolCalls.iterator().next(), "Tool");
                sink.emit(Map.of("type", "progress", "text", name + " waiting for approval", "activity", true));
                sink.emit(Map.of("type", "paused", "reason", "approval-or-secret"));
                return;
            }
            if (mapper.confirm != null) {
                String names = mapper.confirm.getToolCalls().stream().map(ToolUseBlock::getName)
                        .distinct().reduce((left, right) -> left + ", " + right).orElse("tool");
                sink.emit(Map.of("type", "ask", "text", "Allow " + names + " to continue?",
                        "actions", List.of(Map.of("id", "approve", "label", "Approve"),
                                Map.of("id", "reject", "label", "Reject"))));
                sink.emit(Map.of("type", "paused", "reason", "approval"));
                return;
            }
            if (mapper.external == null) {
                if (!mapper.completed) throw new IllegalStateException("AgentScope run ended without completing");
                for (TaskDelivery delivery : pendingDeliveries) {
                    deliveryRepository.markDelivered(context, sessionSlot, delivery.taskId());
                }
                sink.emit(Map.of("type", "done", "text", finalText.toString()));
                return;
            }
            input = resumeTools(mapper.external.getToolCalls(), request, bridge, sink, seenSteering, false);
            if (input == null) return;
        }
        throw new IllegalStateException("AgentScope exceeded the external tool resume limit");
        } finally {
            bridge.closeForeground();
            running.remove(request.runId(), active);
            if (temporaryDeliveryRepository) deliveryRepository.shutdown();
        }
    }

    private static Msg taskReminder(List<TaskDelivery> deliveries) {
        StringBuilder body = new StringBuilder("<system-reminder>\nBackground subagent results:\n");
        for (TaskDelivery delivery : deliveries.stream().limit(20).toList()) {
            body.append("<task id=\"").append(delivery.taskId()).append("\" state=\"")
                    .append(delivery.status().name().toLowerCase(java.util.Locale.ROOT)).append("\">\n");
            if (delivery.status() == TaskStatus.COMPLETED && delivery.result() != null) {
                body.append(delivery.result());
            } else if (delivery.status() == TaskStatus.FAILED && delivery.errorMessage() != null) {
                body.append(delivery.errorMessage());
            } else if (delivery.status() == TaskStatus.CANCELLED) {
                body.append("Task was cancelled.");
            }
            body.append("\n</task>\n");
        }
        body.append("</system-reminder>");
        return Msg.builder().role(MsgRole.USER).name("system")
                .textContent(body.toString()).build();
    }

    private static List<Msg> resumeConfirmation(List<ToolUseBlock> pending, RunRequest request,
            EventSink sink) throws IOException {
        String answer = (RunRequest.blank(request.resumeAnswer()) ? request.prompt() : request.resumeAnswer())
                .trim().toLowerCase(java.util.Locale.ROOT);
        boolean approve = Set.of("approve", "approved", "yes", "allow").contains(answer);
        boolean reject = Set.of("reject", "rejected", "no", "deny").contains(answer);
        if (!approve && !reject) {
            sink.emit(Map.of("type", "ask", "text", "Approve the pending AgentScope action?",
                    "actions", List.of(Map.of("id", "approve", "label", "Approve"),
                            Map.of("id", "reject", "label", "Reject"))));
            sink.emit(Map.of("type", "paused", "reason", "approval"));
            return null;
        }
        List<ConfirmResult> decisions = pending.stream()
                .filter(call -> call.getState() == ToolCallState.ASKING)
                .map(call -> new ConfirmResult(approve, call)).toList();
        return List.of(Msg.builder().role(MsgRole.USER).textContent(request.prompt())
                .metadata(Map.of(Msg.METADATA_CONFIRM_RESULTS, decisions)).build());
    }

    private List<Msg> resumeTools(List<ToolUseBlock> calls, RunRequest request, ToolBridgeClient bridge,
            EventSink sink, Set<String> seenSteering, boolean fromPreviousAttempt) throws Exception {
        List<ContentBlock> results = new ArrayList<>();
        for (ToolUseBlock call : calls) {
            String name = call.getName();
            Map<String, Object> args = call.getInput();
            if ("ask_user".equals(name)) {
                String answer = RunRequest.blank(request.resumeAnswer()) ? request.prompt() : request.resumeAnswer();
                if (fromPreviousAttempt && !RunRequest.blank(answer)) {
                    results.add(ToolResultBlock.builder().id(call.getId()).name(name)
                            .output(TextBlock.builder().text("User response: " + answer).build())
                            .state(ToolResultState.SUCCESS).build());
                    continue;
                }
                emitAsk(args, sink);
                sink.emit(Map.of("type", "paused", "reason", "ask"));
                return null;
            }
            if ("request_takeover".equals(name)) {
                sink.emit(Map.of("type", "takeover", "reason", String.valueOf(args.getOrDefault("reason", "I need you on the screen."))));
                sink.emit(Map.of("type", "paused", "reason", "takeover"));
                return null;
            }
            ToolResultBlock result;
            if ("runtime_current_time".equals(name)) {
                result = clockResult(call);
            } else {
                ToolBridgeClient.ToolOutcome outcome = bridge.execute(name, call.getId(), args);
                if (outcome.paused()) {
                    sink.emit(Map.of("type", "progress", "text", name + " waiting for approval", "activity", true));
                    sink.emit(Map.of("type", "paused", "reason", "approval-or-secret"));
                    return null;
                }
                result = resultBlock(json, call, outcome);
            }
            results.add(result);
        }
        if (request.isChat()) {
            JsonNode steering = bridge.claimSteering(seenSteering);
            if (steering != null && steering.path("messages").isArray()) {
                for (JsonNode item : steering.path("messages")) {
                    if (item.hasNonNull("id")) seenSteering.add(item.path("id").asText());
                    if (item.hasNonNull("text")) results.add(TextBlock.builder()
                            .text("Additional user instructions: " + item.path("text").asText()).build());
                }
            }
        }
        return List.of(Msg.builder().role(MsgRole.TOOL).content(results).build());
    }

    private static List<ToolUseBlock> pendingToolCalls(AgentState state) {
        if (state == null) return List.of();
        Set<String> results = new HashSet<>();
        List<Msg> context = state.getContext();
        for (int index = context.size() - 1; index >= 0; index--) {
            Msg message = context.get(index);
            for (ToolResultBlock result : message.getContentBlocks(ToolResultBlock.class)) results.add(result.getId());
            List<ToolUseBlock> uses = message.getContentBlocks(ToolUseBlock.class);
            if (!uses.isEmpty()) return uses.stream().filter(call -> !results.contains(call.getId())).toList();
        }
        return List.of();
    }

    private ToolResultBlock clockResult(ToolUseBlock call) throws IOException {
        String zone = String.valueOf(call.getInput().getOrDefault("timezone", "UTC"));
        try {
            Instant now = Instant.now();
            String result = json.writeValueAsString(Map.of("utc", now.toString(), "timezone", zone,
                    "local", now.atZone(ZoneId.of(zone)).toString()));
            return ToolResultBlock.builder().id(call.getId()).name(call.getName())
                    .output(TextBlock.builder().text(result).build()).state(ToolResultState.SUCCESS).build();
        } catch (Exception e) {
            return ToolResultBlock.builder().id(call.getId()).name(call.getName())
                    .output(TextBlock.builder().text("Unknown timezone").build()).state(ToolResultState.ERROR).build();
        }
    }

    static ToolResultBlock resultBlock(ObjectMapper json, ToolUseBlock call,
            ToolBridgeClient.ToolOutcome outcome) throws IOException {
        List<ContentBlock> output = new ArrayList<>();
        JsonNode value = outcome.result();
        if (outcome.error() != null) {
            output.add(TextBlock.builder().text("Tool failed: " + outcome.error()).build());
        } else if (value != null && "agent_tool_result".equals(value.path("kind").asText())
                && value.path("content").isArray()) {
            for (JsonNode item : value.path("content")) {
                if ("text".equals(item.path("type").asText())) {
                    output.add(TextBlock.builder().text(item.path("text").asText("")).build());
                } else if ("image".equals(item.path("type").asText())
                        && Set.of("image/png", "image/jpeg").contains(item.path("mimeType").asText())
                        && item.hasNonNull("data")) {
                    output.add(DataBlock.builder().source(Base64Source.builder()
                            .mediaType(item.path("mimeType").asText()).data(item.path("data").asText()).build()).build());
                }
            }
        } else {
            output.add(TextBlock.builder().text(json.writeValueAsString(value)).build());
        }
        if (output.isEmpty()) output.add(TextBlock.builder().text("Tool completed without a displayable result.").build());
        return ToolResultBlock.builder().id(call.getId()).name(call.getName())
                .output(output)
                .state(outcome.error() == null ? ToolResultState.SUCCESS : ToolResultState.ERROR).build();
    }

    private static UserMessage userMessage(String text, List<RunRequest.InputImage> images) {
        List<ContentBlock> blocks = new ArrayList<>();
        blocks.add(TextBlock.builder().text(text == null ? "" : text).build());
        if (images != null) for (RunRequest.InputImage image : images) {
            if (!Set.of("image/jpeg", "image/png", "image/webp", "image/gif").contains(image.mimeType())) {
                throw new IllegalArgumentException("Unsupported input image type");
            }
            blocks.add(ImageBlock.builder().source(Base64Source.builder()
                    .mediaType(image.mimeType()).data(image.data()).build()).build());
        }
        return new UserMessage(blocks);
    }

    private static void emitAsk(Map<String, Object> args, EventSink sink) throws IOException {
        Object rawOptions = args.get("options");
        if (!(rawOptions instanceof List<?> options) || options.size() < 2 || options.size() > 4) {
            throw new IllegalArgumentException("ask_user requires two to four options");
        }
        List<Map<String, String>> actions = new ArrayList<>();
        for (int index = 0; index < options.size(); index++) {
            actions.add(Map.of("id", "choice-" + (index + 1), "label", String.valueOf(options.get(index))));
        }
        sink.emit(Map.of("type", "ask", "text", String.valueOf(args.getOrDefault("question", "What should I use?")), "actions", actions));
    }

    private static String hash(String input) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(input.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return java.util.HexFormat.of().formatHex(digest);
        } catch (Exception e) { throw new IllegalStateException("SHA-256 unavailable", e); }
    }

    public void purgeBot(String userId, String spaceId, String botId) throws IOException {
        if (RunRequest.blank(userId) || RunRequest.blank(spaceId) || RunRequest.blank(botId)) {
            throw new IllegalArgumentException("A user, space and bot are required");
        }
        String tenant = hash(userId + "\u0000" + spaceId);
        String bot = hash(botId);
        deleteTree(stateRoot.resolve(bot).resolve(tenant));
        deleteTree(workspaceRoot.resolve(tenant).resolve(bot));
    }

    private static void deleteTree(Path root) throws IOException {
        if (!Files.exists(root)) return;
        try (var paths = Files.walk(root)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(path);
        }
    }

    private final class EventMapper {
        private final RunRequest request;
        private final EventSink sink;
        private final StringBuilder finalText;
        private final HarnessAgent agent;
        private final RuntimeContext context;
        private final ToolBridgeClient bridge;
        private final Map<String, String> toolNames = new HashMap<>();
        private final Map<String, StringBuilder> toolArgs = new HashMap<>();
        private final Map<String, StringBuilder> toolOutputs = new HashMap<>();
        private final Map<String, StringBuilder> childTexts = new HashMap<>();
        private final Set<String> children = new HashSet<>();
        private final Set<String> completedChildren = new HashSet<>();
        private RequireExternalExecutionEvent external;
        private RequireUserConfirmEvent confirm;
        private boolean completed;
        private boolean reasoningShown;

        EventMapper(RunRequest request, EventSink sink, StringBuilder finalText,
                HarnessAgent agent, RuntimeContext context, ToolBridgeClient bridge) {
            this.request = request;
            this.sink = sink;
            this.finalText = finalText;
            this.agent = agent;
            this.context = context;
            this.bridge = bridge;
        }

        void accept(AgentEvent event) {
            try {
                String source = event.getSource();
                boolean child = source != null && !source.isBlank();
                if (child && children.add(source)) sink.emit(Map.of("type", "subagent", "agentId", source,
                        "name", source, "task", "delegated task", "status", "running"));
                if (event instanceof TextBlockDeltaEvent delta) {
                    if (child) {
                        childTexts.computeIfAbsent(source, ignored -> new StringBuilder()).append(delta.getDelta());
                        sink.emit(Map.of("type", "subagent", "agentId", source, "name", source,
                                "task", "delegated task", "status", "running", "progress", delta.getDelta()));
                    }
                    else { finalText.append(delta.getDelta()); sink.emit(Map.of("type", "text", "text", delta.getDelta())); }
                } else if (event instanceof ThinkingBlockDeltaEvent delta) {
                    if (!child && !reasoningShown) {
                        reasoningShown = true;
                        sink.emit(Map.of("type", "progress", "text", "Thinking…", "activity", true));
                    }
                } else if (event instanceof ToolCallStartEvent start) {
                    toolNames.put(start.getToolCallId(), start.getToolCallName());
                    toolArgs.put(start.getToolCallId(), new StringBuilder());
                } else if (event instanceof ToolCallDeltaEvent delta) {
                    toolArgs.computeIfAbsent(delta.getToolCallId(), ignored -> new StringBuilder()).append(delta.getDelta());
                } else if (event instanceof ToolCallEndEvent end) {
                    String name = toolNames.getOrDefault(end.getToolCallId(), end.getToolCallName());
                    String raw = toolArgs.getOrDefault(end.getToolCallId(), new StringBuilder()).toString();
                    Map<String, Object> args = raw.isBlank() ? Map.of() : json.readValue(raw, Map.class);
                    if ("agent_send".equals(name) && Integer.valueOf(0).equals(args.get("timeout_seconds"))) {
                        throw new IOException("Background agent_send is not supported by the WorkPal bridge");
                    }
                    if ("agent_spawn".equals(name) && Integer.valueOf(0).equals(args.get("timeout_seconds"))) {
                        bridge.expectBackgroundSpawn();
                    }
                    if ("task_cancel".equals(name) && args.get("task_id") instanceof String taskId) {
                        cancelTask(request.identity(), taskId);
                    }
                    sink.emit(Map.of("type", "tool", "name", name, "args", args, "executionId", end.getToolCallId()));
                    if (name.startsWith("plan_")) sink.emit(Map.of("type", "progress", "text", name, "activity", true));
                } else if (event instanceof ToolResultTextDeltaEvent delta) {
                    toolOutputs.computeIfAbsent(delta.getToolCallId(), ignored -> new StringBuilder())
                            .append(delta.getDelta());
                } else if (event instanceof ToolResultEndEvent end) {
                    sink.emit(Map.of("type", "progress", "text", end.getToolCallName() + " " + end.getState(), "activity", true));
                    if (!child && "agent_spawn".equals(end.getToolCallName())) {
                        String output = toolOutputs.getOrDefault(end.getToolCallId(), new StringBuilder()).toString();
                        if (output.startsWith("\"")) output = json.readValue(output, String.class);
                        String taskId = field(output, "task_id");
                        if (taskId != null) {
                            String childSession = field(output, "session_id");
                            String agentId = field(output, "agent_id");
                            if (childSession == null || agentId == null) {
                                throw new IOException("Background subagent identity is missing");
                            }
                            registerBackground(request, agent, context, bridge, taskId, agentId, childSession);
                            bridge.finishBackgroundSpawn();
                        }
                        if (!output.contains("task_id:") && !output.contains("status: async")) {
                            String status = output.contains("status: ok") ? "completed" : "failed";
                            for (String spawned : children) if (completedChildren.add(spawned)) {
                                String result = output.contains("reply:\n")
                                        ? output.substring(output.indexOf("reply:\n") + 7).trim()
                                        : childTexts.getOrDefault(spawned, new StringBuilder()).toString();
                                sink.emit(Map.of("type", "subagent", "agentId", spawned, "name", spawned,
                                        "task", "delegated task", "status", status, "result", result));
                            }
                        }
                    }
                } else if (event instanceof ModelCallEndEvent end && end.getUsage() != null) {
                    sink.emit(Map.of("type", "usage", "inputTokens", end.getUsage().getInputTokens(),
                            "outputTokens", end.getUsage().getOutputTokens(), "cacheReadTokens", end.getUsage().getCachedTokens(),
                            "cacheWriteTokens", 0, "provider", request.model().provider() == null ? "openai-compatible" : request.model().provider(),
                            "model", request.model().id()));
                } else if (event instanceof RequireExternalExecutionEvent pending && !child) {
                    external = pending;
                } else if (event instanceof RequireUserConfirmEvent pending && !child) {
                    confirm = pending;
                } else if (event instanceof AgentResultEvent result) {
                    if (child && completedChildren.add(source)) sink.emit(Map.of("type", "subagent", "agentId", source, "name", source,
                            "task", "delegated task", "status", "completed", "result", result.getResult().getTextContent()));
                    else if (external == null && confirm == null) completed = true;
                }
            } catch (IOException | InterruptedException e) {
                throw new IllegalStateException("Cannot stream AgentScope event", e);
            }
        }
    }

    private static String field(String text, String key) {
        for (String line : text.split("\\R")) {
            if (line.startsWith(key + ": ")) return line.substring(key.length() + 2).trim();
        }
        return null;
    }

    private void registerBackground(RunRequest request, HarnessAgent agent, RuntimeContext context,
            ToolBridgeClient bridge, String taskId, String agentId, String childSession)
            throws IOException, InterruptedException {
        BackgroundTask task = agent.getTaskRepository().getTask(context, context.getSessionId(), taskId);
        if (task == null) throw new IOException("AgentScope background task is missing");
        try {
            bridge.registerTask(taskId, agentId, childSession);
        } catch (IOException | InterruptedException error) {
            agent.getTaskRepository().cancelTask(context, context.getSessionId(), taskId);
            throw error;
        }
        BackgroundHandle handle = new BackgroundHandle(request, agent, context, bridge, taskId, childSession);
        background.put(taskId, handle);
        Thread.ofVirtual().name("workpal-background-" + taskId).start(() -> {
            try {
                while (!task.waitForCompletion(1_000)) { /* native TaskRepository owns execution */ }
                TaskStatus status = task.getTaskStatus();
                String state = status == TaskStatus.CANCELLED ? "cancelled"
                        : status == TaskStatus.FAILED ? "failed" : "completed";
                String result = status == TaskStatus.COMPLETED ? task.getResult() :
                        task.getError() == null ? "" : task.getError().getClass().getSimpleName();
                for (int attempt = 0; attempt < 3; attempt++) {
                    try { bridge.publishTerminal(taskId, childSession, state, result); break; }
                    catch (IOException error) {
                        if (attempt == 2) System.err.println("Background task event delivery failed: " + taskId);
                        else Thread.sleep(1_000);
                    }
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            } finally {
                background.remove(taskId, handle);
            }
        });
    }
}
