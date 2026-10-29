import { resolveRoundtableFeatureGates } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { messageGroup } from "./message-group.js";

const deps = (enabled: boolean) =>
  ({
    prisma: {},
    events: { notify: vi.fn() },
    jobs: { enqueue: vi.fn(), cancel: vi.fn() },
    roundtableFeatures: resolveRoundtableFeatureGates({
      ...(enabled ? { ROUNDTABLE_MESSAGE_GROUP_ENABLED: "true" } : {}),
    }),
  }) as unknown as Parameters<typeof messageGroup>[0];

const run = {
  id: "run-1",
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  userId: "user-1",
};

describe("message_group contract", () => {
  it("exposes a narrow request-only schema without targetTaskId", () => {
    const tool = builtinAgentTools.find((candidate) => candidate.name === "message_group");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        group_id: { type: "string" },
        confirm_name: { type: "string" },
        message: { type: "string" },
        intent: { type: "string", enum: ["request"] },
        topic: { type: "string" },
      },
      required: ["message"],
      additionalProperties: false,
    });
    expect(tool?.inputSchema.properties).not.toHaveProperty("targetTaskId");
    expect(tool?.inputSchema.properties).not.toHaveProperty("target_task_id");
  });

  it("stays closed by default and throws the stable feature error", async () => {
    expect(resolveRoundtableFeatureGates({}).message_group).toBe(false);
    await expect(
      messageGroup(
        deps(false),
        run,
        { id: "bot-1", name: "Joy" },
        { group_id: "group-1", message: "Do the work", intent: "request" },
        { deliveryKey: "key-1" },
      ),
    ).rejects.toMatchObject({
      code: "ROUNDTABLE_FEATURE_DISABLED",
      feature: "message_group",
      retryable: false,
    });
    expect(resolveRoundtableFeatureGates({ ROUNDTABLE_MESSAGE_GROUP_ENABLED: "true" }).message_group).toBe(
      true,
    );
  });

  it("rejects a non-request intent and an empty message before touching the database", async () => {
    await expect(
      messageGroup(
        deps(true),
        run,
        { id: "bot-1", name: "Joy" },
        { group_id: "group-1", message: "Do the work", intent: "result" },
        { deliveryKey: "key-2" },
      ),
    ).resolves.toEqual({
      ok: false,
      error: "message_group only supports intent=request",
    });
    await expect(
      messageGroup(
        deps(true),
        run,
        { id: "bot-1", name: "Joy" },
        { group_id: "group-1", message: "   ", intent: "request" },
        { deliveryKey: "key-3" },
      ),
    ).resolves.toEqual({ ok: false, error: "message is required" });
  });
});
