package com.workpal.runtime;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/** Canonical AgentScope chat-session identity shared with the TypeScript backend. */
final class SessionAdmissionKey {
    private SessionAdmissionKey() {}

    static String forChat(RunRequest request) {
        return "agentscope:chat:v1:" + hash(request.identity().userId() + "\0"
                + request.identity().spaceId()) + ":" + hash(request.botId() + "\0"
                + request.threadId() + "\0" + request.generation());
    }

    private static String hash(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }
}
