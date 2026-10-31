import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  bubbleRadiusClass,
  bubbleShapeForTextBlock,
  computeMessageBubbleShapes,
  messageIsBubbleText,
} from "./message-bubble-shape";

function message(
  id: string,
  role: ThreadMessage["role"],
  blocks: MessageBlock[],
  botId = "bot-1",
): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 1,
    role,
    blocks,
    botId,
    createdAt: "2026-10-30T00:00:00.000Z",
  };
}

const text = (value: string): MessageBlock => ({ kind: "text", text: value });
const file: MessageBlock = {
  kind: "file",
  artifactId: "artifact-1",
  mimeType: "text/html",
  name: "report.html",
  size: 12,
};

describe("computeMessageBubbleShapes", () => {
  it("joins consecutive bot text messages and breaks on user or card rows", () => {
    const first = message("m1", "bot", [text("one")]);
    const second = message("m2", "bot", [text("two")]);
    const card = message("m3", "bot", [file]);
    const third = message("m4", "bot", [text("three")]);
    const user = message("m5", "user", [text("four")], undefined);
    const fourth = message("m6", "bot", [text("five")]);
    const shapes = computeMessageBubbleShapes(
      [first, second, card, third, user, fourth],
      messageIsBubbleText,
    );
    expect(shapes.get("m1")).toBe("first");
    expect(shapes.get("m2")).toBe("last");
    expect(shapes.has("m3")).toBe(false);
    expect(shapes.get("m4")).toBe("solo");
    expect(shapes.has("m5")).toBe(false);
    expect(shapes.get("m6")).toBe("solo");
  });

  it("does not join different senders or null rows", () => {
    const first = message("m1", "bot", [text("one")], "bot-1");
    const second = message("m2", "bot", [text("two")], "bot-2");
    const third = message("m3", "bot", [text("three")], "bot-2");
    const shapes = computeMessageBubbleShapes([first, null, second, third], messageIsBubbleText);
    expect(shapes.get("m1")).toBe("solo");
    expect(shapes.get("m2")).toBe("first");
    expect(shapes.get("m3")).toBe("last");
  });

  it("treats a single text message as solo", () => {
    const only = message("m1", "bot", [text("one")]);
    expect(computeMessageBubbleShapes([only], messageIsBubbleText).get("m1")).toBe("solo");
  });
});

describe("bubbleShapeForTextBlock", () => {
  it("joins text blocks inside a message and breaks around a card", () => {
    const blocks: MessageBlock[] = [text("a"), text("b"), file, text("c")];
    expect(bubbleShapeForTextBlock({ messageShape: "solo", blocks, blockIndex: 0 })).toBe("first");
    expect(bubbleShapeForTextBlock({ messageShape: "solo", blocks, blockIndex: 1 })).toBe("last");
    expect(bubbleShapeForTextBlock({ messageShape: "solo", blocks, blockIndex: 3 })).toBe("solo");
  });

  it("carries the message edge into the first and last text block", () => {
    const blocks: MessageBlock[] = [text("a"), text("b")];
    expect(bubbleShapeForTextBlock({ messageShape: "middle", blocks, blockIndex: 0 })).toBe(
      "middle",
    );
    expect(bubbleShapeForTextBlock({ messageShape: "middle", blocks, blockIndex: 1 })).toBe(
      "middle",
    );
    expect(bubbleShapeForTextBlock({ messageShape: "last", blocks, blockIndex: 0 })).toBe("middle");
    expect(bubbleShapeForTextBlock({ messageShape: "last", blocks, blockIndex: 1 })).toBe("last");
    expect(bubbleShapeForTextBlock({ messageShape: "first", blocks, blockIndex: 0 })).toBe("first");
    expect(bubbleShapeForTextBlock({ messageShape: "first", blocks, blockIndex: 1 })).toBe(
      "middle",
    );
  });
});

describe("bubbleRadiusClass", () => {
  it("joins the bot side on the avatar edge", () => {
    expect(bubbleRadiusClass("first", "bot")).toContain("rounded-bl-[2px]");
    expect(bubbleRadiusClass("middle", "bot")).toContain("rounded-tl-[2px]");
    expect(bubbleRadiusClass("last", "bot")).toContain("rounded-tl-[2px]");
    expect(bubbleRadiusClass("solo", "bot")).toBe("rounded-[18px]");
  });
});
