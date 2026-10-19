package com.workpal.runtime;

import io.agentscope.core.hook.Hook;
import io.agentscope.core.hook.HookEvent;
import io.agentscope.core.hook.HookEventType;
import io.agentscope.core.message.Msg;
import io.agentscope.harness.agent.memory.compaction.TokenCounterUtil;
import java.util.List;
import reactor.core.publisher.Mono;

/**
 * ME-02 M3: bounded execution-lifecycle observability for the memory and
 * compaction pipelines. This hook emits metadata only — run/thread identity,
 * generation, event type, elapsed time, message count and an estimated token
 * count on POST_CALL. It never copies tool results or message content, never
 * writes native memory files, and never blocks the model: onEvent does one
 * synchronous bounded log line and returns the event unchanged.
 *
 * AgentScope 2.0.3 dispatches no dedicated "compaction complete" hook event
 * (verified against CompactionMiddleware: no hook dispatch at all), so native
 * compaction observability is limited to the surrounding PRE_CALL/POST_CALL
 * window plus the runtime's own logs. Application-layer compaction records
 * its own auditable revisions (ThreadCompactionRevision) and must not rely on
 * this hook. PRE_SUMMARY/POST_SUMMARY belong to the ReAct summary phase, not
 * to working-context compaction; they are logged as plain lifecycle signals.
 */
final class WorkPalMemorySignalHook implements Hook {

    private final String runId;
    private final String threadId;
    private final int generation;
    private final long startedAtNanos = System.nanoTime();

    WorkPalMemorySignalHook(RunRequest request) {
        this.runId = request.runId();
        this.threadId = request.threadId();
        this.generation = request.generation();
    }

    @Override
    public <T extends HookEvent> Mono<T> onEvent(T event) {
        try {
            HookEventType type = event.getType();
            if (type == null) {
                return Mono.just(event);
            }
            switch (type) {
                case PRE_CALL, POST_CALL, PRE_SUMMARY, POST_SUMMARY, ERROR -> emit(event, type);
                default -> {
                    // Chunk/acting/reasoning events are high-frequency; the
                    // signal stays bounded by ignoring them.
                }
            }
        } catch (RuntimeException ignored) {
            // Observability must never fail a run.
        }
        return Mono.just(event);
    }

    private void emit(HookEvent event, HookEventType type) {
        long elapsedMs = (System.nanoTime() - startedAtNanos) / 1_000_000L;
        StringBuilder line = new StringBuilder(160);
        line.append("agentscope.signal event=").append(type.name())
                .append(" run=").append(runId)
                .append(" thread=").append(threadId)
                .append(" generation=").append(generation)
                .append(" elapsed_ms=").append(elapsedMs);
        if (type == HookEventType.POST_CALL || type == HookEventType.PRE_SUMMARY) {
            // Bounded counts only — estimated tokens and message count, never
            // content. TokenCounterUtil is the same estimator the native
            // compactor uses, so the numbers describe the same quantity.
            try {
                if (event.getMemory() != null) {
                    List<Msg> messages = event.getMemory().getMessages();
                    line.append(" messages=").append(messages == null ? 0 : messages.size());
                    if (messages != null && !messages.isEmpty()) {
                        line.append(" estimated_tokens=").append(TokenCounterUtil.calculateToken(messages));
                    }
                }
            } catch (RuntimeException ignored) {
                // Estimation is best-effort metadata.
            }
        }
        System.err.println(line);
    }
}
