import { describe, expect, it } from "vitest";
import {
  resolveDirectTurnOwner,
  resolveExplicitTurnOwner,
} from "./response-owner.js";

const members = [
  { id: "finance", name: "Finance" },
  { id: "coding", name: "Coding" },
  { id: "research", name: "Research" },
];

describe("resolveExplicitTurnOwner", () => {
  it("gives the turn to a single mentioned bot without any router input", () => {
    expect(
      resolveExplicitTurnOwner({
        text: "@Finance check this budget",
        members,
      }),
    ).toEqual({ kind: "explicit_mention", ownerBotIds: ["finance"], responseMode: "single" });
  });

  it("honors typed mention chips", () => {
    expect(
      resolveExplicitTurnOwner({
        text: "look at this please",
        members,
        explicitMentionIds: ["coding"],
      }),
    ).toEqual({ kind: "explicit_mention", ownerBotIds: ["coding"], responseMode: "single" });
  });

  it("keeps @everyone as intentional all-member multi-response", () => {
    const owner = resolveExplicitTurnOwner({ text: "@everyone give me your view", members });
    expect(owner).toMatchObject({ kind: "explicit_multi", responseMode: "multi" });
    if (!("kind" in owner)) throw new Error("unreachable");
    expect(owner.ownerBotIds.sort()).toEqual(["coding", "finance", "research"]);
  });

  it("treats multiple mentions with separate-answer wording as multi", () => {
    expect(
      resolveExplicitTurnOwner({
        text: "@Finance @Coding 分别说说你们的看法",
        members,
      }),
    ).toEqual({
      kind: "explicit_multi",
      ownerBotIds: ["finance", "coding"],
      responseMode: "multi",
    });
  });

  it("defaults multiple mentions without separate-answer wording to one owner", () => {
    expect(
      resolveExplicitTurnOwner({
        text: "@Finance @Coding take a look",
        members,
      }),
    ).toEqual({ kind: "explicit_mention", ownerBotIds: ["finance"], responseMode: "single" });
  });

  it("routes a reply to the replied bot when nothing else is addressed", () => {
    expect(
      resolveExplicitTurnOwner({
        text: "what about year two?",
        members,
        replyTargetBotId: "finance",
      }),
    ).toEqual({ kind: "reply_target", ownerBotIds: ["finance"], responseMode: "single" });
  });

  it("lets an explicit mention override the reply target", () => {
    expect(
      resolveExplicitTurnOwner({
        text: "@Coding you answer this one",
        members,
        replyTargetBotId: "finance",
      }),
    ).toEqual({ kind: "explicit_mention", ownerBotIds: ["coding"], responseMode: "single" });
  });

  it("ignores a reply target that is not a current member", () => {
    expect(
      resolveExplicitTurnOwner({
        text: "and next year?",
        members,
        replyTargetBotId: "former-member",
      }),
    ).toEqual({ unresolved: true });
  });

  it("reports an unaddressed group turn as unresolved — never members[0]", () => {
    expect(
      resolveExplicitTurnOwner({
        text: "看看这套 API 架构合理吗",
        members,
      }),
    ).toEqual({ unresolved: true });
  });

  it("reports a direct single-bot owner", () => {
    expect(resolveDirectTurnOwner("coding")).toEqual({
      kind: "direct",
      ownerBotIds: ["coding"],
      responseMode: "single",
    });
  });
});
