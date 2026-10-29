package com.workpal.runtime;

import io.agentscope.core.model.ModelHttpException;
import java.net.SocketTimeoutException;
import java.net.http.HttpTimeoutException;
import java.util.concurrent.TimeoutException;

/**
 * RUN-FAILURE-01: the stable, user-invisible failure categories this process
 * reports. Every category is derived from a throwable type, a throw site or the
 * provider's HTTP status — never from exception or provider text, which can
 * carry credential-bearing URLs.
 *
 * <p>Model-layer failures are classified by {@link #forModelStream(Throwable)}
 * at the AgentScope stream boundary. The provider classes follow the SDK's own
 * stable contract ({@link ModelHttpException#isRetryableHttpStatus()}): a
 * retryable status (429 and 5xx) is bounded by the backend's automatic Retry
 * budget, a rejected request is terminal, and an unidentifiable stream failure
 * stays {@link #INTERNAL} so it cannot be replayed as if it were transient.
 */
final class FailureCategory {
    static final String CANCELLED = "cancelled";
    static final String SESSION_CONFLICT = "session_conflict";
    static final String TOOL_BRIDGE = "tool_bridge";
    static final String RESUME_LIMIT = "resume_limit";
    static final String REQUEST_REJECTED = "request_rejected";
    static final String INTERNAL = "internal";
    /** Provider HTTP 429/5xx: the backend may spend its bounded automatic Retry budget. */
    static final String PROVIDER_UNAVAILABLE = "provider_unavailable";
    /** A model-transport timeout: retryable under the same bounded budget. */
    static final String PROVIDER_TIMEOUT = "provider_timeout";
    /** Provider HTTP 4xx other than 429/408: retrying cannot help. */
    static final String PROVIDER_REJECTED = "provider_rejected";

    private static final String BRIDGE_CLASS = ToolBridgeClient.class.getName();

    private FailureCategory() {}

    static String of(Throwable error, boolean interrupted) {
        if (interrupted) return CANCELLED;
        for (Throwable current = error; current != null; current = current.getCause()) {
            if (current instanceof InterruptedException) return CANCELLED;
            if (current instanceof ModelStreamFailure streamFailure) return streamFailure.category();
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

    static String forModelStream(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            if (current instanceof InterruptedException) return CANCELLED;
            if (current instanceof ModelHttpException http) {
                Integer status = http.getStatusCode();
                if (status != null) {
                    if (status == 408) return PROVIDER_TIMEOUT;
                    return http.isRetryableHttpStatus() ? PROVIDER_UNAVAILABLE : PROVIDER_REJECTED;
                }
            }
            if (current instanceof SocketTimeoutException
                    || current instanceof HttpTimeoutException
                    || current instanceof TimeoutException) {
                return PROVIDER_TIMEOUT;
            }
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
