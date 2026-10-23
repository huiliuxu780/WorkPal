import { describe, expect, it } from "vitest";
import { appContract, MessageBlock } from "./index.js";

type SendInputSchema = {
  safeParse(value: unknown): { success: boolean };
};

const sendInput = (
  appContract.threads.send as unknown as { "~orpc": { inputSchema: SendInputSchema } }
)["~orpc"].inputSchema;

describe("message mention contract", () => {
  it("keeps structured Bot identity on a text block", () => {
    const parsed = MessageBlock.parse({
      kind: "text",
      text: "@Beta review this",
      inlines: [
        { kind: "bot_mention", botId: "bot-b", label: "Beta" },
        { kind: "text", text: " review this" },
      ],
    });
    expect(parsed).toMatchObject({
      kind: "text",
      inlines: [
        { kind: "bot_mention", botId: "bot-b", label: "Beta" },
        { kind: "text", text: " review this" },
      ],
    });
  });

  it("keeps legacy text-only blocks valid", () => {
    const parsed = MessageBlock.parse({ kind: "text", text: "@Beta review this" });
    expect(parsed).toEqual({ kind: "text", text: "@Beta review this" });
  });

  it("rejects empty or malformed inline identity", () => {
    expect(MessageBlock.safeParse({ kind: "text", text: "hi", inlines: [] }).success).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "text",
        text: "hi",
        inlines: [{ kind: "bot_mention", label: "Beta" }],
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "text",
        text: "hi",
        inlines: [{ kind: "user_mention", botId: "bot-b", label: "Beta" }],
      }).success,
    ).toBe(false);
  });

  it("accepts spans only for typed Bot mentions inside text", () => {
    expect(
      sendInput.safeParse({
        groupId: "group-1",
        text: "@Beta review this",
        mentions: [{ kind: "bot", id: "bot-b" }],
        mentionSpans: [{ botId: "bot-b", start: 0, end: 5 }],
      }).success,
    ).toBe(true);
  });

  it("rejects a span without matching typed Bot identity", () => {
    expect(
      sendInput.safeParse({
        groupId: "group-1",
        text: "@Beta review this",
        mentions: [{ kind: "group", id: "group-2" }],
        mentionSpans: [{ botId: "bot-b", start: 0, end: 5 }],
      }).success,
    ).toBe(false);
  });

  it("rejects spans that drift from an @ token or overlap", () => {
    expect(
      sendInput.safeParse({
        groupId: "group-1",
        text: "@Beta review this",
        mentions: [{ kind: "bot", id: "bot-b" }],
        mentionSpans: [{ botId: "bot-b", start: 1, end: 5 }],
      }).success,
    ).toBe(false);
    expect(
      sendInput.safeParse({
        groupId: "group-1",
        text: "@Beta @Beta review",
        mentions: [{ kind: "bot", id: "bot-b" }],
        mentionSpans: [
          { botId: "bot-b", start: 0, end: 5 },
          { botId: "bot-b", start: 4, end: 9 },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a Bot repeated across non-overlapping spans", () => {
    expect(
      sendInput.safeParse({
        groupId: "group-1",
        text: "@Beta @Beta review this",
        mentions: [{ kind: "bot", id: "bot-b" }],
        mentionSpans: [
          { botId: "bot-b", start: 0, end: 5 },
          { botId: "bot-b", start: 6, end: 11 },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects spans that are out of order", () => {
    expect(
      sendInput.safeParse({
        groupId: "group-1",
        text: "@Beta @Gamma review",
        mentions: [
          { kind: "bot", id: "bot-b" },
          { kind: "bot", id: "bot-g" },
        ],
        mentionSpans: [
          { botId: "bot-g", start: 6, end: 12 },
          { botId: "bot-b", start: 0, end: 5 },
        ],
      }).success,
    ).toBe(false);
  });

  it("uses UTF-16 offsets around emoji", () => {
    // "😀" occupies two UTF-16 units, so the @ token starts at index 3.
    expect(
      sendInput.safeParse({
        groupId: "group-1",
        text: "😀 @Beta review this",
        mentions: [{ kind: "bot", id: "bot-b" }],
        mentionSpans: [{ botId: "bot-b", start: 3, end: 8 }],
      }).success,
    ).toBe(true);
    expect(
      sendInput.safeParse({
        groupId: "group-1",
        text: "😀 @Beta review this",
        mentions: [{ kind: "bot", id: "bot-b" }],
        mentionSpans: [{ botId: "bot-b", start: 1, end: 8 }],
      }).success,
    ).toBe(false);
  });

  it("rejects a span that splits a UTF-16 surrogate pair", () => {
    expect(
      sendInput.safeParse({
        groupId: "group-1",
        text: "@Beta😀 review this",
        mentions: [{ kind: "bot", id: "bot-b" }],
        mentionSpans: [{ botId: "bot-b", start: 0, end: 6 }],
      }).success,
    ).toBe(false);
    expect(
      sendInput.safeParse({
        groupId: "group-1",
        text: "@Beta😀 review this",
        mentions: [{ kind: "bot", id: "bot-b" }],
        mentionSpans: [{ botId: "bot-b", start: 0, end: 7 }],
      }).success,
    ).toBe(true);
  });
});
