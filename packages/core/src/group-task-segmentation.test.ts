import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type GroupMentionSpan,
  type GroupTaskSegmentation,
  segmentGroupMentionTasks,
} from "./group-task-segmentation.js";

const members = [
  { id: "bot-a", name: "Alpha" },
  { id: "bot-b", name: "Beta" },
  { id: "bot-c", name: "Gamma" },
];

function locate(
  text: string,
  tokens: ReadonlyArray<readonly [token: string, botId: string]>,
): GroupMentionSpan[] {
  let cursor = 0;
  return tokens.map(([token, botId]) => {
    const start = text.indexOf(token, cursor);
    if (start < 0) throw new Error(`missing token ${token} after ${cursor} in ${text}`);
    cursor = start + token.length;
    return { botId, start, end: cursor };
  });
}

function segment(
  text: string,
  spans: readonly GroupMentionSpan[],
  extra: {
    typedBotIds?: readonly string[];
    replyTargetBotId?: string | null;
    hasAttachments?: boolean;
    members?: readonly { id: string; name: string }[];
  } = {},
) {
  return segmentGroupMentionTasks({
    text,
    spans,
    typedBotIds: extra.typedBotIds ?? ["bot-a", "bot-b", "bot-c"],
    members: extra.members ?? members,
    ...(extra.replyTargetBotId !== undefined ? { replyTargetBotId: extra.replyTargetBotId } : {}),
    ...(extra.hasAttachments !== undefined ? { hasAttachments: extra.hasAttachments } : {}),
  });
}

function expectClarification(
  outcome: GroupTaskSegmentation,
  reasonCode: string,
): asserts outcome is Extract<GroupTaskSegmentation, { kind: "clarification_required" }> {
  expect(outcome).toMatchObject({ kind: "clarification_required", reasonCode });
}

describe("segmentGroupMentionTasks decision table", () => {
  it("1. gives one typed mention with a command to that owner", () => {
    const text = "@Alpha review the budget";
    const outcome = segment(text, locate(text, [["@Alpha", "bot-a"]]));
    expect(outcome).toEqual({
      kind: "single_owner",
      ownerBotId: "bot-a",
      instruction: text,
      mentionBotIds: ["bot-a"],
    });
  });

  it("2. lets two mentions share one command", () => {
    const text = "@Alpha 和 @Beta 一起审查 X";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expect(outcome).toEqual({
      kind: "shared_multi",
      ownerBotIds: ["bot-a", "bot-b"],
      instruction: "一起审查 X",
      mentionBotIds: ["bot-a", "bot-b"],
    });
  });

  it('3. segments "@A 做 X，@B 做 Y" with independent instructions', () => {
    const text = "@Alpha 做 X，@Beta 做 Y";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expect(outcome.kind).toBe("segmented_multi");
    if (outcome.kind !== "segmented_multi") throw new Error("unreachable");
    expect(outcome.segments.map(({ botId, instruction }) => ({ botId, instruction }))).toEqual([
      { botId: "bot-a", instruction: "做 X" },
      { botId: "bot-b", instruction: "做 Y" },
    ]);
    for (const part of outcome.segments) {
      expect(part.start).toBeGreaterThanOrEqual(0);
      expect(part.end).toBeGreaterThan(part.start);
      expect(part.end).toBeLessThanOrEqual(text.length);
      expect(text.slice(part.start, part.end).trim()).toBe(part.instruction);
    }
    expect(outcome.segments[0]!.end).toBeLessThanOrEqual(outcome.segments[1]!.start);
  });

  it.each([
    ["Chinese comma", "，"],
    ["Chinese semicolon", "；"],
    ["Chinese period", "。"],
    ["newline", "\n"],
  ])("4. segments Chinese %s boundaries", (_name, delimiter) => {
    const text = `@Alpha 做 X${delimiter}@Beta 做 Y`;
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expect(outcome).toMatchObject({
      kind: "segmented_multi",
      segments: [
        { botId: "bot-a", instruction: "做 X" },
        { botId: "bot-b", instruction: "做 Y" },
      ],
    });
  });

  it.each([
    ["comma", ", "],
    ["semicolon", "; "],
    ["period", ". "],
    ["newline", "\n"],
  ])("5. segments English %s boundaries", (_name, delimiter) => {
    const text = `@Alpha do X${delimiter}@Beta do Y`;
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expect(outcome).toMatchObject({
      kind: "segmented_multi",
      segments: [
        { botId: "bot-a", instruction: "do X" },
        { botId: "bot-b", instruction: "do Y" },
      ],
    });
  });

  it("6a. rejects the same Bot with two different instructions", () => {
    const text = "@Alpha 做 X，@Alpha 做 Y";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Alpha", "bot-a"],
      ]),
    );
    expectClarification(outcome, "duplicate_target_conflict");
    expect(outcome.mentionBotIds).toEqual(["bot-a"]);
  });

  it("6b. merges the same Bot repeated with the same instruction", () => {
    const text = "@Alpha 做 X，@Alpha 做 X";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Alpha", "bot-a"],
      ]),
    );
    expect(outcome).toMatchObject({
      kind: "single_owner",
      ownerBotId: "bot-a",
      mentionBotIds: ["bot-a"],
    });
  });

  it("7a. rejects a Bot mention with no content", () => {
    const text = "@Alpha";
    const outcome = segment(text, locate(text, [["@Alpha", "bot-a"]]));
    expectClarification(outcome, "empty_instruction");
  });

  it("7b. rejects a shared mention list with no content", () => {
    const text = "@Alpha 和 @Beta";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expectClarification(outcome, "empty_instruction");
  });

  it("8. treats an instruction before the mention as a single owner", () => {
    const text = "请把这份文档发给 @Alpha";
    const outcome = segment(text, locate(text, [["@Alpha", "bot-a"]]));
    expect(outcome).toEqual({
      kind: "single_owner",
      ownerBotId: "bot-a",
      instruction: text,
      mentionBotIds: ["bot-a"],
    });
  });

  it("9. rejects instructions interleaved between mentions without a boundary", () => {
    const text = "@Alpha 做 X @Beta 做 Y";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expectClarification(outcome, "ambiguous_attribution");
  });

  it("10. does not dispatch a reference mention", () => {
    const text = "我刚才和 @Alpha 讨论过";
    const outcome = segment(text, locate(text, [["@Alpha", "bot-a"]]));
    expect(outcome).toEqual({
      kind: "ordinary_mention",
      mentionBotIds: ["bot-a"],
      replyTargetBotId: null,
    });
  });

  it("keeps multiple reference mentions ordinary", () => {
    const text = "我刚才和 @Alpha、@Beta 讨论过";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expect(outcome).toEqual({
      kind: "ordinary_mention",
      mentionBotIds: ["bot-a", "bot-b"],
      replyTargetBotId: null,
    });
  });

  it("11. lets a typed task mention override the reply target", () => {
    const text = "@Alpha 做 X";
    const outcome = segment(text, locate(text, [["@Alpha", "bot-a"]]), {
      replyTargetBotId: "bot-b",
    });
    expect(outcome).toMatchObject({
      kind: "single_owner",
      ownerBotId: "bot-a",
      mentionBotIds: ["bot-a"],
    });
    expect(outcome).not.toHaveProperty("replyTargetBotId");
  });

  it("12a. keeps attachment-only sends with no typed mentions ordinary", () => {
    const outcome = segment("", [], { hasAttachments: true });
    expect(outcome).toEqual({
      kind: "ordinary_mention",
      mentionBotIds: [],
      replyTargetBotId: null,
    });
  });

  it("12b. allows a single owner to receive an attachment", () => {
    const text = "@Alpha 看这个";
    const outcome = segment(text, locate(text, [["@Alpha", "bot-a"]]), {
      hasAttachments: true,
    });
    expect(outcome.kind).toBe("single_owner");
  });

  it("12c. allows a shared multi task to receive an attachment", () => {
    const text = "@Alpha 和 @Beta 一起看这个";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
      { hasAttachments: true },
    );
    expect(outcome.kind).toBe("shared_multi");
  });

  it("12d. rejects attachments on a segmented multi task", () => {
    const text = "@Alpha 做 X，@Beta 做 Y";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
      { hasAttachments: true },
    );
    expectClarification(outcome, "attachments_not_attributable");
  });

  it("13a. uses UTF-16 offsets when an emoji precedes a mention", () => {
    const text = "😀 @Alpha 做 X";
    const spans = locate(text, [["@Alpha", "bot-a"]]);
    expect(spans).toEqual([{ botId: "bot-a", start: 3, end: 9 }]);
    const outcome = segment(text, spans);
    expect(outcome).toMatchObject({
      kind: "single_owner",
      ownerBotId: "bot-a",
      instruction: text,
    });
  });

  it("13b. keeps emoji inside a segmented instruction", () => {
    const text = "😀 @Alpha 做 X😀，@Beta 做 Y";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expect(outcome).toMatchObject({
      kind: "segmented_multi",
      segments: [
        { botId: "bot-a", instruction: "做 X😀" },
        { botId: "bot-b", instruction: "做 Y" },
      ],
    });
  });

  it("14a. rejects a span outside the text", () => {
    const text = "@Alpha 做 X";
    const outcome = segment(text, [{ botId: "bot-a", start: 0, end: text.length + 1 }]);
    expectClarification(outcome, "invalid_span");
  });

  it("14b. rejects overlapping spans", () => {
    const text = "@Alpha @Beta 做 X";
    const outcome = segment(text, [
      { botId: "bot-a", start: 0, end: 6 },
      { botId: "bot-b", start: 3, end: 12 },
    ]);
    expectClarification(outcome, "invalid_span");
  });

  it("14c. rejects out-of-order spans", () => {
    const text = "@Alpha @Beta 做 X";
    const outcome = segment(text, [
      { botId: "bot-b", start: 7, end: 12 },
      { botId: "bot-a", start: 0, end: 6 },
    ]);
    expectClarification(outcome, "invalid_span");
  });

  it("14d. rejects a span that does not start at a typed mention token", () => {
    const text = "@Alpha 做 X";
    const outcome = segment(text, [{ botId: "bot-a", start: 1, end: 6 }]);
    expectClarification(outcome, "invalid_span");
  });

  it("14e. rejects a span whose Bot id was not typed", () => {
    const text = "@Alpha 做 X";
    const outcome = segment(text, locate(text, [["@Alpha", "bot-a"]]), {
      typedBotIds: ["bot-b"],
    });
    expectClarification(outcome, "span_not_typed_mention");
  });

  it("14f. rejects a span that splits a UTF-16 surrogate pair", () => {
    const text = "@Alpha😀 做 X";
    expectClarification(segment(text, [{ botId: "bot-a", start: 0, end: 7 }]), "invalid_span");
    expect(segment(text, [{ botId: "bot-a", start: 0, end: 8 }]).kind).toBe("single_owner");
  });

  it("15. rejects a typed mention that is not an authorized group member", () => {
    const text = "@Gamma 做 X";
    const outcome = segment(text, locate(text, [["@Gamma", "bot-c"]]), {
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
    });
    expectClarification(outcome, "target_not_authorized");
    expect(outcome.mentionBotIds).toEqual(["bot-c"]);
  });

  it("keeps a non-member mention ordinary when it is only a reference", () => {
    const text = "我刚才和 @Gamma 讨论过";
    const outcome = segment(text, locate(text, [["@Gamma", "bot-c"]]), {
      members: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
    });
    expect(outcome).toEqual({
      kind: "ordinary_mention",
      mentionBotIds: ["bot-c"],
      replyTargetBotId: null,
    });
  });

  it("uses the span identity, not the displayed @name", () => {
    const text = "@Rename-Bait 做 X";
    const outcome = segment(text, locate(text, [["@Rename-Bait", "bot-b"]]));
    expect(outcome).toMatchObject({ kind: "single_owner", ownerBotId: "bot-b" });
  });

  it("supports a shared command after an addressing prefix", () => {
    const text = "Ask @Alpha and @Beta to review X";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expect(outcome).toMatchObject({
      kind: "shared_multi",
      ownerBotIds: ["bot-a", "bot-b"],
      instruction: "to review X",
    });
  });

  it("treats a trailing reference connector as ordinary", () => {
    const text = "I discussed this with @Alpha";
    const outcome = segment(text, locate(text, [["@Alpha", "bot-a"]]));
    expect(outcome.kind).toBe("ordinary_mention");
  });

  it("treats a Chinese trailing reference connector as ordinary", () => {
    const text = "我刚才和 @Alpha";
    const outcome = segment(text, locate(text, [["@Alpha", "bot-a"]]));
    expect(outcome.kind).toBe("ordinary_mention");
  });

  it("does not mistake the and inside a word for a list connector", () => {
    const text = "Stand @Alpha and @Beta";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expect(outcome).toMatchObject({
      kind: "shared_multi",
      ownerBotIds: ["bot-a", "bot-b"],
      instruction: "Stand",
    });
  });

  it("allows a trailing comma after a mention to be part of one command", () => {
    const text = "@Alpha，做 X";
    const outcome = segment(text, locate(text, [["@Alpha", "bot-a"]]));
    expect(outcome).toMatchObject({ kind: "single_owner", ownerBotId: "bot-a" });
  });

  it("attributes pre-mention background to a single owner", () => {
    const text = "上周的数据，请 @Alpha 分析";
    const outcome = segment(text, locate(text, [["@Alpha", "bot-a"]]));
    expect(outcome).toMatchObject({ kind: "single_owner", ownerBotId: "bot-a" });
  });

  it("requires clarification when background cannot be attributed across targets", () => {
    const text = "上周的数据，@Alpha 和 @Beta 一起分析";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expectClarification(outcome, "ambiguous_attribution");
  });

  it("requires clarification for a non-empty supplement outside all segments", () => {
    const text = "@Alpha 做 X，@Beta 做 Y。谢谢";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expectClarification(outcome, "ambiguous_attribution");
  });

  it("requires clarification when one segment is empty", () => {
    const text = "@Alpha。@Beta 做 Y";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expectClarification(outcome, "empty_instruction");
  });

  it("treats a comma directly between mentions as a shared list", () => {
    const text = "@Alpha，@Beta 做 Y";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expect(outcome).toMatchObject({
      kind: "shared_multi",
      ownerBotIds: ["bot-a", "bot-b"],
      instruction: "做 Y",
    });
  });

  it("attaches a leading skill line to a shared command", () => {
    const text = "/Daily digest\n@Alpha 和 @Beta 一起审查 X";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expect(outcome).toMatchObject({
      kind: "shared_multi",
      prefix: "/Daily digest",
      ownerBotIds: ["bot-a", "bot-b"],
      instruction: "一起审查 X",
    });
  });

  it("attaches a leading skill line to every segment instead of treating it as background", () => {
    const text = "/Daily digest\n@Alpha 做 X，@Beta 做 Y";
    const outcome = segment(
      text,
      locate(text, [
        ["@Alpha", "bot-a"],
        ["@Beta", "bot-b"],
      ]),
    );
    expect(outcome).toMatchObject({
      kind: "segmented_multi",
      prefix: "/Daily digest",
      segments: [
        { botId: "bot-a", instruction: "做 X" },
        { botId: "bot-b", instruction: "做 Y" },
      ],
    });
  });
});

describe("segmentGroupMentionTasks properties", () => {
  const mentionArb = fc
    .record({
      botId: fc.constantFrom("bot-a", "bot-b", "bot-c"),
      label: fc.constantFrom("@Alpha", "@Beta", "@Gamma"),
    })
    .map((mention) => ({ kind: "mention" as const, ...mention }));
  const textArb = fc.string({ maxLength: 12 }).map((value) => ({ kind: "text" as const, value }));
  const atomArb = fc.oneof(textArb, mentionArb);

  function buildInput(
    atoms: ReadonlyArray<
      { kind: "text"; value: string } | { kind: "mention"; botId: string; label: string }
    >,
  ) {
    let text = "";
    const spans: GroupMentionSpan[] = [];
    for (const atom of atoms) {
      if (atom.kind === "text") {
        text += atom.value;
      } else {
        const start = text.length;
        text += atom.label;
        spans.push({ botId: atom.botId, start, end: text.length });
      }
    }
    return { text, spans };
  }

  it("never throws and always returns a closed outcome for arbitrary typed spans", () => {
    fc.assert(
      fc.property(fc.array(atomArb, { maxLength: 8 }), (atoms) => {
        const { text, spans } = buildInput(atoms);
        const outcome = segmentGroupMentionTasks({
          text,
          spans,
          typedBotIds: ["bot-a", "bot-b", "bot-c"],
          members,
        });
        expect([
          "single_owner",
          "shared_multi",
          "segmented_multi",
          "ordinary_mention",
          "clarification_required",
        ]).toContain(outcome.kind);
        return true;
      }),
    );
  });

  it("returns stable results and keeps every segment inside the input", () => {
    fc.assert(
      fc.property(fc.array(atomArb, { maxLength: 8 }), (atoms) => {
        const { text, spans } = buildInput(atoms);
        const input = {
          text,
          spans,
          typedBotIds: ["bot-a", "bot-b", "bot-c"],
          members,
        };
        const first = segmentGroupMentionTasks(input);
        const second = segmentGroupMentionTasks(input);
        expect(second).toEqual(first);

        if (first.kind === "segmented_multi") {
          const typed = new Set(spans.map((span) => span.botId));
          let previousEnd = -1;
          for (const part of first.segments) {
            expect(typed.has(part.botId)).toBe(true);
            expect(part.start).toBeGreaterThanOrEqual(0);
            expect(part.end).toBeGreaterThan(part.start);
            expect(part.end).toBeLessThanOrEqual(text.length);
            expect(part.start).toBeGreaterThanOrEqual(previousEnd);
            expect(text.slice(part.start, part.end).trim()).toBe(part.instruction);
            previousEnd = part.end;
          }
        }
        if (first.kind === "clarification_required") {
          expect(first).not.toHaveProperty("segments");
          expect(first).not.toHaveProperty("ownerBotId");
          expect(first).not.toHaveProperty("ownerBotIds");
        }
        return true;
      }),
    );
  });

  it("never throws on malformed span bounds", () => {
    fc.assert(
      fc.property(fc.string(), fc.nat(), fc.nat(), (text, rawStart, rawEnd) => {
        const spans = [
          {
            botId: "bot-a",
            start: rawStart % (text.length + 4),
            end: rawEnd % (text.length + 4),
          },
        ];
        const outcome = segmentGroupMentionTasks({
          text,
          spans,
          typedBotIds: ["bot-a"],
          members,
        });
        expect([
          "single_owner",
          "shared_multi",
          "segmented_multi",
          "ordinary_mention",
          "clarification_required",
        ]).toContain(outcome.kind);
        return true;
      }),
    );
  });
});
