package com.workpal.runtime;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.HashSet;

@JsonIgnoreProperties(ignoreUnknown = true)
public record RunRequest(
        String botId,
        String threadId,
        String runId,
        String executionScope,
        String sourceMessageId,
        Identity identity,
        String prompt,
        String productName,
        String instructions,
        List<HistoryMessage> history,
        List<InputImage> currentTurnImages,
        List<SkillDefinition> skills,
        List<ToolDefinition> tools,
        ToolBridge toolBridge,
        RunModel model,
        Boolean allowSilentEmpty,
        String emptyResponseText,
        Integer sessionGeneration,
        String resumeAnswer) {

    public RunRequest(String botId, String threadId, String runId, String executionScope,
            String sourceMessageId, Identity identity, String prompt, String productName,
            String instructions, List<HistoryMessage> history, List<InputImage> currentTurnImages,
            List<SkillDefinition> skills, List<ToolDefinition> tools, ToolBridge toolBridge,
            RunModel model, Boolean allowSilentEmpty, String emptyResponseText, Integer sessionGeneration) {
        this(botId, threadId, runId, executionScope, sourceMessageId, identity, prompt, productName,
                instructions, history, currentTurnImages, skills, tools, toolBridge, model,
                allowSilentEmpty, emptyResponseText, sessionGeneration, null);
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Identity(String userId, String spaceId, String botId, String threadId, String runId) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record HistoryMessage(String id, String role, String content, List<InputImage> images) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record InputImage(String name, String mimeType, String data) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record SkillDefinition(String id, String name, String description, String content) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ToolDefinition(String name, String description, Map<String, Object> inputSchema, Boolean readOnly) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ToolBridge(String url, String steeringUrl, String modelUrl,
            String taskUrl, String taskEventUrl, String token, Identity identity) {
        public ToolBridge(String url, String steeringUrl, String modelUrl, String token, Identity identity) {
            this(url, steeringUrl, modelUrl, null, null, token, identity);
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record RunModel(
            String provider,
            String id,
            String apiKey,
            String baseUrl,
            Boolean reasoning,
            Integer maxTokens,
            Integer contextWindow,
            String thinkingLevel,
            JsonNode oauth) {}

    public void validate() {
        if (identity == null || blank(identity.userId) || blank(identity.spaceId)
                || !equals(botId, identity.botId) || !equals(threadId, identity.threadId)
                || !equals(runId, identity.runId)) {
            throw new IllegalArgumentException("Trusted run identity is missing or mismatched");
        }
        if (blank(prompt) || model == null || blank(model.id)) {
            throw new IllegalArgumentException("A prompt and model are required");
        }
        if (model.oauth != null && !model.oauth.isNull()) {
            throw new IllegalArgumentException("OAuth model credentials are unavailable to AgentScope Java");
        }
        if (executionScope != null && !List.of("chat", "auto-review", "history-compaction", "turn-routing").contains(executionScope)) {
            throw new IllegalArgumentException("Unsupported execution scope");
        }
        if (sessionGeneration != null && sessionGeneration < 0) {
            throw new IllegalArgumentException("Session generation must be non-negative");
        }
        if (toolBridge != null) {
            if (toolBridge.identity == null || !identity.equals(toolBridge.identity) || blank(toolBridge.token)) {
                throw new IllegalArgumentException("Tool bridge identity is missing or mismatched");
            }
            ToolBridgeClient.validateUrl(toolBridge.url);
            if (toolBridge.steeringUrl != null) ToolBridgeClient.validateUrl(toolBridge.steeringUrl);
            if (toolBridge.modelUrl != null) ToolBridgeClient.validateUrl(toolBridge.modelUrl);
            if (toolBridge.taskUrl != null) ToolBridgeClient.validateUrl(toolBridge.taskUrl);
            if (toolBridge.taskEventUrl != null) ToolBridgeClient.validateUrl(toolBridge.taskEventUrl);
        }
        if (tools != null && !tools.isEmpty() && toolBridge == null) {
            throw new IllegalArgumentException("Authorized tools require a trusted bridge");
        }
        if (tools != null) {
            Set<String> reserved = Set.of("agent_spawn", "agent_send", "agent_list", "task",
                    "task_output", "task_cancel", "task_list", "wait_async_results",
                    "plan_enter", "plan_write", "plan_exit", "load_skill_through_path");
            Set<String> seen = new HashSet<>();
            for (ToolDefinition tool : tools) {
                if (tool == null || blank(tool.name()) || reserved.contains(tool.name())
                        || !seen.add(tool.name())) {
                    throw new IllegalArgumentException("Invalid or conflicting authorized tool name");
                }
            }
        }
    }

    public String scope() { return executionScope == null ? "chat" : executionScope; }
    public boolean isChat() { return "chat".equals(scope()); }
    public int generation() { return sessionGeneration == null ? 0 : sessionGeneration; }
    public static boolean blank(String value) { return value == null || value.isBlank(); }
    private static boolean equals(String a, String b) { return a != null && a.equals(b); }
}
