package com.workpal.runtime;

/**
 * RUNTIME-RELIABILITY-01: the stable, user-invisible failure categories this
 * process reports. Every category is derived from a throwable type or throw site
 * that actually exists in this runtime — there is deliberately no
 * {@code model_failure} category, because the AgentScope SDK surfaces provider
 * errors as its own exception types and a category we cannot detect would be a
 * false signal. A model failure is located by the {@code runtime.stream.failed}
 * event and its {@code error.type} instead.
 *
 * <p>The exception message never contributes to a category: provider and
 * connector messages can carry credential-bearing URLs.
 */
final class FailureCategory {
    static final String CANCELLED = "cancelled";
    static final String SESSION_CONFLICT = "session_conflict";
    static final String TOOL_BRIDGE = "tool_bridge";
    static final String RESUME_LIMIT = "resume_limit";
    static final String REQUEST_REJECTED = "request_rejected";
    static final String INTERNAL = "internal";

    private static final String BRIDGE_CLASS = ToolBridgeClient.class.getName();

    private FailureCategory() {}

    static String of(Throwable error, boolean interrupted) {
        if (interrupted) return CANCELLED;
        for (Throwable current = error; current != null; current = current.getCause()) {
            if (current instanceof InterruptedException) return CANCELLED;
            if (current instanceof SessionCheckpointStore.Conflict) return SESSION_CONFLICT;
            if (current instanceof IllegalStateException
                    && RuntimeEngine.RESUME_LIMIT_EXCEEDED.equals(current.getMessage())) {
                return RESUME_LIMIT;
            }
            if (originatesInBridge(current)) return TOOL_BRIDGE;
            if (current.getCause() == current) break;
        }
        return INTERNAL;
    }

    private static boolean originatesInBridge(Throwable error) {
        for (StackTraceElement frame : error.getStackTrace()) {
            if (BRIDGE_CLASS.equals(frame.getClassName())) return true;
        }
        return false;
    }
}
