import { describe, expect, it } from "vitest";
import { assertProductEventPayload, type MessageBlock } from "./events.js";
import {
  InterventionEventPayloadSchema,
  InterventionPresentationSchema,
  InterventionViewSchema,
  legacyInterventionId,
  MAX_PRESENTATION_TEXT_CHARS,
  presentationFromAskBlock,
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

  it("keeps the presentation snapshot on the whitelisted fields only", () => {
    const withSnapshot = InterventionViewSchema.parse({ ...view, presentation: { text: "Send the email?" } });
    expect(withSnapshot.presentation?.text).toBe("Send the email?");
    const ask = {
      kind: "ask",
      text: "Sign in to continue.",
      detail: "We need the account password.",
      status: "pending",
      input: "secret",
      purpose: "password",
      credential: {
        name: "example_login",
        origin: "https://login.example.test",
        auth: { type: "basic", username: "acct-name" },
      },
      answer: "sk-live-answer",
    } as unknown as Extract<MessageBlock, { kind: "ask" }>;
    const presentation = presentationFromAskBlock(ask);
    expect(presentation).toEqual({
      text: "Sign in to continue.",
      detail: "We need the account password.",
      credential: {
        name: "example_login",
        origin: "https://login.example.test",
        authType: "basic",
      },
    });
    expect(JSON.stringify(presentation)).not.toContain("sk-live-answer");
    expect(JSON.stringify(presentation)).not.toContain("acct-name");
    const long = presentationFromAskBlock({
      ...ask,
      text: "x".repeat(MAX_PRESENTATION_TEXT_CHARS + 500),
    });
    expect(long.text.length).toBe(MAX_PRESENTATION_TEXT_CHARS);
    for (const extra of [
      { answer: "sk-live-answer" },
      { username: "acct-name" },
      { value: "sk-live-answer" },
      { request: { token: "x" } },
    ]) {
      expect(InterventionPresentationSchema.safeParse({ text: "ok", ...extra }).success).toBe(false);
    }
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
    expect(() =>
      assertProductEventPayload("intervention.created", {
        ...payload,
        presentation: { text: "Which city?" },
      }),
    ).not.toThrow();
    expect(
      InterventionEventPayloadSchema.safeParse({
        ...payload,
        presentation: { text: "Which city?", answer: "sk-live-secret" },
      }).success,
    ).toBe(false);
  });
});
