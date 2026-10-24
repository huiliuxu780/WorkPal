import { describe, expect, it } from "vitest";
import { agentScopeChatSessionKey } from "./session-admission.js";

describe("agentScopeChatSessionKey", () => {
  it("matches the documented RuntimeEngine tenant and chat slots", () => {
    expect(
      agentScopeChatSessionKey({
        userId: "user-1",
        spaceId: "space-1",
        botId: "bot-1",
        threadId: "thread-1",
        threadGeneration: 7,
      }),
    ).toBe(
      "agentscope:chat:v1:8884939074a6c8411948bc490ae0f320319ab373fd31bf9f4ed0cc0d3aa65203:74d37ff647a15f276eb6a4039efb92fbff2285bbfdf73dc1228b5255f9be565b",
    );
  });

  it("rejects an invalid generation", () => {
    expect(() =>
      agentScopeChatSessionKey({
        userId: "user-1",
        spaceId: "space-1",
        botId: "bot-1",
        threadId: "thread-1",
        threadGeneration: -1,
      }),
    ).toThrow("non-negative safe integer");
  });
});
