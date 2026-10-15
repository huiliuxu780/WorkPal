package com.workpal.runtime;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
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

    /** AG-01: the team-chat engagement judge has its own auxiliary scope. */
    @Test void teamChatJudgeScopeIsAcceptedAndCapabilityFree() throws Exception {
        String body = """
                {"botId":"bot-1","threadId":"team-chat-judge:1","runId":"team-chat-judge:1","executionScope":"team-chat-judge",
                 "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"team-chat-judge:1","runId":"team-chat-judge:1"},
                 "prompt":"judge","model":{"provider":"p","id":"m"}}
                """;
        RunRequest request = JSON.readValue(body, RunRequest.class);
        request.validate();
        assertFalse(request.isChat());
        assertFalse(request.planningAllowed(), "the engagement judge must never expose plan tools");
        assertFalse(request.delegationAllowed(), "the engagement judge must never expose subagent tools");
        assertFalse(request.backgroundAllowed());
    }

    @Test void unknownExecutionScopeIsRejected() throws Exception {
        String body = """
                {"botId":"bot-1","threadId":"t","runId":"r","executionScope":"team-chat-judgex",
                 "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"t","runId":"r"},
                 "prompt":"judge","model":{"provider":"p","id":"m"}}
                """;
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> JSON.readValue(body, RunRequest.class).validate());
        assertEquals("Unsupported execution scope", failure.getMessage());
    }

    /**
     * AG-01 chosen behavior: an auxiliary request that mistakenly carries
     * backend tools or skills is refused at the trusted boundary — never
     * silently stripped and never forwarded to the model.
     */
    @Test void auxiliaryScopesRefuseBackendToolsAndSkills() throws Exception {
        for (String scope : List.of("auto-review", "history-compaction", "turn-routing", "team-chat-judge")) {
            String withTools = """
                    {"botId":"bot-1","threadId":"t","runId":"r","executionScope":"%s",
                     "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"t","runId":"r"},
                     "prompt":"aux","model":{"provider":"p","id":"m"},
                     "tools":[{"name":"shell","description":"mistaken","inputSchema":{"type":"object"},"readOnly":true}]}
                    """.formatted(scope);
            IllegalArgumentException toolsFailure = assertThrows(IllegalArgumentException.class,
                    () -> JSON.readValue(withTools, RunRequest.class).validate(), scope);
            assertEquals("Auxiliary execution scope must not carry backend tools or skills",
                    toolsFailure.getMessage(), scope);

            // The refusal is scope-based: an otherwise fully valid trusted
            // bridge does not make backend tools acceptable on an auxiliary run.
            String withToolsAndBridge = """
                    {"botId":"bot-1","threadId":"t","runId":"r","executionScope":"%s",
                     "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"t","runId":"r"},
                     "prompt":"aux","model":{"provider":"p","id":"m"},
                     "tools":[{"name":"shell","description":"mistaken","inputSchema":{"type":"object"},"readOnly":true}],
                     "toolBridge":{"url":"http://127.0.0.1:9/v1/tool-executions","token":"bridge-secret",
                       "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"t","runId":"r"}}}
                    """.formatted(scope);
            IllegalArgumentException bridgeFailure = assertThrows(IllegalArgumentException.class,
                    () -> JSON.readValue(withToolsAndBridge, RunRequest.class).validate(), scope);
            assertEquals("Auxiliary execution scope must not carry backend tools or skills",
                    bridgeFailure.getMessage(), scope);

            String withSkills = """
                    {"botId":"bot-1","threadId":"t","runId":"r","executionScope":"%s",
                     "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"t","runId":"r"},
                     "prompt":"aux","model":{"provider":"p","id":"m"},
                     "skills":[{"id":"skill-1","name":"project-rules","description":"mistaken","content":"SECRET"}]}
                    """.formatted(scope);
            IllegalArgumentException skillsFailure = assertThrows(IllegalArgumentException.class,
                    () -> JSON.readValue(withSkills, RunRequest.class).validate(), scope);
            assertEquals("Auxiliary execution scope must not carry backend tools or skills",
                    skillsFailure.getMessage(), scope);
        }
    }

    @Test void chatScopeStillAcceptsAuthorizedToolsAndSkills() throws Exception {
        String body = """
                {"botId":"bot-1","threadId":"t","runId":"r","executionScope":"chat",
                 "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"t","runId":"r"},
                 "prompt":"chat","model":{"provider":"p","id":"m"},
                 "skills":[{"id":"skill-1","name":"project-rules","description":"rules","content":"C"}],
                 "tools":[{"name":"shell","description":"authorized","inputSchema":{"type":"object"},"readOnly":true}],
                 "toolBridge":{"url":"http://127.0.0.1:9/v1/tool-executions","token":"bridge-secret",
                   "identity":{"userId":"user-1","spaceId":"space-1","botId":"bot-1","threadId":"t","runId":"r"}}}
                """;
        RunRequest request = JSON.readValue(body, RunRequest.class);
        request.validate();
        assertTrue(request.isChat());
        assertTrue(request.planningAllowed());
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

    private static String v2WithDepth(int delegationDepth, int budgetDepth) {
        return "\"turnPolicy\":{\"version\":\"v2\",\"interactive\":true,\"planning\":\"auto\","
                + "\"delegation\":{\"mode\":\"auto\",\"background\":true,\"maxChildren\":3,\"maxDepth\":"
                + delegationDepth + "},"
                + "\"ownership\":{\"mode\":\"owner\",\"ownerBotId\":\"bot-1\"},\"routingKind\":\"direct\","
                + "\"budget\":{\"maxTokens\":200000,\"maxCostUsd\":1.0,\"maxDurationSec\":900,"
                + "\"maxToolCalls\":50,\"maxChildAgents\":3,\"maxDepth\":" + budgetDepth + "},"
                + "\"approval\":{\"timeoutSec\":86400,\"onTimeout\":\"expire\"},"
                + "\"retry\":{\"maxAuto\":2,\"retryable\":[\"llm_timeout\",\"network_error\"]},"
                + "\"subagent\":{\"permissionInheritance\":\"subset-readonly\"}}";
    }

    @Test void effectiveDepthIsTheTightenedMinimumOfDelegationAndBudget() throws Exception {
        RunRequest request = parsed(v2WithDepth(3, 1));
        assertEquals(1, request.maxDepth(), "budget depth tightens a looser delegation depth");
        assertTrue(request.delegationAllowed());
        assertTrue(request.backgroundAllowed());
        RunRequest tighter = parsed(v2WithDepth(2, 5));
        assertEquals(2, tighter.maxDepth(), "delegation depth tightens a looser budget depth");
        assertTrue(tighter.delegationAllowed());
    }

    @Test void zeroEffectiveDepthDisablesTheWholeSubagentSurface() throws Exception {
        // A legal policy: delegation mode auto with a tightened zero depth.
        RunRequest request = parsed(v2WithDepth(3, 0));
        assertEquals(0, request.maxDepth());
        assertFalse(request.delegationAllowed(), "depth zero must hide every native spawn tool");
        assertFalse(request.backgroundAllowed(), "depth zero must refuse background registration");
        RunRequest explicit = parsed(
                "\"turnPolicy\":{\"version\":\"v1\",\"interactive\":true,\"planning\":\"auto\","
                        + "\"delegation\":{\"mode\":\"auto\",\"background\":true,\"maxChildren\":3,\"maxDepth\":0},"
                        + "\"ownership\":{\"mode\":\"owner\",\"ownerBotId\":\"bot-1\"},\"routingKind\":\"direct\"}");
        assertEquals(0, explicit.maxDepth(), "an explicit v1 zero is preserved, not defaulted");
        assertFalse(explicit.delegationAllowed());
    }

    @Test void absentDepthFallsBackToOneAndKeepsDelegation() throws Exception {
        RunRequest request = parsed(
                "\"turnPolicy\":{\"version\":\"v2\",\"interactive\":true,\"planning\":\"auto\","
                        + "\"delegation\":{\"mode\":\"auto\",\"background\":true,\"maxChildren\":3},"
                        + "\"ownership\":{\"mode\":\"owner\",\"ownerBotId\":\"bot-1\"},\"routingKind\":\"direct\","
                        + "\"budget\":{\"maxTokens\":200000,\"maxCostUsd\":1.0,\"maxDurationSec\":900,"
                        + "\"maxToolCalls\":50,\"maxChildAgents\":3,\"maxDepth\":1},"
                        + "\"approval\":{\"timeoutSec\":86400,\"onTimeout\":\"expire\"},"
                        + "\"retry\":{\"maxAuto\":2,\"retryable\":[\"llm_timeout\",\"network_error\"]},"
                        + "\"subagent\":{\"permissionInheritance\":\"subset-readonly\"}}");
        assertEquals(1, request.maxDepth());
        assertTrue(request.delegationAllowed());
        RunRequest noPolicy = parsed("");
        assertEquals(1, noPolicy.maxDepth());
        assertTrue(noPolicy.delegationAllowed());
    }
}
