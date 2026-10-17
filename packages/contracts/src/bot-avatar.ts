import * as z from "zod";

export const AVATAR_CHARACTERS = ["dot", "treble", "wave", "bounce"] as const;
export const AvatarCharacterSchema = z.enum(AVATAR_CHARACTERS);
export type AvatarCharacter = z.infer<typeof AvatarCharacterSchema>;
export const AvatarModeSchema = z.enum(["legacy", "character", "upload"]);
export type AvatarMode = z.infer<typeof AvatarModeSchema>;

/** Stable across Node and browsers; never depends on array/DB iteration order. */
export function avatarIdHash(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  }
  return hash >>> 0;
}

/** Count archived and live character Bots from every Space owned by one user. */
export function pickAvatarCharacter(
  existing: readonly { avatarMode: string; avatarCharacter: string | null }[],
  botId: string,
): AvatarCharacter {
  const counts = new Map<AvatarCharacter, number>(AVATAR_CHARACTERS.map((name) => [name, 0]));
  for (const bot of existing) {
    const parsed = AvatarCharacterSchema.safeParse(bot.avatarCharacter);
    if (bot.avatarMode === "character" && parsed.success) {
      counts.set(parsed.data, counts.get(parsed.data)! + 1);
    }
  }
  const minimum = Math.min(...counts.values());
  const tied = AVATAR_CHARACTERS.filter((name) => counts.get(name) === minimum);
  return tied[avatarIdHash(botId) % tied.length]!;
}

/** Malformed historical DB values fail safely while their raw bytes remain for rollback. */
export function resolveAvatarIdentity(
  mode: unknown,
  character: unknown,
  color: string,
): { avatarMode: AvatarMode; avatarCharacter: AvatarCharacter | null } {
  if (mode === "character") {
    const parsed = AvatarCharacterSchema.safeParse(character);
    return {
      avatarMode: "character",
      avatarCharacter: parsed.success ? parsed.data : "dot",
    };
  }
  if (mode === "upload" && isBotAvatarValue(color) && color.startsWith("data:image/")) {
    return { avatarMode: "upload", avatarCharacter: null };
  }
  return { avatarMode: "legacy", avatarCharacter: null };
}

/** Matches the eight shipped mascot shapes in `@rakazo/core`. */
export const BOT_AVATAR_SHAPE_COUNT = 8;

/**
 * 256x256 webp data URLs from Avatar Studio stay well under this. Cap writes so
 * a pasted raw photo cannot bloat every bot list payload.
 */
export const BOT_AVATAR_VALUE_MAX_LENGTH = 200_000;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SHAPE_SUFFIX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})::shape_\d+$/;
/** `#hex::bloub` with optional `::shape::expression` suffixes (ids validated at parse). */
const BLOUB_SUFFIX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})::bloub(?:::[a-z]+){0,2}$/;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export type ParsedBotAvatar =
  | { kind: "image"; imageUrl: string }
  | { kind: "shape"; color: string; shapeIndex: number }
  | { kind: "bloub"; color: string; shape?: string; expression?: string }
  | { kind: "color"; color: string }
  | { kind: "other"; raw: string };

export function parseBotAvatarValue(raw: string): ParsedBotAvatar {
  if (raw.startsWith("data:image/")) {
    return { kind: "image", imageUrl: raw };
  }
  if (BLOUB_SUFFIX.test(raw)) {
    const parts = raw.split("::");
    return {
      kind: "bloub",
      color: parts[0] || "#F97316",
      ...(parts[2] ? { shape: parts[2] } : {}),
      ...(parts[3] ? { expression: parts[3] } : {}),
    };
  }
  if (raw.includes("::shape_")) {
    const parts = raw.split("::shape_");
    const color = parts[0] || "#F97316";
    const rawShape = parts[1] ?? "0";
    const parsedShape = /^\d+$/.test(rawShape) ? Number(rawShape) : 0;
    const shapeIndex = Number.isSafeInteger(parsedShape) ? parsedShape % BOT_AVATAR_SHAPE_COUNT : 0;
    return { kind: "shape", color, shapeIndex };
  }
  if (HEX_COLOR.test(raw)) return { kind: "color", color: raw };
  return { kind: "other", raw };
}

/** True for values we persist on `bots.color` (hex, encoded shape, or data image). */
export function isBotAvatarValue(raw: string): boolean {
  if (!raw || raw.length > BOT_AVATAR_VALUE_MAX_LENGTH) return false;
  return (
    HEX_COLOR.test(raw) || SHAPE_SUFFIX.test(raw) || BLOUB_SUFFIX.test(raw) || DATA_IMAGE.test(raw)
  );
}

export const BotAvatarValueSchema = z
  .string()
  .min(1)
  .max(BOT_AVATAR_VALUE_MAX_LENGTH)
  .refine(isBotAvatarValue, { message: "Invalid bot avatar" });
