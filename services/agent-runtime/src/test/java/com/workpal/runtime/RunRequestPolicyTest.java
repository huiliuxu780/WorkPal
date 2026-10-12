package com.workpal.runtime;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/** Product Harness Phase 2: RunRequest TurnPolicy parsing and effective capability gates. */
class RunRequestPolicyTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    private static RunRequest parsed(String extraFields) throws Exception {
        String body = """
                {"botId":"bot-1","threadId":"thread-1","runId":"run-1","executionScope":"chat",
                 "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"thread-1","runId":"run-1"},
                 "prompt":"hi","model":{"provider":"p","id":"m"}%s}
                """.formatted(extraFields.isEmpty() ? "" : "," + extraFields);
        RunRequest request = JSON.readValue(body, RunRequest.class);
        request.validate();
        return request;
    }

    @Test void chatWithoutPolicyKeepsNativeCapabilities() throws Exception {
        RunRequest request = parsed("");
        assertTrue(request.planningAllowed());
        assertTrue(request.delegationAllowed());
        assertTrue(request.backgroundAllowed());
        assertTrue(request.interactive());
        assertEquals(3, request.maxChildren());
        assertFalse(request.supportOwnership());
        assertEquals("chat", request.routingKind());
    }

    @Test void v2ConstraintsParseWithoutAnActionSelectorAndBoundNativeHelpers() throws Exception {
        RunRequest request = parsed(
                "\"turnPolicy\":{\"version\":\"v2\",\"interactive\":true,\"planning\":\"auto\","
                        + "\"delegation\":{\"mode\":\"auto\",\"background\":true,\"maxChildren\":3,\"maxDepth\":1},"
                        + "\"ownership\":{\"mode\":\"owner\",\"ownerBotId\":\"bot-1\"},\"routingKind\":\"direct\","
                        + "\"budget\":{\"maxTokens\":200000,\"maxCostUsd\":1.0,\"maxDurationSec\":900,"
                        + "\"maxToolCalls\":50,\"maxChildAgents\":1,\"maxDepth\":1},"
                        + "\"approval\":{\"timeoutSec\":86400,\"onTimeout\":\"expire\"},"
                        + "\"retry\":{\"maxAuto\":2,\"retryable\":[\"llm_timeout\",\"network_error\"]},"
                        + "\"subagent\":{\"permissionInheritance\":\"subset-readonly\"}}"
        );
        assertEquals("v2", request.turnPolicy().version());
        assertEquals(1, request.maxChildren());
        assertEquals(50, request.turnPolicy().budget().maxToolCalls());
        assertEquals("subset-readonly", request.turnPolicy().subagent().permissionInheritance());
    }

    @Test void v1PolicyRemainsReadableWithoutV2Constraints() throws Exception {
        RunRequest request = parsed(
                "\"turnPolicy\":{\"version\":\"v1\",\"interactive\":true,\"planning\":\"auto\","
                        + "\"delegation\":{\"mode\":\"auto\",\"background\":true,\"maxChildren\":2,\"maxDepth\":1}}"
        );
        assertEquals(2, request.maxChildren());
        assertNull(request.turnPolicy().budget());
    }

    @Test void planningDisabledHidesPlanCapability() throws Exception {
        RunRequest request = parsed(
                "\"turnPolicy\":{\"interactive\":false,\"planning\":\"disabled\","
                        + "\"delegation\":{\"mode\":\"auto\",\"background\":true,\"maxChildren\":3,\"maxDepth\":1},"
                        + "\"ownership\":{\"mode\":\"owner\",\"ownerBotId\":\"bot-1\"},\"routingKind\":\"automation\"}");
        assertFalse(request.planningAllowed());
        assertTrue(request.delegationAllowed());
        assertTrue(request.backgroundAllowed());
        assertFalse(request.interactive());
        assertEquals("automation", request.routingKind());
    }

    @Test void delegationDisabledForbidsBackgroundAndKeepsChatPlan() throws Exception {
        RunRequest request = parsed(
                "\"turnPolicy\":{\"interactive\":false,\"planning\":\"auto\","
                        + "\"delegation\":{\"mode\":\"disabled\",\"background\":false,\"maxChildren\":3,\"maxDepth\":1},"
                        + "\"ownership\":{\"mode\":\"support\",\"ownerBotId\":\"bot-1\"},\"routingKind\":\"bot_message\"}");
        assertFalse(request.delegationAllowed());
        assertFalse(request.backgroundAllowed());
        assertTrue(request.planningAllowed());
        assertTrue(request.supportOwnership());
    }

    @Test void botMessageStylePolicyAppliesSupportIdentityAndBudgets() throws Exception {
        RunRequest request = parsed(
                "\"turnPolicy\":{\"interactive\":false,\"planning\":\"disabled\","
                        + "\"delegation\":{\"mode\":\"auto\",\"background\":false,\"maxChildren\":2,\"maxDepth\":1},"
                        + "\"ownership\":{\"mode\":\"support\",\"ownerBotId\":\"bot-1\"},\"routingKind\":\"bot_message\"}");
        assertFalse(request.planningAllowed());
        assertTrue(request.delegationAllowed());
        assertFalse(request.backgroundAllowed());
        assertEquals(2, request.maxChildren());
        assertTrue(request.supportOwnership());
        assertEquals("bot_message", request.routingKind());
    }

    @Test void auxiliaryScopeForcesPlanAndDelegationOffEvenWithAutoPolicy() throws Exception {
        String body = """
                {"botId":"bot-1","threadId":"turn-routing:1","runId":"turn-routing:1","executionScope":"turn-routing",
                 "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"turn-routing:1","runId":"turn-routing:1"},
                 "prompt":"route","model":{"provider":"p","id":"m"},
                 "turnPolicy":{"interactive":true,"planning":"auto",
                   "delegation":{"mode":"auto","background":true,"maxChildren":3,"maxDepth":1},
                   "ownership":{"mode":"owner","ownerBotId":"bot-1"},"routingKind":"turn-routing"}}
                """;
        RunRequest request = JSON.readValue(body, RunRequest.class);
        request.validate();
        assertFalse(request.planningAllowed(), "the Group Router must never expose plan tools");
        assertFalse(request.delegationAllowed(), "the Group Router must never expose subagent tools");
        assertFalse(request.backgroundAllowed());
    }

    @Test void historyCompactionScopeIsCapabilityFree() throws Exception {
        String body = """
                {"botId":"bot-1","threadId":"thread-1","runId":"run-c","executionScope":"history-compaction",
                 "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"thread-1","runId":"run-c"},
                 "prompt":"compact","model":{"provider":"p","id":"m"}}
                """;
        RunRequest request = JSON.readValue(body, RunRequest.class);
        assertFalse(request.planningAllowed());
        assertFalse(request.delegationAllowed());
    }

    @Test void explicitZeroBudgetIsPreservedAndNegativesFallBack() throws Exception {
        RunRequest zero = parsed(
                "\"turnPolicy\":{\"interactive\":true,\"planning\":\"auto\","
                        + "\"delegation\":{\"mode\":\"auto\",\"background\":true,\"maxChildren\":0,\"maxDepth\":1},"
                        + "\"ownership\":{\"mode\":\"owner\",\"ownerBotId\":\"bot-1\"},\"routingKind\":\"direct\"}");
        assertEquals(0, zero.maxChildren(), "zero means no helpers and must not become three");
        RunRequest negative = parsed(
                "\"turnPolicy\":{\"interactive\":true,\"planning\":\"auto\","
                        + "\"delegation\":{\"mode\":\"auto\",\"background\":true,\"maxChildren\":-2,\"maxDepth\":1},"
                        + "\"ownership\":{\"mode\":\"owner\",\"ownerBotId\":\"bot-1\"},\"routingKind\":\"direct\"}");
        assertEquals(3, negative.maxChildren());
    }
}
