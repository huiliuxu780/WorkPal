package com.workpal.runtime;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.tool.ToolBase;
import io.agentscope.core.tool.ToolCallParam;
import io.agentscope.core.tool.ToolSuspendException;
import java.util.Map;
import java.util.Set;
import reactor.core.publisher.Mono;

/** An AgentScope external tool with WorkPal's read-only classification preserved. */
public final class BackendSchemaTool extends ToolBase {
    private final ToolBridgeClient bridge;
    private final ObjectMapper json;
    private final String parentSession;
    private final Set<String> pausedCalls;

    public BackendSchemaTool(RunRequest.ToolDefinition definition, ToolBridgeClient bridge,
            ObjectMapper json, String parentSession, Set<String> pausedCalls) {
        super(ToolBase.builder()
                .name(definition.name())
                .description(definition.description())
                .inputSchema(definition.inputSchema() == null
                        ? Map.of("type", "object", "properties", Map.of()) : definition.inputSchema())
                .readOnly(Boolean.TRUE.equals(definition.readOnly()))
                .concurrencySafe(Boolean.TRUE.equals(definition.readOnly()))
                .externalTool(Set.of("ask_user", "request_takeover", "runtime_current_time")
                        .contains(definition.name())));
        this.bridge = bridge;
        this.json = json;
        this.parentSession = parentSession;
        this.pausedCalls = pausedCalls;
    }

    @Override public Mono<ToolResultBlock> callAsync(ToolCallParam param) {
        return Mono.fromCallable(() -> {
            var call = param.getToolUseBlock();
            String executionId = call.getId();
            String session = param.getRuntimeContext() == null ? null : param.getRuntimeContext().getSessionId();
            boolean child = session != null && !session.equals(parentSession);
            if (child) {
                executionId = "subagent:" + session + ":" + executionId;
            }
            var outcome = bridge.execute(call.getName(), executionId, param.getInput(), child ? session : null);
            if (outcome.paused()) {
                if (child) throw new IllegalStateException("Delegated tool approval cannot resume in this run");
                pausedCalls.add(call.getId());
                throw new ToolSuspendException("WorkPal approval is pending");
            }
            return RuntimeEngine.resultBlock(json, call, outcome);
        });
    }
}
