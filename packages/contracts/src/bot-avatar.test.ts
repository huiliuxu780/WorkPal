import { describe, expect, it } from "vitest";
import {
  AVATAR_CHARACTERS,
  BOT_AVATAR_VALUE_MAX_LENGTH,
  BotAvatarValueSchema,
  CreateBotInput,
  isBotAvatarValue,
  parseBotAvatarValue,
  pickAvatarCharacter,
  resolveAvatarIdentity,
  UpdateBotInput,
} from "./index.js";

describe("bot avatar values", () => {
  it("parses hex, encoded shapes, and data images", () => {
    expect(parseBotAvatarValue("#8B5CF6")).toEqual({ kind: "color", color: "#8B5CF6" });
    expect(parseBotAvatarValue("#8B5CF6::shape_3")).toEqual({
      kind: "shape",
      color: "#8B5CF6",
      shapeIndex: 3,
    });
    expect(parseBotAvatarValue("data:image/png;base64,abc")).toEqual({
      kind: "image",
      imageUrl: "data:image/png;base64,abc",
    });
  });

  it("does not treat remote URLs as images", () => {
    expect(parseBotAvatarValue("https://evil.example/track.png")).toEqual({
      kind: "other",
      raw: "https://evil.example/track.png",
    });
    expect(isBotAvatarValue("https://evil.example/track.png")).toBe(false);
  });

  it("accepts supported writes and rejects old style, oversized or remote values", () => {
    expect(isBotAvatarValue("#3EC5A8")).toBe(true);
    expect(isBotAvatarValue("#8B5CF6::shape_0")).toBe(true);
    expect(isBotAvatarValue("data:image/webp;base64,aGVsbG8=")).toBe(true);
    expect(isBotAvatarValue("#8B5CF6::bloub")).toBe(false);
    expect(isBotAvatarValue("#8B5CF6::bloubjunk")).toBe(false);
    expect(isBotAvatarValue("#8B5CF6::shape_3::bloub")).toBe(false);
    expect(parseBotAvatarValue("#8B5CF6::bloub")).toEqual({ kind: "other", raw: "#8B5CF6::bloub" });
    expect(isBotAvatarValue("#0a0a0c::bloub::cercle::neutre")).toBe(false);
    expect(isBotAvatarValue("#0a0a0c::bloub::cercle::neutre::extra")).toBe(false);
    expect(
      isBotAvatarValue(`data:image/png;base64,${"A".repeat(BOT_AVATAR_VALUE_MAX_LENGTH)}`),
    ).toBe(false);
    expect(BotAvatarValueSchema.safeParse("#fff").success).toBe(true);
    expect(BotAvatarValueSchema.safeParse("not-a-color").success).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", color: "#8B5CF6::shape_2" }).success).toBe(
      true,
    );
    expect(
      UpdateBotInput.safeParse({ botId: "bot-1", color: "https://evil.example/x.png" }).success,
    ).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", color: "gray" }).success).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", name: "Atlas" }).success).toBe(true);
  });
});

describe("character avatar assignment", () => {
  it("uses every character once for the first four Bots, then reuses the least-used", () => {
    const existing: Array<{ avatarMode: string; avatarCharacter: string | null }> = [];
    const firstFour: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const chosen = pickAvatarCharacter(existing, `bot-${i}`);
      firstFour.push(chosen);
      existing.push({ avatarMode: "character", avatarCharacter: chosen });
    }
    expect(new Set(firstFour)).toEqual(new Set(AVATAR_CHARACTERS));
    expect(AVATAR_CHARACTERS).toContain(pickAvatarCharacter(existing, "bot-4"));
  });

  it("uses a stable id tie-break and ignores legacy/invalid rows", () => {
    const existing = [
      { avatarMode: "legacy", avatarCharacter: "dot" },
      { avatarMode: "character", avatarCharacter: "bad" },
      { avatarMode: "character", avatarCharacter: "dot" },
    ];
    const selected = pickAvatarCharacter(existing, "stable-id");
    expect(selected).not.toBe("dot");
    expect(pickAvatarCharacter([...existing].reverse(), "stable-id")).toBe(selected);
  });

  it("keeps legacy images and falls back from malformed character rows", () => {
    const image = "data:image/png;base64,abc";
    expect(resolveAvatarIdentity("legacy", null, image)).toEqual({
      avatarMode: "legacy",
      avatarCharacter: null,
    });
    expect(resolveAvatarIdentity("upload", null, image)).toEqual({
      avatarMode: "upload",
      avatarCharacter: null,
    });
    expect(resolveAvatarIdentity("character", "unknown", "#fff")).toEqual({
      avatarMode: "character",
      avatarCharacter: "dot",
    });
  });

  it("validates explicit mode/character and image writes", () => {
    expect(
      CreateBotInput.safeParse({ name: "New", avatarMode: "character", avatarCharacter: "wave" })
        .success,
    ).toBe(true);
    expect(CreateBotInput.safeParse({ name: "New", avatarMode: "character" }).success).toBe(false);
    expect(
      UpdateBotInput.safeParse({ botId: "bot-1", avatarMode: "character", avatarCharacter: "x" })
        .success,
    ).toBe(false);
    expect(
      UpdateBotInput.safeParse({ botId: "bot-1", avatarMode: "upload", color: "#ffffff" }).success,
    ).toBe(false);
    expect(
      UpdateBotInput.safeParse({ botId: "bot-1", avatarMode: "character", avatarCharacter: "dot" })
        .success,
    ).toBe(true);
  });
});
