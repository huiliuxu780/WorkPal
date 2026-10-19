package com.workpal.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.agent.Agent;
import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.tool.ToolBase;
import io.agentscope.core.tool.ToolCallParam;
import io.agentscope.core.tool.ToolSuspendException;
import io.agentscope.harness.agent.HarnessAgent;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import reactor.core.publisher.Mono;

/**
 * UX-02 unified plan facade. plan_enter/plan_write/plan_exit (and the
 * structured publish_run_plan) execute through WorkPal's backend bridge like
 * every other backend tool, so the PostgreSQL RunPlan stays the single
 * authoritative plan identity, content version, and approval state for both
 * entry chains. This class keeps the native plan mode state and the workspace
 * PLAN.md as recoverable projections of that same plan — never as a second
 * approvable truth:
 *
 * <ul>
 *   <li>there is no separate workpal-plan-approval card anymore: a submission
 *       pauses the run through the backend's typed plan_review Intervention
 *       (bridge status "paused" → {@link ToolSuspendException}), and the
 *       resumed bridge re-run carries the durable decision in its result;</li>
 *   <li>an approved decision exits native PLAN mode; a changes_requested
 *       decision re-enters it, so the revision phase is read-only again;</li>
 *   <li>every result carrying the current plan rewrites plans/PLAN.md from
 *       backend-projected content, so the model never reads a stale plan file
 *       after a structured publish.</li>
 * </ul>
 *
 * Projection failures are logged and never fail the tool call: the backend
 * plan state is authoritative and already committed at that point.
 */
final class PlanBridgeTool extends ToolBase {
    static final Set<String> PLAN_TOOL_NAMES =
            Set.of("plan_enter", "plan_write", "plan_exit", "publish_run_plan");

    private final ToolBridgeClient bridge;
    private final ObjectMapper json;
    private final String parentSession;
    private final Set<String> pausedCalls;
    private final Path workspace;

    PlanBridgeTool(RunRequest.ToolDefinition definition, ToolBridgeClient bridge,
            ObjectMapper json, String parentSession, Set<String> pausedCalls, Path workspace) {
        super(ToolBase.builder()
                .name(definition.name())
                .description(definition.description())
                .inputSchema(definition.inputSchema() == null
                        ? Map.of("type", "object", "properties", Map.of()) : definition.inputSchema())
                // Plan records mutate PostgreSQL plan state; they are never
                // helper- or background-eligible (both surfaces filter on
                // readOnly) and never skip the PLAN-mode always-allowed names.
                .readOnly(false)
                .concurrencySafe(false)
                .externalTool(false));
        this.bridge = bridge;
        this.json = json;
        this.parentSession = parentSession;
        this.pausedCalls = pausedCalls;
        this.workspace = workspace;
    }

    @Override public Mono<ToolResultBlock> callAsync(ToolCallParam param) {
        return Mono.fromCallable(() -> {
            var call = param.getToolUseBlock();
            String session = param.getRuntimeContext() == null ? null : param.getRuntimeContext().getSessionId();
            if (session != null && !session.equals(parentSession)) {
                throw new IllegalStateException("Plan tools are not available to delegated helpers");
            }
            var outcome = bridge.execute(call.getName(), call.getId(), param.getInput());
            if (outcome.paused()) {
                pausedCalls.add(call.getId());
                throw new ToolSuspendException("WorkPal plan review is pending");
            }
            ToolResultBlock result = RuntimeEngine.resultBlock(json, call, outcome);
            applyProjection(call.getName(), outcome, param);
            return result;
        });
    }

    private void applyProjection(String name, ToolBridgeClient.ToolOutcome outcome, ToolCallParam param) {
        if (outcome.error() != null || outcome.result() == null) return;
        JsonNode value = outcome.result();
        String status = value.path("status").asText("");
        try {
            Agent agent = param.getAgent();
            RuntimeContext context = param.getRuntimeContext();
            HarnessAgent harness = agent instanceof HarnessAgent found ? found : null;
            if (harness != null && context != null) {
                if ("plan_enter".equals(name) && "entered".equals(status)
                        && !harness.isPlanModeActive(context)) {
                    harness.enterPlanMode(context);
                }
                if ("approved".equals(status) && harness.isPlanModeActive(context)) {
                    harness.exitPlanMode(context);
                }
                if ("changes_requested".equals(status) && !harness.isPlanModeActive(context)) {
                    harness.enterPlanMode(context);
                }
            }
            writePlanProjection(value);
        } catch (Exception error) {
            System.err.println("Plan projection failed (backend plan stays authoritative): " + error);
        }
    }

    /** Rewrite plans/PLAN.md from the backend's plan projection, if present. */
    private void writePlanProjection(JsonNode value) {
        JsonNode plan = value.path("plan");
        if (!plan.isObject() || !plan.hasNonNull("goal")) return;
        StringBuilder markdown = new StringBuilder("# Plan\n\n");
        long revision = plan.path("revision").asLong(0);
        long contentVersion = plan.path("contentVersion").asLong(0);
        if (revision > 0 || contentVersion > 0) {
            markdown.append("Revision ").append(revision);
            if (contentVersion > 0) markdown.append(" · content version ").append(contentVersion);
            markdown.append("\n\n");
        }
        markdown.append("## Goal\n\n").append(plan.path("goal").asText("")).append("\n\n");
        JsonNode items = plan.path("items");
        if (items.isArray() && !items.isEmpty()) {
            markdown.append("## Items\n\n");
            int index = 1;
            for (JsonNode item : items) {
                markdown.append(index++).append(". [").append(item.path("status").asText("pending"))
                        .append("] ").append(item.path("title").asText(""))
                        .append(" (id: ").append(item.path("id").asText("")).append(")");
                if (item.hasNonNull("reason")) {
                    markdown.append(" — ").append(item.path("reason").asText(""));
                }
                markdown.append('\n');
            }
        }
        markdown.append("\nThis file is a projection of the authoritative product Plan.")
                .append(" Edit the plan with plan_write / publish_run_plan, never by writing this file.\n");
        try {
            Path dir = workspace.resolve("plans");
            Files.createDirectories(dir);
            Files.writeString(dir.resolve("PLAN.md"), markdown.toString(), StandardCharsets.UTF_8);
        } catch (Exception error) {
            System.err.println("PLAN.md projection write failed: " + error);
        }
    }
}
