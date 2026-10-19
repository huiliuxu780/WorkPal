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
        String resumeAnswer,
        TurnPolicy turnPolicy,
        Collaboration collaborationContext,
        List<String> excludeDeliveredTaskIds,
        Boolean suppressNativeTaskReminders) {

    public RunRequest(String botId, String threadId, String runId, String executionScope,
            String sourceMessageId, Identity identity, String prompt, String productName,
            String instructions, List<HistoryMessage> history, List<InputImage> currentTurnImages,
            List<SkillDefinition> skills, List<ToolDefinition> tools, ToolBridge toolBridge,
            RunModel model, Boolean allowSilentEmpty, String emptyResponseText, Integer sessionGeneration,
            String resumeAnswer, TurnPolicy turnPolicy, Collaboration collaborationContext) {
        this(botId, threadId, runId, executionScope, sourceMessageId, identity, prompt, productName,
                instructions, history, currentTurnImages, skills, tools, toolBridge, model,
                allowSilentEmpty, emptyResponseText, sessionGeneration, resumeAnswer, turnPolicy,
                collaborationContext, null, null);
    }

    public RunRequest(String botId, String threadId, String runId, String executionScope,
            String sourceMessageId, Identity identity, String prompt, String productName,
            String instructions, List<HistoryMessage> history, List<InputImage> currentTurnImages,
            List<SkillDefinition> skills, List<ToolDefinition> tools, ToolBridge toolBridge,
            RunModel model, Boolean allowSilentEmpty, String emptyResponseText, Integer sessionGeneration) {
        this(botId, threadId, runId, executionScope, sourceMessageId, identity, prompt, productName,
                instructions, history, currentTurnImages, skills, tools, toolBridge, model,
                allowSilentEmpty, emptyResponseText, sessionGeneration, null, null, null, null, null);
    }

    public RunRequest(String botId, String threadId, String runId, String executionScope,
            String sourceMessageId, Identity identity, String prompt, String productName,
            String instructions, List<HistoryMessage> history, List<InputImage> currentTurnImages,
            List<SkillDefinition> skills, List<ToolDefinition> tools, ToolBridge toolBridge,
            RunModel model, Boolean allowSilentEmpty, String emptyResponseText, Integer sessionGeneration,
            String resumeAnswer) {
        this(botId, threadId, runId, executionScope, sourceMessageId, identity, prompt, productName,
                instructions, history, currentTurnImages, skills, tools, toolBridge, model,
                allowSilentEmpty, emptyResponseText, sessionGeneration, resumeAnswer, null, null, null, null);
    }

    /**
     * Product Harness Phase 2 immutable execution policy (wire shape from
     * packages/core turn-policy). The runtime enforces it and never
     * re-derives routing. Absent means per-scope defaults: chat keeps every
     * native capability; auxiliary scopes are already capability-free.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record TurnPolicy(String version, Boolean interactive, String planning, Delegation delegation,
            Ownership ownership, String routingKind, Budget budget, Approval approval,
            Retry retry, Subagent subagent) {

        @JsonIgnoreProperties(ignoreUnknown = true)
        public record Delegation(String mode, Boolean background, Integer maxChildren, Integer maxDepth) {}

        @JsonIgnoreProperties(ignoreUnknown = true)
        public record Ownership(String mode, String ownerBotId) {}

        /** maxCostUsd is an unsupported compatibility field: validated, never enforced. */
        @JsonIgnoreProperties(ignoreUnknown = true)
        public record Budget(Integer maxTokens, Double maxCostUsd, Integer maxDurationSec,
                Integer maxToolCalls, Integer maxChildAgents, Integer maxDepth) {}

        @JsonIgnoreProperties(ignoreUnknown = true)
        public record Approval(Integer timeoutSec, String onTimeout) {}

        @JsonIgnoreProperties(ignoreUnknown = true)
        public record Retry(Integer maxAuto, List<String> retryable) {}

        @JsonIgnoreProperties(ignoreUnknown = true)
        public record Subagent(String permissionInheritance) {}
    }

    /**
     * Product Harness Phase 3 collaboration identity, derived by the backend
     * from the run's immutable lineage snapshot. Rendered into the prompt; the
     * runtime never infers identity from message content.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Collaboration(String role, String fromBotName, Boolean receivingOutcome) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Identity(String userId, String spaceId, String botId, String threadId, String runId) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record HistoryMessage(String id, String role, String content, List<InputImage> images,
            HistoryProvenance provenance) {
        public HistoryMessage(String id, String role, String content, List<InputImage> images) {
            this(id, role, content, images, null);
        }
    }

    /** Metadata supplied by the authenticated backend, never parsed from message text. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record HistoryProvenance(String kind, String originKind, String authorUserId,
            String contextKind, Integer generation, String revision) {}

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
        if (executionScope != null && !List.of("chat", "auto-review", "history-compaction",
                "turn-routing", "team-chat-judge",
                // ME-01/ME-02: zero-tool memory auxiliaries. The AG-01 rule
                // below (no backend tools or skills outside chat) covers them.
                "memory-extraction", "memory-summary").contains(executionScope)) {
            throw new IllegalArgumentException("Unsupported execution scope");
        }
        // AG-01: an auxiliary execution must never reach the model with callable
        // tools. Refuse mistakenly attached backend tool or skill payloads at
        // this trusted boundary instead of stripping them silently, so a
        // misconfiguration surfaces as an explicit run failure.
        if (!isChat() && ((tools != null && !tools.isEmpty())
                || (skills != null && !skills.isEmpty()))) {
            throw new IllegalArgumentException(
                    "Auxiliary execution scope must not carry backend tools or skills");
        }
        if (sessionGeneration != null && sessionGeneration < 0) {
            throw new IllegalArgumentException("Session generation must be non-negative");
        }
        if (history != null) for (HistoryMessage message : history) {
            if (message == null) throw new IllegalArgumentException("Invalid history message");
            HistoryProvenance source = message.provenance();
            if (source == null) continue; // Old wire data is conservatively unknown.
            if ("message".equals(source.kind())) {
                if (blank(message.id()) || blank(source.originKind()) || !Set.of("human_web", "human_messaging",
                        "messaging_external", "webhook", "automation", "bot", "system", "unknown")
                        .contains(source.originKind())
                        || (("human_web".equals(source.originKind())
                                || "human_messaging".equals(source.originKind()))
                                != !blank(source.authorUserId()))
                        || (("human_web".equals(source.originKind())
                                || "human_messaging".equals(source.originKind()))
                                && !"user".equals(message.role()))) {
                    throw new IllegalArgumentException("Invalid message provenance");
                }
            } else if ("application".equals(source.kind())) {
                if (message.id() != null || !"user".equals(message.role()) || blank(source.contextKind())
                        || !Set.of("compacted_summary", "semantic_recall", "durable_memory")
                                .contains(source.contextKind())
                        || source.generation() == null || source.generation() != generation()) {
                    throw new IllegalArgumentException("Invalid application-context provenance");
                }
            } else if (!"unknown".equals(source.kind())) {
                throw new IllegalArgumentException("Unsupported history provenance");
            }
        }
        if (turnPolicy != null && "v2".equals(turnPolicy.version())) {
            TurnPolicy.Budget budget = turnPolicy.budget();
            TurnPolicy.Approval approval = turnPolicy.approval();
            TurnPolicy.Retry retry = turnPolicy.retry();
            TurnPolicy.Subagent subagent = turnPolicy.subagent();
            if (budget == null || budget.maxTokens() == null || budget.maxTokens() < 0
                    || budget.maxCostUsd() == null || !Double.isFinite(budget.maxCostUsd()) || budget.maxCostUsd() < 0
                    || budget.maxDurationSec() == null || budget.maxDurationSec() < 0
                    || budget.maxToolCalls() == null || budget.maxToolCalls() < 0
                    || budget.maxChildAgents() == null || budget.maxChildAgents() < 0
                    || budget.maxDepth() == null || budget.maxDepth() < 0
                    || approval == null || approval.timeoutSec() == null || approval.timeoutSec() < 0
                    || !"expire".equals(approval.onTimeout())
                    || retry == null || retry.maxAuto() == null || retry.maxAuto() < 0
                    || retry.retryable() == null
                    || subagent == null || !"subset-readonly".equals(subagent.permissionInheritance())) {
                throw new IllegalArgumentException("Invalid v2 TurnPolicy constraints");
            }
        } else if (turnPolicy != null && turnPolicy.version() != null && !"v1".equals(turnPolicy.version())) {
            throw new IllegalArgumentException("Unsupported TurnPolicy version");
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

    /** Planning capability: chat scope only, unless the policy disables it. */
    public boolean planningAllowed() {
        if (!isChat()) return false;
        return turnPolicy == null || turnPolicy.planning() == null || "auto".equals(turnPolicy.planning());
    }

    /** Delegation capability: chat scope only, backend must have offered run_subagent. */
    public boolean delegationAllowed() {
        if (!isChat()) return false;
        // A tightened effective depth of zero disables the whole subagent
        // surface: no native spawn tool is exposed and background registration
        // is refused, so neither a synchronous nor a background spawn executes.
        if (maxDepth() <= 0) return false;
        if (turnPolicy == null || turnPolicy.delegation() == null) return true;
        return turnPolicy.delegation().mode() == null || "auto".equals(turnPolicy.delegation().mode());
    }

    /** Background helper spawns; defaults to allowed with no policy. */
    public boolean backgroundAllowed() {
        if (!delegationAllowed()) return false;
        if (turnPolicy == null || turnPolicy.delegation() == null) return true;
        return !Boolean.FALSE.equals(turnPolicy.delegation().background());
    }

    public int maxChildren() {
        // An explicit zero means "no helpers this turn" and must be preserved;
        // only an absent or nonsensical (negative) value falls back to the default.
        if (turnPolicy == null || turnPolicy.delegation() == null
                || turnPolicy.delegation().maxChildren() == null
                || turnPolicy.delegation().maxChildren() < 0) {
            return turnPolicy != null && turnPolicy.budget() != null
                    && turnPolicy.budget().maxChildAgents() != null
                    ? Math.min(3, Math.max(0, turnPolicy.budget().maxChildAgents())) : 3;
        }
        int delegated = turnPolicy.delegation().maxChildren();
        if (turnPolicy.budget() != null && turnPolicy.budget().maxChildAgents() != null) {
            return Math.min(delegated, Math.max(0, turnPolicy.budget().maxChildAgents()));
        }
        return delegated;
    }

    /**
     * Effective helper depth: the tightened minimum of the delegation and budget
     * values, with the same fallback rule as {@link #maxChildren()} — an explicit
     * zero is preserved, only absent or negative values fall back (to 1). The
     * AgentScope harness runs a flat helper fan-out, so any positive depth
     * executes at most one real layer; zero disables delegation entirely.
     */
    public int maxDepth() {
        if (turnPolicy == null || turnPolicy.delegation() == null
                || turnPolicy.delegation().maxDepth() == null
                || turnPolicy.delegation().maxDepth() < 0) {
            return turnPolicy != null && turnPolicy.budget() != null
                    && turnPolicy.budget().maxDepth() != null
                    ? Math.min(1, Math.max(0, turnPolicy.budget().maxDepth())) : 1;
        }
        int delegated = turnPolicy.delegation().maxDepth();
        if (turnPolicy.budget() != null && turnPolicy.budget().maxDepth() != null) {
            return Math.min(delegated, Math.max(0, turnPolicy.budget().maxDepth()));
        }
        return delegated;
    }

    public boolean interactive() {
        return turnPolicy == null || !Boolean.FALSE.equals(turnPolicy.interactive());
    }

    public boolean supportOwnership() {
        return turnPolicy != null && turnPolicy.ownership() != null
                && "support".equals(turnPolicy.ownership().mode());
    }

    public String routingKind() {
        return turnPolicy == null || blank(turnPolicy.routingKind()) ? scope() : turnPolicy.routingKind();
    }

    public String collaborationRole() {
        if (collaborationContext != null && !blank(collaborationContext.role())) {
            return collaborationContext.role();
        }
        return supportOwnership() ? "support" : "owner";
    }

    public static boolean blank(String value) { return value == null || value.isBlank(); }
    private static boolean equals(String a, String b) { return a != null && a.equals(b); }
}
