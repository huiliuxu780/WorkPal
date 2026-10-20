package com.workpal.runtime;

import io.agentscope.core.state.AgentStateStore;
import io.agentscope.core.state.State;
import io.agentscope.core.state.VersionedState;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * Concurrency guard around the library's JSON state store.
 *
 * <p>{@code JsonFileAgentStateStore} persists through a fixed temporary file
 * per state name ({@code <name>.json.tmp}) followed by an atomic rename. Two
 * concurrent saves of the SAME slot and state — e.g. the ReAct loop's
 * {@code persistAgentStateCas} on a reactor thread while AG-05's
 * {@code ToolSurfaceRefresh.replacePermissions} installs the per-run
 * allow-list on the model-call thread, or a background helper sharing the
 * parent session slot — race on that one tmp path: the loser finds the file
 * already renamed away and the whole model call fails with "Failed to save
 * state: agent_state". Observed intermittently since AG-05 (reproduces on
 * pre-UX-02 baselines at ~20-50% under load).
 *
 * <p>Serializing every store operation on one lock removes the file race
 * without changing semantics: the library's version CAS still runs inside the
 * delegate, each save is a small local file write, and readers never observe
 * a half-renamed file. All interface methods — including the versioning
 * defaults the delegate overrides — are forwarded explicitly so the wrapper
 * cannot fall back to divergent interface-default behavior.
 */
final class SerializedAgentStateStore implements AgentStateStore {
    private final AgentStateStore delegate;

    SerializedAgentStateStore(AgentStateStore delegate) {
        this.delegate = delegate;
    }

    @Override public synchronized void save(String userId, String sessionId, String name, State state) {
        delegate.save(userId, sessionId, name, state);
    }

    @Override public synchronized void save(String userId, String sessionId, String name,
            List<? extends State> states) {
        delegate.save(userId, sessionId, name, states);
    }

    @Override public synchronized <T extends State> Optional<T> get(String userId, String sessionId,
            String name, Class<T> type) {
        return delegate.get(userId, sessionId, name, type);
    }

    @Override public synchronized <T extends State> List<T> getList(String userId, String sessionId,
            String name, Class<T> type) {
        return delegate.getList(userId, sessionId, name, type);
    }

    @Override public synchronized boolean exists(String userId, String sessionId) {
        return delegate.exists(userId, sessionId);
    }

    @Override public synchronized void delete(String userId, String sessionId) {
        delegate.delete(userId, sessionId);
    }

    @Override public synchronized void delete(String userId, String sessionId, String name) {
        delegate.delete(userId, sessionId, name);
    }

    @Override public synchronized Set<String> listSessionIds(String userId) {
        return delegate.listSessionIds(userId);
    }

    @Override public synchronized boolean supportsVersioning() {
        return delegate.supportsVersioning();
    }

    @Override public synchronized <T extends State> VersionedState<T> getVersioned(String userId,
            String sessionId, String name, Class<T> type) {
        return delegate.getVersioned(userId, sessionId, name, type);
    }

    @Override public synchronized long saveIfVersion(String userId, String sessionId, String name,
            State state, long version) {
        return delegate.saveIfVersion(userId, sessionId, name, state, version);
    }

    @Override public synchronized void close() {
        delegate.close();
    }
}
