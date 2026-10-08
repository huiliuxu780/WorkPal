package com.workpal.runtime;

import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.harness.agent.subagent.task.BackgroundTask;
import io.agentscope.harness.agent.subagent.task.TaskRunSpec;
import io.agentscope.harness.agent.subagent.task.WorkspaceTaskRepository;
import io.agentscope.harness.agent.workspace.WorkspaceManager;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Native persistent repository with interruption of the local supplier on
 * cancellation, plus enforcement of the Product Harness Turn Policy at the
 * spawn boundary: background registration is refused when the policy disables
 * it, and the helper budget is a hard count rather than a prompt request.
 */
final class InterruptibleTaskRepository extends WorkspaceTaskRepository {
    private final ConcurrentHashMap<String, Thread> localWorkers = new ConcurrentHashMap<>();
    private final boolean backgroundAllowed;
    private final int maxChildren;
    /**
     * Shared with the engine across every attempt of the same Run so a retry or
     * resume cannot reset the per-turn helper budget.
     */
    private final AtomicInteger children;

    InterruptibleTaskRepository(WorkspaceManager workspace, String parentAgentId,
            boolean backgroundAllowed, int maxChildren, AtomicInteger children) {
        super(workspace, parentAgentId);
        this.backgroundAllowed = backgroundAllowed;
        this.maxChildren = maxChildren;
        this.children = children;
    }

    @Override public BackgroundTask putTask(RuntimeContext context, String taskId, String agentId,
            String sessionId, TaskRunSpec spec) {
        if (!backgroundAllowed) {
            throw new IllegalStateException(
                    "Background helpers are not allowed for this turn. Use a synchronous helper or complete the work directly.");
        }
        if (children.incrementAndGet() > maxChildren) {
            children.decrementAndGet();
            throw new IllegalStateException(
                    "Delegation budget exceeded for this turn. Continue with the results you already have.");
        }
        if (spec instanceof TaskRunSpec.LocalTaskRunSpec local) {
            spec = new TaskRunSpec.LocalTaskRunSpec(() -> {
                localWorkers.put(taskId, Thread.currentThread());
                try { return local.execution().get(); }
                finally { localWorkers.remove(taskId, Thread.currentThread()); }
            });
        }
        try {
            return super.putTask(context, taskId, agentId, sessionId, spec);
        } catch (RuntimeException | Error failure) {
            children.decrementAndGet();
            throw failure;
        }
    }

    @Override public boolean cancelTask(RuntimeContext context, String sessionId, String taskId) {
        boolean cancelled = super.cancelTask(context, sessionId, taskId);
        Thread worker = localWorkers.get(taskId);
        if (worker != null) worker.interrupt();
        return cancelled;
    }
}
