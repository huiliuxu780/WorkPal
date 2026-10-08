package com.workpal.runtime;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

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
        List<String> sections = new ArrayList<>(List.of(
                "<platform>\n" + PLATFORM + "\n</platform>",
                turnPolicySection(request),
                "<bot-instructions>\n" + bot + "\n</bot-instructions>"));
        String collaboration = collaborationContextSection(request);
        if (!collaboration.isEmpty()) sections.add(collaboration);
        sections.add("<runtime-context>\nProduct: " + product + "\nExecution scope: " + request.scope()
                + "\n</runtime-context>");
        return String.join("\n\n", sections);
    }

    /**
     * Phase 3 collaboration identity (§21). The backend derives the role from
     * the immutable lineage snapshot; this section only renders it. Auxiliary
     * executions get no collaboration identity.
     */
    static String collaborationContextSection(RunRequest request) {
        if (!request.isChat()) return "";
        RunRequest.Collaboration collaboration = request.collaborationContext();
        String from = collaboration != null && !RunRequest.blank(collaboration.fromBotName())
                ? collaboration.fromBotName()
                : "the requesting agent";
        // A delegated outcome returning to its requester resumes that bot's
        // existing role; it must not read as "now supporting the responder".
        boolean resumption = collaboration != null && Boolean.TRUE.equals(collaboration.receivingOutcome());
        String body = switch (request.collaborationRole()) {
            case "support" -> resumption
                    ? "You are still supporting the original owner.\n"
                        + "Incorporate this result into your delegated work and return your completed result upstream."
                    : "You are supporting " + from + " for this stage.\n"
                        + "Return useful work to " + from + ".\n"
                        + "Do not take over the user-facing conversation.";
            case "handoff_owner" -> from + " transferred ownership of this stage to you.\n"
                    + "You now own this stage and should reply directly in the shared thread.\n"
                    + "Do not hand it back merely to report completion."
                    + (resumption
                        ? "\nAnother persistent bot has returned work you delegated; incorporate the actual result."
                        : "");
            default -> resumption
                    ? "Another persistent bot has returned work you delegated.\n"
                        + "You remain the response owner.\n"
                        + "Incorporate the actual result and continue the user's task or answer the user."
                    : "You are the response owner for this stage.\n"
                        + "You are responsible for the final user-facing outcome.";
        };
        return "<collaboration-context>\n" + body + "\n</collaboration-context>";
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
