package com.workpal.runtime;

import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.harness.agent.subagent.task.BackgroundTask;
import io.agentscope.harness.agent.subagent.task.TaskRunSpec;
import io.agentscope.harness.agent.subagent.task.WorkspaceTaskRepository;
import io.agentscope.harness.agent.workspace.WorkspaceManager;
import java.util.concurrent.ConcurrentHashMap;

/** Native persistent repository with interruption of the local supplier on cancellation. */
final class InterruptibleTaskRepository extends WorkspaceTaskRepository {
    private final ConcurrentHashMap<String, Thread> localWorkers = new ConcurrentHashMap<>();

    InterruptibleTaskRepository(WorkspaceManager workspace, String parentAgentId) {
        super(workspace, parentAgentId);
    }

    @Override public BackgroundTask putTask(RuntimeContext context, String taskId, String agentId,
            String sessionId, TaskRunSpec spec) {
        if (spec instanceof TaskRunSpec.LocalTaskRunSpec local) {
            spec = new TaskRunSpec.LocalTaskRunSpec(() -> {
                localWorkers.put(taskId, Thread.currentThread());
                try { return local.execution().get(); }
                finally { localWorkers.remove(taskId, Thread.currentThread()); }
            });
        }
        return super.putTask(context, taskId, agentId, sessionId, spec);
    }

    @Override public boolean cancelTask(RuntimeContext context, String sessionId, String taskId) {
        boolean cancelled = super.cancelTask(context, sessionId, taskId);
        Thread worker = localWorkers.get(taskId);
        if (worker != null) worker.interrupt();
        return cancelled;
    }
}
