import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";

export type BubbleShape = "solo" | "first" | "middle" | "last";

/** A run is broken by a non-message row, a non-groupable message or another sender. */
export function computeMessageBubbleShapes(
  items: readonly (ThreadMessage | null)[],
  isGroupable: (message: ThreadMessage) => boolean,
): Map<string, BubbleShape> {
  const shapes = new Map<string, BubbleShape>();
  let run: ThreadMessage[] = [];

  const flush = () => {
    const first = run[0];
    if (first && run.length === 1) {
      shapes.set(first.id, "solo");
    } else {
      run.forEach((message, index) => {
        shapes.set(
          message.id,
          index === 0 ? "first" : index === run.length - 1 ? "last" : "middle",
        );
      });
    }
    run = [];
  };

  for (const item of items) {
    if (!item || !isGroupable(item)) {
      flush();
      continue;
    }
    const previous = run.at(-1);
    if (previous && (previous.botId ?? "") !== (item.botId ?? "")) flush();
    run.push(item);
  }
  flush();
  return shapes;
}

export function bubbleShapeForTextBlock(input: {
  messageShape: BubbleShape;
  blocks: readonly MessageBlock[];
  blockIndex: number;
}): BubbleShape {
  const { messageShape, blocks, blockIndex } = input;
  const previousIsText = blockIndex > 0 && blocks[blockIndex - 1]?.kind === "text";
  const nextIsText = blockIndex < blocks.length - 1 && blocks[blockIndex + 1]?.kind === "text";
  const topJoined =
    previousIsText || (blockIndex === 0 && (messageShape === "middle" || messageShape === "last"));
  const bottomJoined =
    nextIsText ||
    (blockIndex === blocks.length - 1 && (messageShape === "first" || messageShape === "middle"));
  if (topJoined && bottomJoined) return "middle";
  if (topJoined) return "last";
  if (bottomJoined) return "first";
  return "solo";
}

export function bubbleRadiusClass(shape: BubbleShape, role: "user" | "bot"): string {
  if (shape === "solo") return "rounded-[18px]";
  if (role === "user") {
    if (shape === "first") {
      return "rounded-tl-[18px] rounded-tr-[18px] rounded-br-[2px] rounded-bl-[18px]";
    }
    if (shape === "middle") {
      return "rounded-tl-[18px] rounded-tr-[2px] rounded-br-[2px] rounded-bl-[18px]";
    }
    return "rounded-tl-[18px] rounded-tr-[2px] rounded-br-[18px] rounded-bl-[18px]";
  }
  if (shape === "first") {
    return "rounded-tl-[18px] rounded-tr-[18px] rounded-br-[18px] rounded-bl-[2px]";
  }
  if (shape === "middle") {
    return "rounded-tl-[2px] rounded-tr-[18px] rounded-br-[18px] rounded-bl-[2px]";
  }
  return "rounded-tl-[2px] rounded-tr-[18px] rounded-br-[18px] rounded-bl-[18px]";
}

export function messageIsBubbleText(message: ThreadMessage): boolean {
  if (message.role !== "bot" || message.id.startsWith("progress:")) return false;
  return message.blocks.length > 0 && message.blocks.every((block) => block.kind === "text");
}
