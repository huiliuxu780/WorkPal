import { describe, expect, it } from "vitest";
import { assertProductEventPayload } from "./events.js";
import {
  InterventionEventPayloadSchema,
  InterventionViewSchema,
  legacyInterventionId,
} from "./intervention.js";

const view = {
  id: "intervention-1",
  revision: 1,
  kind: "approval" as const,
  status: "pending" as const,
  spaceId: "space-1",
  threadId: "thread-1",
  runId: "run-1",
  attemptId: "attempt-1",
  botId: "bot-1",
  messageId: "message-1",
  createdAt: "2026-10-12T00:00:00.000Z",
  requestingActor: { botId: "bot-1" },
  approval: {
    effectId: "effect-1",
    effectStatus: "intended",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ],
  },
};

describe("Intervention contract", () => {
  it("parses a current view and an older view without optional fields", () => {
    expect(InterventionViewSchema.parse(view)).toMatchObject({
      id: "intervention-1",
      approval: { effectStatus: "intended" },
    });
    const legacy = { ...view, kind: "input", approval: undefined, input: { mode: "text" } };
    delete (legacy as { approval?: unknown }).approval;
    expect(InterventionViewSchema.parse(legacy).input?.mode).toBe("text");
    expect(legacyInterventionId("message-1")).toBe("legacy_message-1");
  });

  it("keeps an approval decision separate from effect execution status", () => {
    const answered = InterventionViewSchema.parse({
      ...view,
      status: "answered",
      revision: 2,
      resolvedAt: "2026-10-12T00:01:00.000Z",
      approval: { effectId: "effect-1", decision: "approved", effectStatus: "uncertain" },
    });
    expect(answered.approval?.decision).toBe("approved");
    expect(answered.approval?.effectStatus).toBe("uncertain");
  });

  it("rejects secret plaintext and effect bodies on the event payload", () => {
    const payload = {
      interventionId: view.id,
      revision: 2,
      kind: "input" as const,
      status: "answered" as const,
      runId: view.runId,
      attemptId: view.attemptId,
      messageId: view.messageId,
      botId: view.botId,
      createdAt: view.createdAt,
      actor: { botId: "bot-1" },
      input: { mode: "secret" as const, purpose: "api_key" as const },
    };
    expect(InterventionEventPayloadSchema.parse(payload).input?.purpose).toBe("api_key");
    expect(() => assertProductEventPayload("intervention.resolved", payload)).not.toThrow();
    for (const extra of [
      { answer: "sk-live-secret" },
      { request: { token: "sk-live-secret" } },
      { result: { token: "sk-live-secret" } },
      { plaintext: "sk-live-secret" },
    ]) {
      expect(InterventionEventPayloadSchema.safeParse({ ...payload, ...extra }).success).toBe(false);
    }
  });
});
