package com.workpal.runtime;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * RUNTIME-RELIABILITY-01: one NDJSON line per event, using the envelope and field
 * names {@code @rakazo/logging} already emits, so a single {@code trace.id} greps
 * across the API, the Worker, the TypeScript adapter and this process instead of
 * stopping at the process boundary.
 *
 * <p>Values are restricted to identifiers and fixed tokens. An exception message
 * can carry a credential-bearing URL or a provider key, so only the exception
 * class name and a stable failure category are ever emitted — never the message,
 * the prompt, user text, tool arguments or a raw model response.
 */
final class RuntimeLog {
    static final String SERVICE = "rakazo-agent-runtime";

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern TRACEPARENT =
            Pattern.compile("^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$");
    private static final String ZERO_TRACE = "00000000000000000000000000000000";
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    /** Correlation established at the HTTP boundary, visible to everything the run does on this thread. */
    private static final ThreadLocal<Map<String, String>> BOUND = new ThreadLocal<>();

    private RuntimeLog() {}

    /**
     * Bind the caller's trace to this thread. A request without a usable
     * traceparent still gets a locally generated trace, so an untraced caller
     * produces a correlatable run rather than an unattributable one.
     */
    static Map<String, String> bind(String traceparent, String requestId) {
        String traceId = null;
        String parentSpanId = null;
        if (traceparent != null) {
            Matcher match = TRACEPARENT.matcher(traceparent.trim().toLowerCase());
            if (match.matches() && !ZERO_TRACE.equals(match.group(2))) {
                traceId = match.group(2);
                parentSpanId = match.group(3);
            }
        }
        Map<String, String> bindings = new LinkedHashMap<>();
        bindings.put("trace.id", traceId != null ? traceId : newTraceId());
        bindings.put("span.id", newSpanId());
        if (parentSpanId != null) bindings.put("parent.span.id", parentSpanId);
        if (requestId != null && !requestId.isBlank()) bindings.put("request.id", requestId);
        BOUND.set(Map.copyOf(bindings));
        return Map.copyOf(bindings);
    }

    static Map<String, String> current() {
        Map<String, String> bindings = BOUND.get();
        return bindings != null ? bindings : Map.of();
    }

    /**
     * Run work on another thread with the originating request correlation.
     * Virtual/background threads do not inherit a plain ThreadLocal, so callers
     * must capture {@link #current()} before scheduling and install it around
     * the asynchronous work. The previous binding is restored for executor
     * threads that may be reused.
     */
    static void withBindings(Map<String, String> bindings, Runnable action) {
        Map<String, String> previous = BOUND.get();
        try {
            if (bindings == null || bindings.isEmpty()) BOUND.remove();
            else BOUND.set(Map.copyOf(bindings));
            action.run();
        } finally {
            if (previous == null) BOUND.remove();
            else BOUND.set(previous);
        }
    }

    static void clear() { BOUND.remove(); }

    /**
     * Build event bindings from alternating key/value pairs. {@link Map#of}
     * rejects nulls and an identifier can legitimately be absent (a run without
     * session admission has no attempt), so dropping the pair is the behaviour
     * every call site wants.
     */
    static Map<String, Object> bindings(Object... keyValues) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int index = 0; index + 1 < keyValues.length; index += 2) {
            Object value = keyValues[index + 1];
            if (value != null) map.put(String.valueOf(keyValues[index]), value);
        }
        return map;
    }

    static void info(String event, Map<String, ?> bindings) { emit("info", event, bindings, null); }

    static void warn(String event, Map<String, ?> bindings) { emit("warn", event, bindings, null); }

    /**
     * Record only what this layer observed — the failing type. Classification is
     * the HTTP boundary's fact, so the two layers stay complementary instead of
     * reporting the same failure twice.
     */
    static void error(String event, Map<String, ?> bindings, Throwable error) {
        Map<String, Object> serialized = new LinkedHashMap<>();
        serialized.put("type", error != null ? error.getClass().getName() : "unknown");
        emit("error", event, bindings, serialized);
    }

    /**
     * The category is a fixed token from {@link FailureCategory}; the throwable
     * contributes only its class name, which is what localizes the failing layer.
     */
    static void error(String event, Map<String, ?> bindings, String category, Throwable error) {
        Map<String, Object> serialized = new LinkedHashMap<>();
        serialized.put("category", category);
        serialized.put("type", error != null ? error.getClass().getName() : "unknown");
        emit("error", event, bindings, serialized);
    }

    private static void emit(String level, String event, Map<String, ?> bindings, Map<String, ?> error) {
        Map<String, Object> line = new LinkedHashMap<>();
        line.put("timestamp", Instant.now().toString());
        line.put("level", level);
        line.put("message", event);
        line.put("service.name", SERVICE);
        line.putAll(BOUND.get() != null ? BOUND.get() : Map.of());
        if (bindings != null) {
            for (Map.Entry<String, ?> entry : bindings.entrySet()) {
                if (entry.getValue() != null) line.put(entry.getKey(), entry.getValue());
            }
        }
        if (error != null) line.put("error", error);
        String serialized;
        try {
            serialized = JSON.writeValueAsString(line);
        } catch (Exception unserializable) {
            // Every value above is an identifier or a fixed token, so this cannot
            // carry run content; report the loss rather than drop it silently.
            serialized = "{\"timestamp\":\"" + Instant.now() + "\",\"level\":\"error\","
                    + "\"message\":\"runtime.log.unserializable\",\"service.name\":\"" + SERVICE + "\","
                    + "\"error\":{\"type\":\"" + unserializable.getClass().getName() + "\"}}";
        }
        // Match the TypeScript console sink: error and warn go to stderr.
        if ("error".equals(level) || "warn".equals(level)) System.err.println(serialized);
        else System.out.println(serialized);
    }

    private static String newTraceId() { return newHex(32); }

    private static String newSpanId() { return newHex(16); }

    private static String newHex(int length) {
        byte[] bytes = new byte[length / 2];
        RANDOM.nextBytes(bytes);
        StringBuilder hex = new StringBuilder(length);
        for (byte value : bytes) {
            hex.append(HEX[(value >> 4) & 0x0f]).append(HEX[value & 0x0f]);
        }
        return hex.toString();
    }
}
