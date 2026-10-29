package com.workpal.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RuntimeLogTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TRACE_ID = "0123456789abcdef0123456789abcdef";
    private static final String PARENT_SPAN_ID = "0123456789abcdef";

    @Test void backgroundWatcherRestoresOriginatingTraceOnVirtualThread() throws Exception {
        PrintStream original = System.err;
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        RuntimeLog.bind("00-" + TRACE_ID + "-" + PARENT_SPAN_ID + "-01", "request-1");
        Map<String, String> captured = RuntimeLog.current();
        try {
            System.setErr(new PrintStream(output, true, StandardCharsets.UTF_8));
            Thread watcher = Thread.ofVirtual().start(() -> RuntimeLog.withBindings(captured, () ->
                    RuntimeLog.error("runtime.background.terminal_delivery_failed",
                            Map.of("run.id", "run-1"), new java.io.IOException())));
            watcher.join();
        } finally {
            RuntimeLog.clear();
            System.setErr(original);
        }

        JsonNode event = JSON.readTree(output.toString(StandardCharsets.UTF_8).trim());
        assertEquals("runtime.background.terminal_delivery_failed", event.path("message").asText());
        assertEquals(TRACE_ID, event.path("trace.id").asText());
        assertEquals(PARENT_SPAN_ID, event.path("parent.span.id").asText());
        assertEquals("request-1", event.path("request.id").asText());
        assertEquals("run-1", event.path("run.id").asText());
    }
}
