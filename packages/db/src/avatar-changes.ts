import {
  type AvatarCharacter,
  AvatarCharacterSchema,
  AvatarModeSchema,
  isBotAvatarValue,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

type Actor = { userId: string; spaceId: string };
export type AvatarChoice =
  | { avatarMode: "character"; avatarCharacter: AvatarCharacter }
  | { avatarMode: "upload"; color: string }
  | { avatarMode: "legacy"; color: string };

export class AvatarChangeDenied extends Error {}

function validateChoice(choice: AvatarChoice) {
  if (choice.avatarMode === "character") {
    if (!AvatarCharacterSchema.safeParse(choice.avatarCharacter).success)
      throw new AvatarChangeDenied("Invalid character");
  } else if (
    !isBotAvatarValue(choice.color) ||
    (choice.avatarMode === "upload") !== choice.color.startsWith("data:image/")
  ) {
    throw new AvatarChangeDenied("Invalid upload");
  }
}

async function lockedBot(tx: Prisma.TransactionClient, actor: Actor, botId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "bots"
    WHERE "id" = ${botId} AND "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId}
    FOR UPDATE
  `;
  if (!rows.length) throw new AvatarChangeDenied("Bot not found in this Space");
  return tx.bot.findUniqueOrThrow({ where: { id: botId } });
}

export function avatarChangeView(change: {
  id: string;
  botId: string;
  source: string;
  runId: string | null;
  beforeMode: string;
  beforeCharacter: string | null;
  afterMode: string;
  afterCharacter: string | null;
  createdAt: Date;
  undoneAt: Date | null;
}) {
  return {
    id: change.id,
    botId: change.botId,
    source: change.source as "user" | "bot",
    runId: change.runId,
    beforeMode: AvatarModeSchema.parse(change.beforeMode),
    beforeCharacter: AvatarCharacterSchema.nullable().parse(change.beforeCharacter),
    afterMode: AvatarModeSchema.parse(change.afterMode),
    afterCharacter: AvatarCharacterSchema.nullable().parse(change.afterCharacter),
    createdAt: change.createdAt.toISOString(),
    undoneAt: change.undoneAt?.toISOString() ?? null,
  };
}

/** All user and Bot writes pass through this lock, authorization and audit boundary. */
export async function changeBotAvatarInTransaction(
  tx: Prisma.TransactionClient,
  input: Actor & {
    botId: string;
    choice: AvatarChoice;
    source: "user" | "bot";
    runId?: string;
    operationKey?: string;
  },
) {
  validateChoice(input.choice);
  const bot = await lockedBot(tx, input, input.botId);
  if (input.operationKey) {
    const prior = await tx.botAvatarChange.findUnique({
      where: { operationKey: input.operationKey },
    });
    if (prior) {
      if (
        prior.botId !== bot.id ||
        prior.userId !== input.userId ||
        prior.spaceId !== input.spaceId ||
        prior.runId !== (input.runId ?? null)
      ) {
        throw new AvatarChangeDenied("Operation belongs to another Bot");
      }
      return prior;
    }
  }
  const nextColor = input.choice.avatarMode === "character" ? bot.color : input.choice.color;
  const nextCharacter =
    input.choice.avatarMode === "character" ? input.choice.avatarCharacter : null;
  if (
    bot.avatarMode === input.choice.avatarMode &&
    bot.avatarCharacter === nextCharacter &&
    bot.color === nextColor
  ) {
    return null;
  }
  await tx.bot.update({
    where: { id: bot.id },
    data: { avatarMode: input.choice.avatarMode, avatarCharacter: nextCharacter, color: nextColor },
  });
  const change = await tx.botAvatarChange.create({
    data: {
      botId: bot.id,
      userId: input.userId,
      spaceId: input.spaceId,
      source: input.source,
      runId: input.runId ?? null,
      operationKey: input.operationKey ?? null,
      beforeMode: bot.avatarMode,
      beforeCharacter: bot.avatarCharacter,
      beforeColor: bot.color,
      afterMode: input.choice.avatarMode,
      afterCharacter: nextCharacter,
      afterColor: nextColor,
    },
  });
  const older = await tx.botAvatarChange.findMany({
    where: { botId: bot.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: 50,
    select: { id: true },
  });
  if (older.length)
    await tx.botAvatarChange.deleteMany({ where: { id: { in: older.map((item) => item.id) } } });
  // Only the latest entry can be undone. Keep older provenance, not duplicate image bytes.
  await tx.botAvatarChange.updateMany({
    where: { botId: bot.id, id: { not: change.id } },
    data: { beforeColor: "", afterColor: "" },
  });
  return change;
}

export async function changeBotAvatar(
  prisma: PrismaClient,
  input: Parameters<typeof changeBotAvatarInTransaction>[1],
) {
  const change = await prisma.$transaction((tx) => changeBotAvatarInTransaction(tx, input));
  return change ? avatarChangeView(change) : null;
}

export async function listBotAvatarChanges(prisma: PrismaClient, actor: Actor, botId: string) {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, userId: actor.userId, spaceId: actor.spaceId },
    select: { id: true },
  });
  if (!bot) throw new AvatarChangeDenied("Bot not found in this Space");
  const changes = await prisma.botAvatarChange.findMany({
    where: { botId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: {
      id: true,
      botId: true,
      source: true,
      runId: true,
      beforeMode: true,
      beforeCharacter: true,
      afterMode: true,
      afterCharacter: true,
      createdAt: true,
      undoneAt: true,
    },
  });
  return changes.map(avatarChangeView);
}

export async function undoBotAvatarChange(prisma: PrismaClient, actor: Actor, changeId: string) {
  return prisma.$transaction(async (tx) => {
    const change = await tx.botAvatarChange.findFirst({
      where: { id: changeId, userId: actor.userId, spaceId: actor.spaceId },
    });
    if (!change) throw new AvatarChangeDenied("Avatar change not found");
    const bot = await lockedBot(tx, actor, change.botId);
    const latest = await tx.botAvatarChange.findFirst({
      where: { botId: bot.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (latest?.id !== change.id || change.undoneAt)
      throw new AvatarChangeDenied("Only the latest avatar change can be undone");
    if (
      bot.avatarMode !== change.afterMode ||
      bot.avatarCharacter !== change.afterCharacter ||
      bot.color !== change.afterColor
    ) {
      throw new AvatarChangeDenied("Avatar changed again; refresh before undoing");
    }
    await tx.bot.update({
      where: { id: bot.id },
      data: {
        avatarMode: change.beforeMode,
        avatarCharacter: change.beforeCharacter,
        color: change.beforeColor,
      },
    });
    const updated = await tx.botAvatarChange.update({
      where: { id: change.id },
      data: { undoneAt: new Date(), beforeColor: "", afterColor: "" },
    });
    return avatarChangeView(updated);
  });
}
