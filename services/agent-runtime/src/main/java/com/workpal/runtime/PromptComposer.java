package com.workpal.runtime;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * The system prompt's provenance is visible here and in platform-instructions.md.
 * Composition order (Product Harness Phase 2): platform, turn policy, bot
 * instructions, runtime context. The turn policy is the Product Harness's
 * immutable per-run decision; the collaboration context arrives in Phase 3.
 */
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
                turnPolicySection(request),
                "<bot-instructions>\n" + bot + "\n</bot-instructions>",
                "<runtime-context>\nProduct: " + product + "\nExecution scope: " + request.scope()
                        + "\n</runtime-context>");
    }

    static String turnPolicySection(RunRequest request) {
        if (!request.isChat()) {
            return "<turn-policy>\nThis is an auxiliary execution: no planning, no delegation and no"
                    + " tools. Reply with exactly the requested output.\n</turn-policy>";
        }
        StringBuilder policy = new StringBuilder("<turn-policy>\n");
        if (request.supportOwnership()) {
            policy.append("You are supporting another persistent agent.\n")
                    .append("Do not independently take ownership of the user conversation.\n")
                    .append("Return a concise useful result to the requesting agent.\n");
        } else {
            policy.append("You are the response owner for this user turn.\n");
        }
        if (!request.interactive()) {
            policy.append("This turn runs without a waiting user: never stop to request approval.\n");
        }
        policy.append("Planning: ")
                .append(request.planningAllowed()
                        ? "auto — decide yourself whether this turn needs a reviewable plan before consequential changes."
                        : "disabled for this turn.")
                .append("\n");
        if (request.delegationAllowed()) {
            policy.append("Delegation: helpers are allowed; helpers use only read-only tools and cannot delegate further.\n")
                    .append("Maximum helpers: ").append(request.maxChildren()).append(".\n")
                    .append("Background helpers: ")
                    .append(request.backgroundAllowed()
                            ? "allowed only when the result is not required before the current response."
                            : "not allowed for this turn.")
                    .append("\n");
        } else {
            policy.append("Delegation: disabled for this turn — complete the work yourself.\n");
        }
        return policy.append("</turn-policy>").toString();
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
