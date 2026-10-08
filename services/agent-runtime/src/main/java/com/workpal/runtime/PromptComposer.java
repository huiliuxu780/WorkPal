package com.workpal.runtime;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** The system prompt's provenance is visible here and in platform-instructions.md. */
public final class PromptComposer {
    private static final String PLATFORM = loadPlatform();

    private PromptComposer() {}

    public static String compose(RunRequest request) {
        String product = RunRequest.blank(request.productName()) ? "WorkPal" : request.productName();
        String bot = RunRequest.blank(request.instructions())
                ? "You are a concise, capable assistant."
                : request.instructions();
        return String.join("\n\n",
                "<platform>\n" + PLATFORM + "\n</platform>",
                "<bot-instructions>\n" + bot + "\n</bot-instructions>",
                "<runtime-context>\nProduct: " + product + "\nExecution scope: " + request.scope()
                        + "\n</runtime-context>");
    }

    private static String loadPlatform() {
        try (var stream = PromptComposer.class.getResourceAsStream("/platform-instructions.md")) {
            if (stream == null) throw new IllegalStateException("platform-instructions.md is missing");
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8).trim();
        } catch (IOException e) {
            throw new IllegalStateException("Cannot read platform instructions", e);
        }
    }
}
