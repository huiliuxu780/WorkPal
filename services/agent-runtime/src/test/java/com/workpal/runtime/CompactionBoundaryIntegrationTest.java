package com.workpal.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.agentscope.harness.agent.memory.compaction.CompactionConfig;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

/**
 * AG-02: verify and tighten the AgentScope native compaction boundary through the real
 * {@link RuntimeEngine} against a local OpenAI-compatible fixture, with isolated temporary
 * state/workspace. Every assertion here is driven by an actual run that triggers native 30/10
 * compaction — never by inspecting a builder value in isolation.
 *
 * <p>AgentScope 2.0.3 defaults {@code flushBeforeCompact} and {@code offloadBeforeCompact} to
 * true. WorkPal disables memory hooks/tools and filesystem tools, but those gates do NOT cover
 * the compaction-triggered flush/offload inside {@code ConversationCompactor}. The baseline
 * (pre-fix) behavior, reproduced here via the package-private seam with stock defaults, is:
 * <ul>
 *   <li>an extra "memory extraction assistant" model call before compaction;</li>
 *   <li>a native long-term memory file {@code memory/YYYY-MM-DD.md} written to the workspace;</li>
 *   <li>a model-visible summary that replaces the working summary with a dangling pointer
 *       ("The full conversation history has been saved to &lt;workspace&gt;.jsonl") that the
 *       model cannot read back because filesystem tools are disabled.</li>
 * </ul>
 * The production configuration disables both flags; the tests below prove the gap is closed
 * while native compaction (working summary + retained recent messages) still functions and
 * still continues across Runs.
 */
class CompactionBoundaryIntegrationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String FILLER =
            "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";
    private static final String WORKING_SUMMARY_MARKER = "WORKING_SUMMARY_MARKER";
    private static final String FLUSH_MEM_MARKER = "BASELINE_FLUSH_MEMORY";
    private static final String NEEDLE_RETAINED = "NEEDLE_RETAINED_AG02";
    private static final String NEEDLE_COMPACTED = "NEEDLE_COMPACTED_AG02";
    private static final String TENANT_A_MARKER = "TENANT_A_SECRET_AG02";
    private static final String APP_CURSOR_MARKER = "APP_CURSOR_MARKER_AG02";
    /** Offload-disabled native summary phrasing (AgentScope recipe when offloadBeforeCompact=false). */
    private static final String CLEAN_SUMMARY = "Here is a summary of the conversation to date";
    /** Offload-enabled dangling pointer phrasing (AgentScope recipe when offloadBeforeCompact=true). */
    private static final String OFFLOAD_POINTER = "has been saved to";
    /** WorkPal application-layer history.compact cursor marker (must never come from native compaction). */
    private static final String APP_LAYER_PHRASE = "owned compacted context through message sequence";

    @TempDir Path temp;

    // -------------------------------------------------------------------------------
    // Task 1 + Task 2/3 baseline: reproduce the PRE-FIX gap with AgentScope's stock
    // defaults through the real engine (package-private seam). Documents what the
    // production fix removes; stays valid because it opts into the default explicitly.
    // -------------------------------------------------------------------------------

    @Test void legacyAgentScopeDefaultsFlushNativeMemoryAndDangleOffloadPointer() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<String> kinds = new CopyOnWriteArrayList<>();
        HttpServer model = classifyingModel(requests, kinds);
        try {
            Path state = temp.resolve("state");
            Path workspace = temp.resolve("workspace");
            // Stock AgentScope defaults: triggerMessages/keepMessages set, flush/offload left true.
            RuntimeEngine engine = new RuntimeEngine(JSON, state, workspace, legacyDefaultCompaction());

            int seeded = 40;
            List<Map<String, Object>> events = new ArrayList<>();
            engine.execute(chat(model.getAddress().getPort(), "legacy-1", "user-1", "space-1", "bot-1",
                    "thread-1", "Continue and recall " + NEEDLE_COMPACTED + ".",
                    largeHistory(seeded, NEEDLE_COMPACTED, NEEDLE_RETAINED)), events::add);

            // Prove the compaction path actually executed (not just a config object).
            assertEquals("done", events.getLast().get("type"));
            Map<String, Long> counts = tally(kinds);
            // Deterministic single-compaction run under stock defaults: exactly one flush,
            // one summary, one normal reply (three model calls total).
            assertEquals(1L, counts.getOrDefault("SUMMARY", 0L),
                    "native compaction summary call must fire exactly once: " + counts);
            assertEquals(1L, counts.getOrDefault("NORMAL", 0L),
                    "exactly one normal reply call: " + counts);
            int ctx = contextSize(state);
            assertTrue(ctx > 0 && ctx < seeded, "compaction must shrink persisted context, got " + ctx);

            // PRE-FIX gap 1: extra memory-extraction model call before compaction.
            assertEquals(1L, counts.getOrDefault("FLUSH", 0L),
                    "legacy default must run exactly one pre-compaction memory flush call: " + counts);

            // PRE-FIX gap 2: native long-term memory file written to the workspace.
            List<Path> memoryFiles = filesUnder(workspace, p -> {
                String s = p.toString();
                return s.contains("/memory/") || s.endsWith("MEMORY.md");
            });
            assertFalse(memoryFiles.isEmpty(), "legacy default must write native memory files");
            String memoryContent = Files.readString(memoryFiles.get(0));
            assertTrue(memoryContent.contains(FLUSH_MEM_MARKER),
                    "native memory file must contain the flushed model output: " + memoryContent);

            // PRE-FIX gap 3: model-visible dangling offload pointer, no clean inline summary.
            assertTrue(anyMessageContains(requests, OFFLOAD_POINTER),
                    "legacy default must expose an offload file pointer to the model");
            assertFalse(anyMessageContains(requests, CLEAN_SUMMARY),
                    "legacy default replaces the clean summary with the pointer variant");
        } finally { model.stop(0); }
    }

    // -------------------------------------------------------------------------------
    // Task 2: production compaction summarizes with NO native memory side effects.
    // Normal replies and the necessary compaction summary are counted separately from
    // the forbidden pre-compaction memory-flush call.
    // -------------------------------------------------------------------------------

    @Test void productionCompactionSummarizesWithoutNativeMemoryFlushOrOffload() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<String> kinds = new CopyOnWriteArrayList<>();
        HttpServer model = classifyingModel(requests, kinds);
        try {
            Path state = temp.resolve("state");
            Path workspace = temp.resolve("workspace");
            RuntimeEngine engine = new RuntimeEngine(JSON, state, workspace); // production config

            int seeded = 40;
            List<Map<String, Object>> events = new ArrayList<>();
            engine.execute(chat(model.getAddress().getPort(), "prod-1", "user-1", "space-1", "bot-1",
                    "thread-1", "Continue and recall " + NEEDLE_COMPACTED + ".",
                    largeHistory(seeded, NEEDLE_COMPACTED, NEEDLE_RETAINED)), events::add);

            assertEquals("done", events.getLast().get("type"));
            // Compaction still happens: summary call present and context physically shrank.
            Map<String, Long> counts = tally(kinds);
            // P2 (review): this is a deterministic single-compaction run, so pin EXACT counts
            // rather than lower bounds — a loose ">=1 NORMAL" would let an extra reply-classified
            // call slip through. Exactly one compaction summary, exactly one normal reply, and
            // zero pre-compaction memory-flush calls; two model calls total.
            assertEquals(1L, counts.getOrDefault("SUMMARY", 0L),
                    "exactly one native compaction summary call: " + counts);
            assertEquals(1L, counts.getOrDefault("NORMAL", 0L),
                    "exactly one normal reply call: " + counts);
            assertEquals(0L, counts.getOrDefault("FLUSH", 0L),
                    "no pre-compaction memory-extraction model call may occur: " + counts);
            assertEquals(2, kinds.size(),
                    "a single compaction run makes exactly summary + reply calls: " + counts);
            int ctx = contextSize(state);
            assertTrue(ctx > 0 && ctx < seeded, "compaction must shrink persisted context, got " + ctx);

            // Counted separately above: the compaction summary is necessary and allowed; the
            // pre-compaction memory flush is an unauthorized extra call and is gone.

            // No native long-term memory files anywhere in the workspace.
            List<Path> memoryFiles = filesUnder(workspace, p -> {
                String s = p.toString();
                return s.contains("/memory/") || s.endsWith("MEMORY.md");
            });
            assertTrue(memoryFiles.isEmpty(),
                    "production compaction must not write native memory files: " + memoryFiles);

            // Working summary is inline and clean; no dangling offload pointer reaches the model.
            assertTrue(anyMessageContains(requests, CLEAN_SUMMARY),
                    "production summary must be the clean inline variant");
            assertFalse(anyMessageContains(requests, OFFLOAD_POINTER),
                    "production compaction must not expose an offload file pointer");
        } finally { model.stop(0); }
    }

    // -------------------------------------------------------------------------------
    // Task 3: after compaction, the NEXT model turn receives no dangling pointer.
    // -------------------------------------------------------------------------------

    @Test void productionCompactionLeavesNoDanglingPointerForTheNextModelTurn() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<String> kinds = new CopyOnWriteArrayList<>();
        HttpServer model = classifyingModel(requests, kinds);
        try {
            Path state = temp.resolve("state");
            RuntimeEngine engine = new RuntimeEngine(JSON, state, temp.resolve("workspace"));

            engine.execute(chat(model.getAddress().getPort(), "ptr-1", "user-1", "space-1", "bot-1",
                    "thread-1", "Continue.", largeHistory(40, NEEDLE_COMPACTED, NEEDLE_RETAINED)), e -> {});
            assertTrue(kinds.contains("SUMMARY"), "first run must compact");

            int before = requests.size();
            List<Map<String, Object>> second = new ArrayList<>();
            engine.execute(chat(model.getAddress().getPort(), "ptr-2", "user-1", "space-1", "bot-1",
                    "thread-1", "Now answer the follow-up question about the retained needle.",
                    List.of()), second::add);
            assertEquals("done", second.getLast().get("type"));

            List<JsonNode> nextTurn = requests.subList(before, requests.size());
            assertFalse(nextTurn.isEmpty(), "the follow-up run must reach the model");
            assertFalse(anyMessageContains(nextTurn, OFFLOAD_POINTER),
                    "the next model turn must not receive a dangling offload pointer");
            // The follow-up turn still carries the readable working summary and the retained
            // recent message (the marker is NOT in this run's prompt, so it can only come from
            // the persisted retained tail), so the model can continue without any file read-back.
            assertTrue(anyMessageContains(nextTurn, WORKING_SUMMARY_MARKER),
                    "the readable working summary must persist into the next turn");
            assertTrue(anyMessageContains(nextTurn, NEEDLE_RETAINED),
                    "a retained recent message must remain readable in the next turn");
        } finally { model.stop(0); }
    }

    // -------------------------------------------------------------------------------
    // Task 4a: cross-Run continuation using the working summary + retained recent
    // messages to answer a follow-up carrying a unique marker.
    // -------------------------------------------------------------------------------

    @Test void compactedSessionContinuesAcrossRunsWithSummaryAndRecentMessages() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<String> kinds = new CopyOnWriteArrayList<>();
        HttpServer model = classifyingModel(requests, kinds);
        try {
            Path state = temp.resolve("state");
            RuntimeEngine engine = new RuntimeEngine(JSON, state, temp.resolve("workspace"));

            // Run 1: seed a long conversation, plant a compacted needle (oldest) and a
            // retained needle (newest), and trigger native compaction.
            engine.execute(chat(model.getAddress().getPort(), "cont-1", "user-1", "space-1", "bot-1",
                    "thread-1", "Continue the task.",
                    largeHistory(40, NEEDLE_COMPACTED, NEEDLE_RETAINED)), e -> {});
            assertTrue(kinds.contains("SUMMARY"), "run 1 must compact");
            int afterFirst = contextSize(state);
            assertTrue(afterFirst > 0 && afterFirst < 40, "run 1 must shrink context, got " + afterFirst);

            // Run 2: a NEW Run in the SAME session asks a follow-up. The prompt does NOT echo
            // either marker, so their presence below can only come from the persisted native
            // working summary and the retained recent message — the real continuation proof.
            int before = requests.size();
            kinds.clear();
            List<Map<String, Object>> second = new ArrayList<>();
            engine.execute(chat(model.getAddress().getPort(), "cont-2", "user-1", "space-1", "bot-1",
                    "thread-1", "Follow-up: what was the retained needle from earlier?", List.of()),
                    second::add);
            assertEquals("done", second.getLast().get("type"));

            List<JsonNode> followUp = requests.subList(before, requests.size());
            // The follow-up Run's model request has the native working summary AND a unique
            // marker from the retained recent messages VISIBLE. The fixture returns a fixed
            // reply, so this asserts post-compaction context availability across Runs (what the
            // model is given), not that a real model answered correctly — see the delivery note.
            assertTrue(anyMessageContains(followUp, WORKING_SUMMARY_MARKER),
                    "the new Run must reuse the native working summary");
            assertTrue(anyMessageContains(followUp, NEEDLE_RETAINED),
                    "the new Run must reuse the retained recent message");
            // A second compaction did not spuriously fire on the short follow-up turn.
            assertEquals(0L, tally(kinds).getOrDefault("SUMMARY", 0L),
                    "a short follow-up turn must not re-trigger compaction");
        } finally { model.stop(0); }
    }

    // -------------------------------------------------------------------------------
    // Task 4b: a SECOND compaction (token-gated) fires and the session still continues.
    // -------------------------------------------------------------------------------

    @Test void secondCompactionFiresAndSessionStillContinues() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<String> kinds = new CopyOnWriteArrayList<>();
        HttpServer model = classifyingModel(requests, kinds);
        try {
            Path state = temp.resolve("state");
            RuntimeEngine engine = new RuntimeEngine(JSON, state, temp.resolve("workspace"));

            // First compaction via seeded history.
            engine.execute(chat(model.getAddress().getPort(), "twice-1", "user-1", "space-1", "bot-1",
                    "thread-1", "Continue.", largeHistory(40, NEEDLE_COMPACTED, NEEDLE_RETAINED)), e -> {});
            assertTrue(kinds.contains("SUMMARY"), "first compaction must fire");
            int afterFirst = contextSize(state);

            // Second compaction: a single very large follow-up turn pushes the persisted
            // context back over the (context-window-derived) token trigger.
            kinds.clear();
            String huge = FILLER.repeat(220); // ~16k chars, comfortably over the token trigger
            List<Map<String, Object>> second = new ArrayList<>();
            engine.execute(chat(model.getAddress().getPort(), "twice-2", "user-1", "space-1", "bot-1",
                    "thread-1", huge, List.of()), second::add);
            assertEquals("done", second.getLast().get("type"));
            assertTrue(kinds.contains("SUMMARY"),
                    "a second compaction must fire on the overflowing turn: " + tally(kinds));
            int afterSecond = contextSize(state);
            assertTrue(afterSecond > 0 && afterSecond < afterFirst + 3,
                    "second compaction must keep the context bounded, before=" + afterFirst
                            + " after=" + afterSecond);
            // No native memory side effects on either compaction.
            assertTrue(filesUnder(temp.resolve("workspace"), p -> {
                String s = p.toString();
                return s.contains("/memory/") || s.endsWith("MEMORY.md");
            }).isEmpty(), "neither compaction may write native memory files");
        } finally { model.stop(0); }
    }

    // -------------------------------------------------------------------------------
    // Task 4c: compacted session state does not leak across tenant/bot/thread.
    // -------------------------------------------------------------------------------

    @Test void compactedSessionStateDoesNotLeakAcrossTenantBotThread() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<String> kinds = new CopyOnWriteArrayList<>();
        HttpServer model = classifyingModel(requests, kinds);
        try {
            RuntimeEngine engine = new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"));

            // Session A: compact a conversation that carries a secret marker + summary.
            engine.execute(chat(model.getAddress().getPort(), "iso-a", "user-a", "space-a", "bot-1",
                    "thread-1", "Continue.", largeHistory(40, TENANT_A_MARKER, NEEDLE_RETAINED)), e -> {});
            assertTrue(kinds.contains("SUMMARY"), "session A must compact");

            String[][] boundaries = {
                    {"user-b", "space-a", "bot-1", "thread-1"},
                    {"user-a", "space-b", "bot-1", "thread-1"},
                    {"user-a", "space-a", "bot-2", "thread-1"},
                    {"user-a", "space-a", "bot-1", "thread-2"},
            };
            for (String[] b : boundaries) {
                int before = requests.size();
                engine.execute(chat(model.getAddress().getPort(), "iso-" + before, b[0], b[1], b[2], b[3],
                        "Fresh session, no shared context.", List.of()), e -> {});
                List<JsonNode> other = requests.subList(before, requests.size());
                assertFalse(other.isEmpty(), "boundary run must reach the model");
                assertFalse(anyMessageContains(other, TENANT_A_MARKER),
                        "session A content leaked across boundary " + String.join("/", b));
                assertFalse(anyMessageContains(other, WORKING_SUMMARY_MARKER),
                        "session A native summary leaked across boundary " + String.join("/", b));
            }
        } finally { model.stop(0); }
    }

    // -------------------------------------------------------------------------------
    // Task 4d: the native summary is a separate cursor from the PostgreSQL
    // application-layer history.compact summary; the two coexist and the native
    // summary never masquerades as (or advances) the application cursor.
    // -------------------------------------------------------------------------------

    @Test void nativeSummaryIsDistinctFromApplicationCompactionCursor() throws Exception {
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        List<String> kinds = new CopyOnWriteArrayList<>();
        HttpServer model = classifyingModel(requests, kinds);
        try {
            Path state = temp.resolve("state");
            RuntimeEngine engine = new RuntimeEngine(JSON, state, temp.resolve("workspace"));

            // Run 1: produce a native compaction summary.
            engine.execute(chat(model.getAddress().getPort(), "cur-1", "user-1", "space-1", "bot-1",
                    "thread-1", "Continue.", largeHistory(40, NEEDLE_COMPACTED, NEEDLE_RETAINED)
                            .stream().map(item -> new RunRequest.HistoryMessage("db-" + item.content().hashCode(),
                                    item.role(), item.content(), item.images(),
                                    new RunRequest.HistoryProvenance("message", "unknown", null, null, null, null)))
                            .toList()), e -> {});
            assertTrue(kinds.contains("SUMMARY"), "native compaction must fire");
            // The native summary text must NOT carry the application-layer cursor phrasing.
            assertTrue(anyMessageContains(requests, CLEAN_SUMMARY), "native summary present");
            assertFalse(anyMessageContains(requests, APP_LAYER_PHRASE),
                    "native compaction must never emit the application-layer history.compact cursor marker");

            // Run 2: the backend supplies its OWN application-layer summary. refreshApplicationContext
            // replaces only app-context messages; the native __compaction_summary__ must survive intact,
            // proving the two cursors are independent and neither overwrites the other.
            String appSummary = "WorkPal-" + APP_LAYER_PHRASE + " 9. " + APP_CURSOR_MARKER;
            int before = requests.size();
            engine.execute(chat(model.getAddress().getPort(), "cur-2", "user-1", "space-1", "bot-1",
                    "thread-1", "Next question.",
                    List.of(new RunRequest.HistoryMessage(null, "user", appSummary, null,
                            new RunRequest.HistoryProvenance("application", null, null,
                                    "compacted_summary", 0, null)))), e -> {});
            List<JsonNode> secondTurn = requests.subList(before, requests.size());
            assertTrue(anyMessageContains(secondTurn, APP_CURSOR_MARKER),
                    "the application-layer summary must reach the model");
            assertTrue(anyMessageContains(secondTurn, WORKING_SUMMARY_MARKER),
                    "the native working summary must coexist with the application-layer summary");
        } finally { model.stop(0); }
    }

    // ============================ fixture helpers ============================

    /** AgentScope stock defaults (flush/offload before compact = true) — the pre-fix config. */
    private static CompactionConfig legacyDefaultCompaction() {
        return CompactionConfig.builder().triggerMessages(30).keepMessages(10).build();
    }

    private static List<RunRequest.HistoryMessage> largeHistory(int count, String firstMarker,
            String lastMarker) {
        List<RunRequest.HistoryMessage> history = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            String role = (i % 2 == 0) ? "user" : "assistant";
            String marker = (i == 0) ? firstMarker : (i == count - 1) ? lastMarker : "";
            history.add(new RunRequest.HistoryMessage(null, role,
                    role + " history line " + i + " " + marker + " " + FILLER.repeat(10), null));
        }
        return history;
    }

    private static RunRequest chat(int port, String runId, String user, String space, String bot,
            String thread, String prompt, List<RunRequest.HistoryMessage> history) {
        return new RunRequest(bot, thread, runId, "chat", "message-1",
                new RunRequest.Identity(user, space, bot, thread, runId),
                prompt, "WorkPal", "Reply concisely.", history, List.of(), List.of(), List.of(), null,
                new RunRequest.RunModel("local", "fixture", "test-key",
                        "http://127.0.0.1:" + port + "/v1", false, 200, 8192, null, null),
                false, null, 0);
    }

    private static int contextSize(Path state) {
        try (var walk = Files.walk(state)) {
            Path f = walk.filter(p -> p.toString().endsWith("agent_state.json")).findFirst().orElse(null);
            if (f == null) return -1;
            JsonNode ctx = JSON.readTree(Files.readString(f)).path("context");
            return ctx.isArray() ? ctx.size() : -1;
        } catch (Exception e) { return -2; }
    }

    private static List<Path> filesUnder(Path root, java.util.function.Predicate<Path> match) {
        List<Path> out = new ArrayList<>();
        if (!Files.exists(root)) return out;
        try (var walk = Files.walk(root)) {
            walk.filter(Files::isRegularFile).filter(match).sorted().forEach(out::add);
        } catch (Exception e) { /* ignore */ }
        return out;
    }

    private static boolean anyMessageContains(List<JsonNode> requests, String needle) {
        for (JsonNode body : requests) {
            for (JsonNode message : body.path("messages")) {
                if (message.path("content").toString().contains(needle)) return true;
            }
        }
        return false;
    }

    private static Map<String, Long> tally(List<String> kinds) {
        return kinds.stream().collect(java.util.stream.Collectors.groupingBy(k -> k,
                java.util.stream.Collectors.counting()));
    }

    /**
     * A local OpenAI-compatible fixture that classifies each request by purpose so normal
     * replies, the necessary compaction summary, and the forbidden pre-compaction memory
     * flush are counted separately.
     */
    private static HttpServer classifyingModel(List<JsonNode> requests, List<String> kinds) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/v1/chat/completions", exchange -> {
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            requests.add(body);
            String all = body.path("messages").toString();
            String reply;
            if (all.contains("memory extraction assistant")) {
                kinds.add("FLUSH");
                reply = "- User prefers concise answers. " + FLUSH_MEM_MARKER;
            } else if (all.contains("Context Extraction Assistant")) {
                kinds.add("SUMMARY");
                reply = WORKING_SUMMARY_MARKER + " — earlier work referenced " + NEEDLE_COMPACTED + ".";
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
                "delta", Map.of(), "finish_reason", "stop"))) + "}\n\n"
                + "data: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "text/event-stream");
        exchange.sendResponseHeaders(200, 0);
        try (var out = exchange.getResponseBody()) { out.write(stream); out.flush(); }
    }
}
