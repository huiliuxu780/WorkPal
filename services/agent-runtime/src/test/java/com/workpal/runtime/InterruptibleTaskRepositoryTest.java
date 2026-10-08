package com.workpal.runtime;

import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.harness.agent.subagent.task.TaskRunSpec;
import io.agentscope.harness.agent.workspace.WorkspaceManager;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Product Harness Phase 2: the helper budget and background permission are
 * enforced at the real spawn boundary, not merely prompted. These guards throw
 * before delegating to the native repository, so the assertions are exact and
 * deterministic.
 */
class InterruptibleTaskRepositoryTest {
    @TempDir Path temp;

    private TaskRunSpec spec() {
        return new TaskRunSpec.LocalTaskRunSpec(() -> "done");
    }

    private RuntimeContext context() {
        return RuntimeContext.builder().userId("u").sessionId("s").build();
    }

    @Test void refusesBackgroundRegistrationWhenPolicyDisablesIt() {
        InterruptibleTaskRepository repository = new InterruptibleTaskRepository(
                new WorkspaceManager(temp.resolve("bg-off")), "parent", false, 3);
        IllegalStateException error = assertThrows(IllegalStateException.class, () -> repository.putTask(
                context(), "task-1", "agent-1", "session-1", spec()));
        assertTrue(error.getMessage().contains("Background helpers are not allowed"));
    }

    @Test void refusesBeyondTheHelperBudget() {
        // maxChildren=0: even the first spawn must exceed the budget. The
        // increment/decrement keeps the counter balanced for a later retry.
        InterruptibleTaskRepository repository = new InterruptibleTaskRepository(
                new WorkspaceManager(temp.resolve("budget")), "parent", true, 0);
        IllegalStateException error = assertThrows(IllegalStateException.class, () -> repository.putTask(
                context(), "task-1", "agent-1", "session-1", spec()));
        assertTrue(error.getMessage().contains("Delegation budget exceeded"));
        // A second attempt still exceeds — the failed attempt did not leak a count.
        assertThrows(IllegalStateException.class, () -> repository.putTask(
                context(), "task-2", "agent-2", "session-1", spec()));
    }
}
