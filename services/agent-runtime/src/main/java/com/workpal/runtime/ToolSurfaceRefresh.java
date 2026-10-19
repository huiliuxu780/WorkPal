package com.workpal.runtime;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.ReActAgent;
import io.agentscope.core.agent.Agent;
import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.event.AgentEvent;
import io.agentscope.core.middleware.MiddlewareBase;
import io.agentscope.core.middleware.ModelCallInput;
import io.agentscope.core.model.ToolSchema;
import io.agentscope.core.permission.PermissionBehavior;
import io.agentscope.core.permission.PermissionContextState;
import io.agentscope.core.permission.PermissionMode;
import io.agentscope.core.permission.PermissionRule;
import io.agentscope.core.tool.AgentTool;
import io.agentscope.core.tool.Toolkit;
import io.agentscope.harness.agent.HarnessAgent;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Function;
import reactor.core.publisher.Flux;

/**
 * AG-05: replace the model-visible tool schemas immediately before every
 * provider HTTP call. Live backend tools are re-registered (name + schema) from
 * the current WorkPal surface; revoked backend tools stay on the Toolkit so a
 * hallucinated call still reaches WorkPal's execution refusal instead of
 * crashing inside AgentScope. Native harness tools stay policy-gated.
 */
final class ToolSurfaceRefresh implements MiddlewareBase {
    private final ToolBridgeClient bridge;
    private final ObjectMapper json;
    private final String parentSession;
    private final Set<String> pausedCalls;
    private final List<String> nativeVisible;
    private final String userSlot;
    private final String sessionSlot;
    private final java.nio.file.Path workspace;

    ToolSurfaceRefresh(ToolBridgeClient bridge, ObjectMapper json, String parentSession,
            Set<String> pausedCalls, List<String> nativeVisible,
            String userSlot, String sessionSlot, java.nio.file.Path workspace) {
        this.bridge = bridge;
        this.json = json;
        this.parentSession = parentSession;
        this.pausedCalls = pausedCalls;
        this.nativeVisible = List.copyOf(nativeVisible);
        this.userSlot = userSlot;
        this.sessionSlot = sessionSlot;
        this.workspace = workspace;
    }

    @Override public int order() {
        // Innermost around the actual model HTTP so later-added Harness
        // middleware cannot restore a stale snapshot.
        return Integer.MAX_VALUE;
    }

    @Override
    public Flux<AgentEvent> onModelCall(Agent agent, RuntimeContext context, ModelCallInput input,
            Function<ModelCallInput, Flux<AgentEvent>> next) {
        return Flux.defer(() -> next.apply(new ModelCallInput(
                input.messages(), visibleSchemas(agent), input.options(), input.model())));
    }

    private List<ToolSchema> visibleSchemas(Agent agent) {
        Toolkit toolkit = agent.getToolkit();
        LinkedHashSet<String> liveBackend = new LinkedHashSet<>();
        for (RunRequest.ToolDefinition tool : bridge.refreshSurface()) {
            if ("run_subagent".equals(tool.name())) continue;
            AgentTool existing = toolkit.getTool(tool.name());
            if (existing != null) toolkit.removeTool(tool.name());
            // UX-02: plan tools re-register as projection facades on every
            // refresh, and their presence in the live surface is how the
            // backend expresses the planning/build phase per model call.
            toolkit.registerAgentTool(PlanBridgeTool.PLAN_TOOL_NAMES.contains(tool.name())
                    ? new PlanBridgeTool(tool, bridge, json, parentSession, pausedCalls, workspace)
                    : new BackendSchemaTool(tool, bridge, json, parentSession, pausedCalls));
            liveBackend.add(tool.name());
        }
        replacePermissions(agent, toolkit, liveBackend);
        LinkedHashSet<String> allowed = new LinkedHashSet<>(nativeVisible);
        allowed.addAll(liveBackend);
        List<ToolSchema> visible = new ArrayList<>();
        for (ToolSchema schema : toolkit.getToolSchemas()) {
            if (allowed.contains(schema.getName())) visible.add(schema);
        }
        return visible;
    }

    private void replacePermissions(Agent agent, Toolkit toolkit, Set<String> liveBackend) {
        var permissions = PermissionContextState.builder().mode(PermissionMode.DEFAULT);
        LinkedHashSet<String> backendAllow = new LinkedHashSet<>(liveBackend);
        for (String name : toolkit.getToolNames()) {
            if (toolkit.getTool(name) instanceof BackendSchemaTool) backendAllow.add(name);
        }
        for (String name : backendAllow) {
            permissions.addAllowRule(name, new PermissionRule(
                    name, null, PermissionBehavior.ALLOW, "workpal-run-allowlist"));
        }
        for (String name : nativeVisible) {
            permissions.addAllowRule(name, new PermissionRule(
                    name, null, PermissionBehavior.ALLOW, "workpal-harness"));
        }
        // UX-02: no workpal-plan-approval ASK rule. A plan submission pauses
        // through the backend's typed plan_review Intervention on the bridge,
        // so plan_exit is an ALLOW-listed backend tool like every other.
        ReActAgent react = reactAgent(agent);
        if (react != null) react.replacePermissionContext(userSlot, sessionSlot, permissions.build());
    }

    private static ReActAgent reactAgent(Agent agent) {
        if (agent instanceof ReActAgent react) return react;
        if (agent instanceof HarnessAgent harness) return harness.getDelegate();
        return null;
    }
}
