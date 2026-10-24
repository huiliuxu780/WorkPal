package com.workpal.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import java.util.List;
import org.junit.jupiter.api.Test;

final class SessionAdmissionKeyTest {
    @Test void matchesTheBackendCanonicalChatKey() {
        RunRequest request = request(7);
        assertEquals(
                "agentscope:chat:v1:8884939074a6c8411948bc490ae0f320319ab373fd31bf9f4ed0cc0d3aa65203:"
                        + "74d37ff647a15f276eb6a4039efb92fbff2285bbfdf73dc1228b5255f9be565b",
                SessionAdmissionKey.forChat(request));
        assertNotEquals(SessionAdmissionKey.forChat(request), SessionAdmissionKey.forChat(request(8)));
    }

    private static RunRequest request(int generation) {
        RunRequest.Identity identity = new RunRequest.Identity(
                "user-1", "space-1", "bot-1", "thread-1", "run-1");
        return new RunRequest("bot-1", "thread-1", "run-1", "chat", null, identity,
                "hello", "WorkPal", "test", List.of(), List.of(), List.of(), List.of(), null,
                new RunRequest.RunModel("local", "fixture", "key", "http://127.0.0.1", false,
                        100, 1_000, null, null),
                false, null, generation);
    }
}
