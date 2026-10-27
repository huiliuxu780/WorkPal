package com.workpal.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * FIX-PERSONA-01: the runtime must not read the developer rules of whatever
 * directory the JVM happened to start in.
 *
 * <p>agentscope-harness 2.0.3 falls back to {@code System.getProperty("user.dir")} when the agent
 * is built without an explicit project, and its {@code WorkspaceContextMiddleware} reads
 * {@code AGENTS.md} through the overlay filesystem: when the session workspace has no such file it
 * falls back to that project directory. {@code pnpm dev:app} and {@code pnpm dev:agentscope} both
 * start the JVM at the repository root, so every bot was shipped the repository's own developer
 * rules as its persona, and the same prompt told the model that the repository is "the user's
 * source tree".
 *
 * <p>Both facts are asserted here: the launch directory's {@code AGENTS.md} and its path must never
 * reach the model, while the bot persona composed by {@link PromptComposer} from the backend request
 * must still arrive. A fix that simply blanks the system prompt would pass the first assertion and
 * fail the second.
 */
class RuntimeProjectIsolationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String CANARY = "PERSONA_LEAK_CANARY_7f3a";

    @TempDir Path temp;

    @Test
    void startupDirectoryAgentsMdNeverReachesTheModel() throws Exception {
        Path launchDir = temp.resolve("launch-dir");
        Files.createDirectories(launchDir);
        Files.writeString(
                launchDir.resolve("AGENTS.md"),
                "# AGENTS.md\n\n" + CANARY + "\n\n- 先检查问题有没有错误前提、逻辑跳跃和信息缺失。\n",
                StandardCharsets.UTF_8);

        String originalUserDir = System.getProperty("user.dir");
        List<JsonNode> modelRequests = new CopyOnWriteArrayList<>();
        HttpServer model = recordingModel(modelRequests);
        try {
            // Stand in for `pnpm dev:app`, which starts the JVM at the repository root.
            System.setProperty("user.dir", launchDir.toString());

            RuntimeEngine engine =
                    new RuntimeEngine(JSON, temp.resolve("state"), temp.resolve("workspace"));
            List<Map<String, Object>> events = new ArrayList<>();
            engine.execute(
                    request(model.getAddress().getPort(), "run-persona-1"), events::add);

            assertEquals("done", events.getLast().get("type"), "the run must complete");
            assertFalse(modelRequests.isEmpty(), "the fixture model was never called");

            String sent = modelRequests.toString();
            assertFalse(
                    sent.contains(CANARY),
                    "the launch directory's AGENTS.md reached the model: " + excerpt(sent, CANARY));
            assertFalse(
                    sent.contains(launchDir.toString()),
                    "the launch directory path reached the model: "
                            + excerpt(sent, launchDir.toString()));
            assertFalse(
                    sent.contains("agents_context"),
                    "the harness workspace-context block was still injected: "
                            + excerpt(sent, "agents_context"));
            // The bot's own persona comes from the backend request, not from any directory.
            assertTrue(
                    sent.contains("Reply concisely."),
                    "the composed bot persona was dropped along with the leak");
        } finally {
            System.setProperty("user.dir", originalUserDir);
            model.stop(0);
        }
    }

    private static String excerpt(String haystack, String needle) {
        int at = haystack.indexOf(needle);
        if (at < 0) return "(not found)";
        int from = Math.max(0, at - 120);
        return haystack.substring(from, Math.min(haystack.length(), at + needle.length() + 120));
    }

    private static RunRequest request(int port, String runId) {
        return new RunRequest(
                "bot-1",
                "thread-1",
                runId,
                "chat",
                "message-1",
                new RunRequest.Identity("user-1", "space-1", "bot-1", "thread-1", runId),
                "Say hello.",
                "WorkPal",
                "Reply concisely.",
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                null,
                new RunRequest.RunModel(
                        "local",
                        "fixture",
                        "test-key",
                        "http://127.0.0.1:" + port + "/v1",
                        false,
                        200,
                        8192,
                        null,
                        null),
                false,
                null,
                0);
    }

    /** Records every request body and always answers with one plain text chunk. */
    private static HttpServer recordingModel(List<JsonNode> requests) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext(
                "/v1/chat/completions",
                exchange -> {
                    requests.add(JSON.readTree(exchange.getRequestBody()));
                    exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
                    exchange.sendResponseHeaders(200, 0);
                    try (OutputStream out = exchange.getResponseBody()) {
                        out.write(
                                ("data: {\"id\":\"chatcmpl-persona\",\"object\":\"chat.completion.chunk\","
                                                + "\"created\":0,\"model\":\"fixture\",\"choices\":[{\"index\":0,"
                                                + "\"delta\":{\"role\":\"assistant\",\"content\":\"Hello from Java Harness.\"},"
                                                + "\"finish_reason\":null}]}\n\n")
                                        .getBytes(StandardCharsets.UTF_8));
                        out.flush();
                        out.write(
                                ("data: {\"id\":\"chatcmpl-persona\",\"object\":\"chat.completion.chunk\","
                                                + "\"created\":0,\"model\":\"fixture\",\"choices\":[{\"index\":0,"
                                                + "\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
                                        .getBytes(StandardCharsets.UTF_8));
                        out.write("data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
                        out.flush();
                    }
                });
        server.start();
        return server;
    }
}
