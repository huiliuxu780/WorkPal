import type { AvatarCharacter, MessageBlock } from "@rakazo/contracts";

/** Deliberately narrow: only a direct, single-purpose human command can authorize a Bot avatar write. */
export function requestedAvatarChange(text: string): AvatarCharacter | "attached-image" | null {
  const line = text.trim();
  if (line.length > 100 || /[\r\n<>`]/.test(line)) return null;
  const normalized = line.replace(/[。.!！?？]$/, "").trim();
  const chinese =
    /^(?:请)?(?:把|将)?(?:你(?:的)?|自己(?:的)?)?头像(?:换成|改成|设为|设置为)(点点|音符|波浪|弹跳)$/u.exec(
      normalized,
    );
  if (chinese)
    return ({ 点点: "dot", 音符: "treble", 波浪: "wave", 弹跳: "bounce" } as const)[
      chinese[1] as "点点"
    ];
  const english =
    /^(?:please )?(?:change|set|switch) (?:your )?avatar (?:to|as) (dot|treble|wave|bounce)$/i.exec(
      normalized,
    );
  if (english) return english[1]!.toLowerCase() as AvatarCharacter;
  if (
    /^(?:请)?(?:用|把)(?:我)?(?:刚才)?(?:上传|附上|附带)(?:的)?图片(?:作为|设为|换成)(?:你(?:的)?)?头像$/u.test(
      normalized,
    )
  )
    return "attached-image";
  if (/^(?:please )?(?:use|set) (?:the )?attached image as (?:your )?avatar$/i.test(normalized))
    return "attached-image";
  return null;
}

export function authorizedAvatarRequest(
  run: { trigger: string; threadId: string; userId: string; sourceMessageId: string | null },
  source: {
    id: string;
    threadId: string;
    role: string;
    originKind: string;
    authorUserId: string | null;
    blocks: unknown;
  } | null,
) {
  if (
    (run.trigger !== "user" && run.trigger !== "follow_up") ||
    !run.sourceMessageId ||
    source?.id !== run.sourceMessageId ||
    source.threadId !== run.threadId ||
    source.role !== "user" ||
    source.originKind !== "human_web" ||
    source.authorUserId !== run.userId
  )
    return null;
  const blocks = source.blocks as MessageBlock[];
  if (!Array.isArray(blocks)) return null;
  const texts = blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text",
  );
  if (texts.length !== 1) return null;
  const requested = requestedAvatarChange(texts[0]!.text);
  if (requested === "attached-image") {
    return blocks.length === 2 && blocks.filter((block) => block.kind === "image").length === 1
      ? requested
      : null;
  }
  return blocks.length === 1 ? requested : null;
}
