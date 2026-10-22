import { describe, expect, it } from "vitest";
import { buildMentionInlines } from "./message-inlines.js";

const linkable = new Set(["bot-a", "bot-b"]);

describe("buildMentionInlines", () => {
  it("splits text around typed mention ranges", () => {
    expect(
      buildMentionInlines({
        text: "@Alpha and @Beta review this",
        spans: [
          { botId: "bot-a", start: 0, end: 6 },
          { botId: "bot-b", start: 11, end: 16 },
        ],
        linkableBotIds: linkable,
      }),
    ).toEqual([
      { kind: "bot_mention", botId: "bot-a", label: "Alpha" },
      { kind: "text", text: " and " },
      { kind: "bot_mention", botId: "bot-b", label: "Beta" },
      { kind: "text", text: " review this" },
    ]);
  });

  it("keeps unlinkable mentions as plain text", () => {
    expect(
      buildMentionInlines({
        text: "@Gamma @Alpha review",
        spans: [
          { botId: "bot-gamma", start: 0, end: 6 },
          { botId: "bot-a", start: 7, end: 13 },
        ],
        linkableBotIds: linkable,
      }),
    ).toEqual([
      { kind: "text", text: "@Gamma " },
      { kind: "bot_mention", botId: "bot-a", label: "Alpha" },
      { kind: "text", text: " review" },
    ]);
  });

  it("falls back to text only when no authorized span survives", () => {
    expect(
      buildMentionInlines({
        text: "@Gamma review",
        spans: [{ botId: "bot-gamma", start: 0, end: 6 }],
        linkableBotIds: linkable,
      }),
    ).toBeUndefined();
    expect(
      buildMentionInlines({ text: "@Alpha review", spans: [], linkableBotIds: linkable }),
    ).toBe(undefined);
  });

  it("drops duplicate and overlapping ranges without guessing", () => {
    expect(
      buildMentionInlines({
        text: "@Alpha @Alpha review",
        spans: [
          { botId: "bot-a", start: 0, end: 6 },
          { botId: "bot-b", start: 4, end: 12 },
          { botId: "bot-a", start: 7, end: 13 },
        ],
        linkableBotIds: linkable,
      }),
    ).toEqual([
      { kind: "bot_mention", botId: "bot-a", label: "Alpha" },
      { kind: "text", text: " @Alpha review" },
    ]);
  });

  it("adjusts ranges after the caption is trimmed", () => {
    expect(
      buildMentionInlines({
        text: "  @Alpha review  ",
        spans: [{ botId: "bot-a", start: 2, end: 8 }],
        linkableBotIds: linkable,
      }),
    ).toEqual([
      { kind: "bot_mention", botId: "bot-a", label: "Alpha" },
      { kind: "text", text: " review" },
    ]);
  });
});
