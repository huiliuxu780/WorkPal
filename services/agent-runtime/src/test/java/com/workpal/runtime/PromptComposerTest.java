package com.workpal.runtime;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/** Product Harness Phase 2: prompt composition order and the turn-policy block. */
class PromptComposerTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    private static RunRequest parsed(String extraFields) throws Exception {
        String body = """
                {"botId":"bot-1","threadId":"thread-1","runId":"run-1","executionScope":"chat",
                 "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"thread-1","runId":"run-1"},
                 "prompt":"hi","productName":"Alice","instructions":"Be terse.","model":{"provider":"p","id":"m"}%s}
                """.formatted(extraFields.isEmpty() ? "" : "," + extraFields);
        return JSON.readValue(body, RunRequest.class);
    }

    @Test void turnPolicySitsBetweenPlatformAndBotInstructions() throws Exception {
        String prompt = PromptComposer.compose(parsed(""));
        int platform = prompt.indexOf("<platform>");
        int policy = prompt.indexOf("<turn-policy>");
        int bot = prompt.indexOf("<bot-instructions>");
        int runtime = prompt.indexOf("<runtime-context>");
        assertTrue(0 <= platform && platform < policy, "turn policy must follow platform");
        assertTrue(policy < bot, "turn policy must precede bot instructions");
        assertTrue(bot < runtime);
    }

    @Test void ownerChatPolicyRendersFullCapability() throws Exception {
        String prompt = PromptComposer.compose(parsed(""));
        assertTrue(prompt.contains("You are the response owner for this user turn."));
        assertTrue(prompt.contains("Planning: auto"));
        assertTrue(prompt.contains("Delegation: helpers are allowed"));
        assertTrue(prompt.contains("Maximum helpers: 3"));
        assertTrue(prompt.contains("Background helpers: allowed"));
        assertTrue(prompt.contains("cannot delegate further"));
    }

    @Test void supportIdentityAndDisabledCapabilitiesAreInjected() throws Exception {
        RunRequest request = parsed(
                "\"turnPolicy\":{\"interactive\":false,\"planning\":\"disabled\","
                        + "\"delegation\":{\"mode\":\"auto\",\"background\":false,\"maxChildren\":3,\"maxDepth\":1},"
                        + "\"ownership\":{\"mode\":\"support\",\"ownerBotId\":\"bot-1\"},\"routingKind\":\"bot_message\"}");
        String block = PromptComposer.turnPolicySection(request);
        assertTrue(block.contains("You are supporting another persistent agent."));
        assertTrue(block.contains("Do not independently take ownership of the user conversation."));
        assertTrue(block.contains("Planning: disabled for this turn."));
        assertTrue(block.contains("never stop to request approval"));
        assertTrue(block.contains("Background helpers: not allowed for this turn."));
    }

    @Test void automationWithoutWaitingUserIsDeclared() throws Exception {
        RunRequest request = parsed(
                "\"turnPolicy\":{\"interactive\":false,\"planning\":\"disabled\","
                        + "\"delegation\":{\"mode\":\"auto\",\"background\":true,\"maxChildren\":3,\"maxDepth\":1},"
                        + "\"ownership\":{\"mode\":\"owner\",\"ownerBotId\":\"bot-1\"},\"routingKind\":\"automation\"}");
        String block = PromptComposer.turnPolicySection(request);
        assertTrue(block.contains("You are the response owner for this user turn."));
        assertTrue(block.contains("never stop to request approval"));
        assertTrue(block.contains("Planning: disabled for this turn."));
    }

    @Test void delegationDisabledTellsTheAgentToWorkAlone() throws Exception {
        RunRequest request = parsed(
                "\"turnPolicy\":{\"interactive\":true,\"planning\":\"auto\","
                        + "\"delegation\":{\"mode\":\"disabled\",\"background\":false,\"maxChildren\":3,\"maxDepth\":1},"
                        + "\"ownership\":{\"mode\":\"owner\",\"ownerBotId\":\"bot-1\"},\"routingKind\":\"direct\"}");
        String block = PromptComposer.turnPolicySection(request);
        assertTrue(block.contains("Delegation: disabled for this turn — complete the work yourself."));
    }

    @Test void auxiliaryScopesGetAnExecutionOnlyBlock() throws Exception {
        String body = """
                {"botId":"bot-1","threadId":"turn-routing:1","runId":"turn-routing:1","executionScope":"turn-routing",
                 "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"turn-routing:1","runId":"turn-routing:1"},
                 "prompt":"route","model":{"provider":"p","id":"m"}}
                """;
        RunRequest request = JSON.readValue(body, RunRequest.class);
        String block = PromptComposer.turnPolicySection(request);
        assertTrue(block.contains("auxiliary execution"));
        assertFalse(block.contains("response owner"));
    }

    @Test void collaborationContextRendersOwnerSupportAndHandoffIdentities() throws Exception {
        String owner = PromptComposer.collaborationContextSection(parsed(""));
        assertTrue(owner.contains("<collaboration-context>"));
        assertTrue(owner.contains("You are the response owner for this stage."));

        String support = PromptComposer.collaborationContextSection(parsed(
                "\"collaborationContext\":{\"role\":\"support\",\"fromBotName\":\"Alice\"}"));
        assertTrue(support.contains("You are supporting Alice for this stage."));
        assertTrue(support.contains("Return useful work to Alice."));
        assertTrue(support.contains("Do not take over the user-facing conversation."));

        String handoff = PromptComposer.collaborationContextSection(parsed(
                "\"collaborationContext\":{\"role\":\"handoff_owner\",\"fromBotName\":\"Alice\"}"));
        assertTrue(handoff.contains("Alice transferred ownership of this stage to you."));
        assertTrue(handoff.contains("reply directly in the shared thread"));
        assertTrue(handoff.contains("Do not hand it back merely to report completion."));
    }

    @Test void collaborationContextSitsBetweenBotInstructionsAndRuntimeContext() throws Exception {
        String prompt = PromptComposer.compose(parsed(
                "\"collaborationContext\":{\"role\":\"support\",\"fromBotName\":\"Alice\"}"));
        int bot = prompt.indexOf("<bot-instructions>");
        int collaboration = prompt.indexOf("<collaboration-context>");
        int runtime = prompt.indexOf("<runtime-context>");
        assertTrue(0 <= bot && bot < collaboration, "collaboration context must follow bot instructions");
        assertTrue(collaboration < runtime, "collaboration context must precede runtime context");
    }

    @Test void auxiliaryScopesGetNoCollaborationIdentity() throws Exception {
        String body = \"\"\"
                {"botId":"bot-1","threadId":"turn-routing:1","runId":"turn-routing:1","executionScope":"turn-routing",
                 "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"turn-routing:1","runId":"turn-routing:1"},
                 "prompt":"route","model":{"provider":"p","id":"m"}}
                \"\"\";
        RunRequest request = JSON.readValue(body, RunRequest.class);
        assertEquals("", PromptComposer.collaborationContextSection(request));
    }

    @Test void platformInstructionsCarryTheShortExecutionStrategy() throws Exception {
        String prompt = PromptComposer.compose(parsed(""));
        assertTrue(prompt.contains("Use the simplest execution strategy"));
        assertTrue(prompt.contains("Do not create a plan for simple questions"));
        assertTrue(prompt.contains("Helpers perform delegated work"));
        assertTrue(prompt.contains("Use a helper/subagent when you only need temporary execution capacity."));
        assertTrue(prompt.contains("Use message_bot when another persistent bot"));
        assertTrue(prompt.contains("Use handoff_to_bot only when that persistent bot should own the next stage."));
    }
}
