import type { MessageReport, ThreadMessage } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";

const LABEL_MAX = 200;

function label(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > LABEL_MAX ? `${trimmed.slice(0, LABEL_MAX - 1)}…` : trimmed;
}

/**
 * Read-time projection of the delegated-work envelope. The delivery record only
 * stores which message carries the result; who sent it, from where, for which
 * work and to whom is resolved from Run → Task → Thread → Bot/User here, so the
 * envelope is never persisted. Anything that cannot be resolved is omitted
 * rather than invented.
 */
export async function attachReportEnvelopes<T extends ThreadMessage>(
  tx: Prisma.TransactionClient,
  messages: readonly T[],
): Promise<T[]> {
  if (messages.length === 0) return [...messages];
  const records = await tx.deliveryRecord.findMany({
    where: { resultMessageId: { in: messages.map((message) => message.id) } },
    select: { resultMessageId: true, status: true, runId: true, threadId: true },
  });
  if (records.length === 0) return [...messages];

  const sources = await tx.run.findMany({
    where: { id: { in: [...new Set(records.map((record) => record.runId))] } },
    select: {
      id: true,
      spaceId: true,
      botId: true,
      userId: true,
      trigger: true,
      originRunId: true,
      task: { select: { prompt: true } },
    },
  });
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  const originRunIds = sources.flatMap((source) =>
    source.originRunId ? [source.originRunId] : [],
  );
  const originRuns =
    originRunIds.length === 0
      ? []
      : await tx.run.findMany({
          where: { id: { in: originRunIds } },
          select: { id: true, botId: true },
        });
  const originBotByRun = new Map(originRuns.map((run) => [run.id, run.botId]));

  const threads = await tx.thread.findMany({
    where: { id: { in: [...new Set(records.map((record) => record.threadId))] } },
    select: {
      id: true,
      botId: true,
      group: { select: { name: true } },
      bot: { select: { name: true } },
    },
  });
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));

  const botIds = [
    ...new Set([
      ...sources.map((source) => source.botId),
      ...originBotByRun.values(),
      ...threads.flatMap((thread) => (thread.botId ? [thread.botId] : [])),
    ]),
  ];
  const bots = await tx.bot.findMany({
    where: { id: { in: botIds } },
    select: { id: true, name: true },
  });
  const botName = new Map(bots.map((bot) => [bot.id, bot.name]));

  const userSpace = new Map(sources.map((source) => [source.userId, source.spaceId] as const));
  const users = await tx.user.findMany({
    where: { id: { in: [...userSpace.keys()] } },
    select: { id: true, name: true },
  });
  const userName = new Map(users.map((user) => [user.id, user.name]));

  const recordsByMessage = new Map<string, typeof records>();
  for (const record of records) {
    if (!record.resultMessageId) continue;
    const list = recordsByMessage.get(record.resultMessageId) ?? [];
    list.push(record);
    recordsByMessage.set(record.resultMessageId, list);
  }
  const reportByMessage = new Map<string, MessageReport>();
  for (const [messageId, messageRecords] of recordsByMessage) {
    // A window-merged batch answers several source Runs from one message; no
    // single work title, executor or recipient is the truth for all of them.
    if (new Set(messageRecords.map((record) => record.runId)).size > 1) continue;
    const record = messageRecords[0]!;
    const source = sourceById.get(record.runId);
    const thread = threadById.get(record.threadId);
    if (!source || !thread) continue;
    const from = botName.get(source.botId);
    const room = thread.group?.name ?? (thread.botId ? botName.get(thread.botId) : undefined);
    const work = label(source.task?.prompt);
    const originBotId = source.originRunId ? originBotByRun.get(source.originRunId) : undefined;
    const originBot = originBotId ? botName.get(originBotId) : undefined;
    const dispatcher = originBot ? { kind: "bot" as const, name: originBot } : null;
    const humanDispatcher = userName.get(source.userId);
    const to =
      dispatcher ?? (humanDispatcher ? { kind: "user" as const, name: humanDispatcher } : null);
    if (!from || !room || !work || !to) continue;
    reportByMessage.set(messageId, {
      state: record.status === "failed" ? "failed" : "ok",
      from: { botId: source.botId, name: from },
      room,
      work,
      to,
    });
  }
  if (reportByMessage.size === 0) return [...messages];
  return messages.map((message) => {
    const report = reportByMessage.get(message.id);
    return report ? { ...message, report } : message;
  });
}
