package com.workpal.runtime;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The system prompt's provenance is visible here and in the prompts/ segment
 * tree (AG-04): every fixed body is loaded from the classpath resources Maven
 * packages from the repository-root prompts/ directory — this class keeps the
 * typed conditional assembly only.
 * Composition order (Product Harness Phase 2 + AG-06): platform, fixed content
 * trust rules, turn policy, bot instructions, collaboration context (chat
 * only), runtime context. The turn policy is the Product Harness's immutable
 * per-run decision; the collaboration context arrives in Phase 3.
 */
public final class PromptComposer {
    /** Fixed text: prompts/platform/platform.md (P01). */
    private static final String PLATFORM = PromptTexts.load("platform/platform");

    /**
     * AG-06: the fixed untrusted-content rules, byte-identical for every run
     * shape (owner, support, handoff, auxiliary, with or without summaries and
     * recalled memory). The wording is the reviewed text from
     * docs/tasks/AG-06.md, relocated verbatim into
     * prompts/platform/content-trust-rules.md by AG-04; never interpolate
     * request data, bot instructions or message content into it, and never
     * move or reword it without an explicit decision. This segment is defense
     * in depth: it does not replace backend permission checks, recorded
     * approvals or the tool allow-list, and deterministic delivery tests prove
     * construction and delivery only — never real-model injection resistance.
     */
    static final String CONTENT_TRUST_RULES =
            "<content-trust-rules>\n"
                    + PromptTexts.load("platform/content-trust-rules")
                    + "\n</content-trust-rules>";

    private PromptComposer() {}

    public static String compose(RunRequest request) {
        String product = RunRequest.blank(request.productName()) ? "WorkPal" : request.productName();
        String bot = RunRequest.blank(request.instructions())
                ? "You are a concise, capable assistant."
                : request.instructions();
        List<String> sections = new ArrayList<>(List.of(
                "<platform>\n" + PLATFORM + "\n</platform>",
                CONTENT_TRUST_RULES,
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
     * executions get no collaboration identity. Fixed bodies:
     * prompts/collaboration/*.md (P02); {{from}} is filled single-pass.
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
                    ? PromptTexts.load("collaboration/support-resumption")
                    : PromptTexts.render("collaboration/support", Map.of("from", from));
            case "handoff_owner" -> PromptTexts.render("collaboration/handoff-owner", Map.of("from", from))
                    + (resumption
                        ? "\n" + PromptTexts.load("collaboration/handoff-owner-resumption-append")
                        : "");
            default -> resumption
                    ? PromptTexts.load("collaboration/owner-resumption")
                    : PromptTexts.load("collaboration/owner");
        };
        return "<collaboration-context>\n" + body + "\n</collaboration-context>";
    }

    /** Fixed bodies: prompts/policy/turn-policy-*.md (P02). */
    static String turnPolicySection(RunRequest request) {
        if (!request.isChat()) {
            return "<turn-policy>\n" + PromptTexts.load("policy/turn-policy-auxiliary") + "\n</turn-policy>";
        }
        StringBuilder policy = new StringBuilder("<turn-policy>\n");
        if (request.supportOwnership()) {
            policy.append(PromptTexts.load("policy/turn-policy-support-opening")).append("\n");
        } else {
            policy.append(PromptTexts.load("policy/turn-policy-owner-opening")).append("\n");
        }
        if (!request.interactive()) {
            policy.append(PromptTexts.load("policy/turn-policy-noninteractive")).append("\n");
        }
        policy.append(request.planningAllowed()
                        ? PromptTexts.load("policy/turn-policy-planning-auto")
                        : PromptTexts.load("policy/turn-policy-planning-disabled"))
                .append("\n");
        if (request.delegationAllowed()) {
            // AG-02 suspended native helper delegation at the production entrypoint
            // (no agent_spawn/agent_send/agent_list/task_* tools are ever offered),
            // so the prompt must not advertise a capability the run's tool set does
            // not contain. Bot-level collaboration tools are backend tools and are
            // unaffected. If delegation is re-enabled (a code change gated in
            // RuntimeEngine.delegationSuspended), restore policy-accurate text in
            // prompts/policy/turn-policy-delegation-suspended.md.
            policy.append(PromptTexts.load("policy/turn-policy-delegation-suspended")).append("\n");
        } else {
            policy.append(PromptTexts.load("policy/turn-policy-delegation-disabled")).append("\n");
        }
        return policy.append("</turn-policy>").toString();
    }
}
