package com.workpal.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.agentscope.harness.agent.memory.compaction.CompactionConfig;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.*;

/**
 * ME-02 M4/M3 (Java side): native compaction trigger/keep budgets are explicit
 * token values derived from the actual model window — the AG-02 "30/10 vs
 * dynamic cutoff" deviation is resolved by making the configured semantics the
 * real semantics — and WorkPalMemorySignalHook stays bounded lifecycle
 * metadata: no memory writes, no content copies, no blocking.
 */
class CompactionTokenBudgetTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String FILLER =
            "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";
    private static final String SECRET_NEEDLE = "TOKEN_budget_SECRET_MARKER";

    @TempDir Path temp;

    // ------------------------------------------------------------------
    // Budget formula
    // ------------------------------------------------------------------

    @Test void productionCompactionDerivesExplicitTokenBudgetsFromTheActualWindow() {
        // Small window: the reserve does not fit, so the trigger falls back to
        // half the window (AgentScope dynamic semantics, now explicit) and the
        // keep floor applies.
        CompactionConfig small = RuntimeEngine.productionCompaction(8_192);
        assertEquals(4_096, small.getTriggerTokens());
        assertEquals(2_000, small.getKeepTokens());

        // Large window: window - reserved trigger, ratio keep capped at 8k.
        CompactionConfig large = RuntimeEngine.productionCompaction(200_000);
        assertEquals(180_000, large.getTriggerTokens());
        assertEquals(8_000, large.getKeepTokens());

        // Unknown window falls back to the same default the model factory uses.
        CompactionConfig unknown = RuntimeEngine.productionCompaction(null);
        assertEquals(128_000 - RuntimeEngine.COMPACTION_RESERVED_TOKENS, unknown.getTriggerTokens());

        // AG-02 side effects stay off in every derivation.
        for (CompactionConfig config : List.of(small, large, unknown)) {
            assertFalse(config.isFlushBeforeCompact());
            assertFalse(config.isOffloadBeforeCompact());
            // Message counts remain as the coarse backstop only.
            assertEquals(30, config.getTriggerMessages());
            assertEquals(10, config.getKeepMessages());
        }
    }

    @Test void productionEngineUsesTheRequestWindowAndSeamConfigsStayVerbatim() throws Exception {
        RuntimeEngine production = new RuntimeEngine(JSON, temp.resolve("s1"), temp.resolve("w1"));
        CompactionConfig derived = production.effectiveCompaction(requestWithWindow(8_192));
        assertEquals(4_096, derived.getTriggerTokens());
        assertEquals(2_000, derived.getKeepTokens());

        CompactionConfig seam = CompactionConfig.builder().triggerMessages(7).keepMessages(3).build();
        RuntimeEngine seamEngine = new RuntimeEngine(JSON, temp.resolve("s2"), temp.resolve("w2"), seam);
        assertSame(seam, seamEngine.effectiveCompaction(requestWithWindow(8_192)));
    }

    private static RunRequest requestWithWindow(Integer contextWindow) throws Exception {
        String body = """
                {"botId":"bot-1","threadId":"thread-1","runId":"run-1","executionScope":"chat",
                 "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"thread-1","runId":"run-1"},
                 "prompt":"hi","model":{"provider":"local","id":"fixture","apiKey":"k","baseUrl":"http://127.0.0.1:9/v1","contextWindow":%s}}
                """.formatted(contextWindow == null ? "null" : String.valueOf(contextWindow));
        RunRequest request = JSON.readValue(body, RunRequest.class);
        request.validate();
        return request;
    }

    // ------------------------------------------------------------------
    // Auxiliary memory scopes
    // ------------------------------------------------------------------

    @Test void memoryAuxiliaryScopesAreAcceptedAndRefuseTools() throws Exception {
        for (String scope : List.of("memory-extraction", "memory-summary")) {
            String body = """
                    {"botId":"bot-1","threadId":"thread-1","runId":"run-1","executionScope":"%s",
                     "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"thread-1","runId":"run-1"},
                     "prompt":"extract","model":{"provider":"p","id":"m"}}
                    """.formatted(scope);
            RunRequest request = JSON.readValue(body, RunRequest.class);
            request.validate();
            assertEquals(scope, request.scope());
            assertFalse(request.isChat());
        }
        String withTools = """
                {"botId":"bot-1","threadId":"thread-1","runId":"run-1","executionScope":"memory-extraction",
                 "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"thread-1","runId":"run-1"},
                 "prompt":"extract","model":{"provider":"p","id":"m"},
                 "tools":[{"name":"web_search","description":"d","inputSchema":{"type":"object"}}]}
                """;
        RunRequest refused = JSON.readValue(withTools, RunRequest.class);
        assertThrows(IllegalArgumentException.class, refused::validate);
    }

    // ------------------------------------------------------------------
    // Live token trigger + bounded hook signal
    // ------------------------------------------------------------------

    @Test void tokenTriggerFiresFromTheRealWindowAndHookStaysBoundedMetadata() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<String> kinds = new CopyOnWriteArrayList<>();
        HttpServer model = fixtureModel(requests, kinds);
        PrintStream originalErr = System.err;
        ByteArrayOutputStream signals = new ByteArrayOutputStream();
        Path state = temp.resolve("state");
        Path workspace = temp.resolve("workspace");
        try {
            RuntimeEngine engine = new RuntimeEngine(JSON, state, workspace);

            // Seed past the 30-message backstop so the first compaction fires,
            // then push a huge turn over the 8192-window token trigger (4096).
            System.setErr(new PrintStream(signals, true, StandardCharsets.UTF_8));
            engine.execute(chat(model.getAddress().getPort(), "budget-1",
                    "Follow up", largeHistory(40)), e -> {});
            assertTrue(kinds.contains("SUMMARY"), "first compaction must fire");

            kinds.clear();
            String huge = (FILLER + SECRET_NEEDLE + " ").repeat(220);
            engine.execute(chat(model.getAddress().getPort(), "budget-2", huge, List.of()), e -> {});
            assertTrue(kinds.contains("SUMMARY"),
                    "the token trigger derived from the 8192 window must fire on the huge turn: " + kinds);
        } finally {
            System.setErr(originalErr);
            model.stop(0);
        }

        String stderr = signals.toString(StandardCharsets.UTF_8);
        // Bounded lifecycle metadata with run/thread identity…
        assertTrue(stderr.contains("agentscope.signal event=POST_CALL"),
                "hook must emit POST_CALL lifecycle metadata");
        assertTrue(stderr.contains("run=budget-2"));
        assertTrue(stderr.contains("thread=thread-1"));
        assertTrue(stderr.contains("generation="));
        // …and never a copy of message content or tool results.
        assertFalse(stderr.contains(SECRET_NEEDLE),
                "hook output must not copy message content");
        assertFalse(stderr.contains("lorem ipsum"),
                "hook output must not copy message content");

        // No native memory side effects anywhere in this run.
        try (var walk = Files.walk(workspace)) {
            assertTrue(walk.filter(Files::isRegularFile)
                    .noneMatch(p -> p.toString().contains("/memory/")
                            || p.getFileName().toString().equals("MEMORY.md")),
                    "token-budget compaction must not write native memory files");
        }
    }

    private static RunRequest chat(int port, String runId, String prompt,
            List<RunRequest.HistoryMessage> history) throws Exception {
        String body = """
                {"botId":"bot-1","threadId":"thread-1","runId":"%s","executionScope":"chat",
                 "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"thread-1","runId":"%s"},
                 "prompt":%s,"instructions":"Reply concisely.",
                 "model":{"provider":"local","id":"fixture","apiKey":"test-key","baseUrl":"http://127.0.0.1:%d/v1","reasoning":false,"maxTokens":200,"contextWindow":8192}}
                """.formatted(runId, runId, JSON.writeValueAsString(prompt), port);
        com.fasterxml.jackson.databind.node.ObjectNode node =
                (com.fasterxml.jackson.databind.node.ObjectNode) JSON.readTree(body);
        node.set("history", JSON.valueToTree(history));
        RunRequest request = JSON.treeToValue(node, RunRequest.class);
        request.validate();
        return request;
    }

    private static List<RunRequest.HistoryMessage> largeHistory(int count) {
        List<RunRequest.HistoryMessage> history = new java.util.ArrayList<>();
        for (int i = 0; i < count; i++) {
            String role = i % 2 == 0 ? "user" : "assistant";
            history.add(new RunRequest.HistoryMessage("db-" + i, role,
                    role + " history line " + i + " " + FILLER.repeat(10), null, null));
        }
        return history;
    }

    private static HttpServer fixtureModel(List<JsonNode> requests, List<String> kinds) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/v1/chat/completions", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            requests.add(body);
            String all = body.path("messages").toString();
            String reply;
            if (all.contains("memory extraction assistant")) {
                kinds.add("FLUSH");
                reply = "must not happen";
            } else if (all.contains("Context Extraction Assistant")) {
                kinds.add("SUMMARY");
                reply = "WORKING_SUMMARY_MARKER — compacted earlier work.";
            } else {
                kinds.add("NORMAL");
                reply = "OK reply";
            }
            streamText(exchange, reply);
        });
        server.start();
        return server;
    }

    private static void streamText(HttpExchange exchange, String text) throws java.io.IOException {
        Map<String, Object> delta = new HashMap<>();
        delta.put("role", "assistant");
        delta.put("content", text);
        Map<String, Object> first = new HashMap<>();
        first.put("index", 0); first.put("delta", delta); first.put("finish_reason", null);
        String prefix = "{\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"fixture\",\"choices\":";
        byte[] stream = ("data: " + prefix + JSON.writeValueAsString(List.of(first)) + "}\n\n"
                + "data: " + prefix + JSON.writeValueAsString(List.of(Map.of("index", 0,
                "delta", Map.of(), "finish_reason", "stop"))) + "\n\n"
                + "data: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "text/event-stream");
        exchange.sendResponseHeaders(200, 0);
        try (var out = exchange.getResponseBody()) { out.write(stream); out.flush(); }
    }
}
