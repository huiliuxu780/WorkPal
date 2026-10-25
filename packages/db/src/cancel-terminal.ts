import { randomUUID } from "node:crypto";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import {
  type CancelledRunRow,
  type CancelRunsOptions,
  cancelRunsInTransaction,
} from "./cancel-runs.js";
import type { Prisma } from "./client.js";
import { appendEventInTransaction, continueReleasedSteeringInTransaction } from "./events.js";

/**
 * Server-side cancellation policy. Disposition is chosen by this table, never
 * by reading Run.error. `superseded` is not in the table: the call site must
 * pass migrate or retain.
 */
export const CANCEL_REASONS = [
  "user_stopped",
  "wait_timeout",
  "plan_rejected",
  "budget_cancelled",
  "budget_narrowed",
  "teaching_started",
  "member_removed",
  "group_archived",
  "bot_archived",
  "bot_deleted",
  "parent_cancelled",
  "routine_wake",
  "thread_cleared",
  "superseded",
] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

export type SteeringDisposition =
  | "delete"
  | "release_and_continue"
  | "retain_unhandled"
  | "migrate";

export type CancelTerminalPolicy = {
  reason: CancelReason;
  reportDelegationOutcome: boolean;
  steering: SteeringDisposition;
};

const FIXED_POLICIES = {
  user_stopped: { reason: "user_stopped", reportDelegationOutcome: false, steering: "delete" },
  wait_timeout: {
    reason: "wait_timeout",
    reportDelegationOutcome: true,
    steering: "release_and_continue",
  },
  plan_rejected: {
    reason: "plan_rejected",
    reportDelegationOutcome: true,
    steering: "release_and_continue",
  },
  budget_cancelled: {
    reason: "budget_cancelled",
    reportDelegationOutcome: true,
    steering: "release_and_continue",
  },
  budget_narrowed: {
    reason: "budget_narrowed",
    reportDelegationOutcome: true,
    steering: "release_and_continue",
  },
  teaching_started: {
    reason: "teaching_started",
    reportDelegationOutcome: true,
    steering: "release_and_continue",
  },
  member_removed: {
    reason: "member_removed",
    reportDelegationOutcome: true,
    steering: "retain_unhandled",
  },
  group_archived: {
    reason: "group_archived",
    reportDelegationOutcome: true,
    steering: "retain_unhandled",
  },
  bot_archived: {
    reason: "bot_archived",
    reportDelegationOutcome: true,
    steering: "retain_unhandled",
  },
  bot_deleted: {
    reason: "bot_deleted",
    reportDelegationOutcome: true,
    steering: "retain_unhandled",
  },
  parent_cancelled: {
    reason: "parent_cancelled",
    reportDelegationOutcome: true,
    steering: "retain_unhandled",
  },
  // The routine run is a different origin. Absorbing the fallback run's steering
  // into it would mix sources, so the call site keeps the message instead.
  routine_wake: {
    reason: "routine_wake",
    reportDelegationOutcome: true,
    steering: "retain_unhandled",
  },
  thread_cleared: {
    reason: "thread_cleared",
    reportDelegationOutcome: true,
    steering: "delete",
  },
} as const satisfies Record<Exclude<CancelReason, "superseded">, CancelTerminalPolicy>;

export type FixedCancelReason = keyof typeof FIXED_POLICIES;

export function isCancelReason(value: string): value is CancelReason {
  return (CANCEL_REASONS as readonly string[]).includes(value);
}

export function cancelPolicyFor(reason: FixedCancelReason): CancelTerminalPolicy {
  return FIXED_POLICIES[reason];
}

export function supersededCancelPolicy(
  choice:
    | { disposition: "migrate"; replacementRunId: string }
    | { disposition: "retain_unhandled" },
): CancelTerminalPolicy & { replacementRunId?: string } {
  if (choice.disposition === "migrate") {
    if (!choice.replacementRunId) {
      throw new Error("superseded migrate requires a replacement run");
    }
    return {
      reason: "superseded",
      reportDelegationOutcome: true,
      steering: "migrate",
      replacementRunId: choice.replacementRunId,
    };
  }
  return {
    reason: "superseded",
    reportDelegationOutcome: true,
    steering: "retain_unhandled",
  };
}

export function cancelEventPayload(
  policy: CancelTerminalPolicy,
  replacementRunId?: string,
): Record<string, unknown> {
  return {
    reason: policy.reason,
    reportDelegationOutcome: policy.reportDelegationOutcome,
    steering: policy.steering,
    ...(replacementRunId ? { replacementRunId } : {}),
  };
}

/** Product sentences are held until the prototype copy is confirmed. */
const CONFIRMED_CANCEL_OUTCOME_TEXT: Record<
  Exclude<CancelReason, "user_stopped">,
  string | null
> = {
  wait_timeout: null,
  plan_rejected: null,
  budget_cancelled: null,
  budget_narrowed: null,
  teaching_started: null,
  member_removed: null,
  group_archived: null,
  bot_archived: null,
  bot_deleted: null,
  parent_cancelled: null,
  routine_wake: null,
  thread_cleared: null,
  superseded: null,
};

const CONFIRMED_UNHANDLED_NOTICE_TEXT: Record<
  | "member_removed"
  | "group_archived"
  | "bot_archived"
  | "bot_deleted"
  | "superseded"
  | "parent_cancelled"
  | "routine_wake",
  string | null
> = {
  member_removed: null,
  group_archived: null,
  bot_archived: null,
  bot_deleted: null,
  superseded: null,
  parent_cancelled: null,
  routine_wake: null,
};

const VISIBLE_CANCEL_TEXT_FORBIDDEN =
  /\blease\b|\bfence\b|\battempt\b|\brevision\b|\bstack\b|\/users\/|\/tmp\/|node_modules|\.ts:\d+|error:/i;

export function assertCancelVisibleText(text: string): void {
  if (VISIBLE_CANCEL_TEXT_FORBIDDEN.test(text)) {
    throw new Error("Cancel text is not on the visible whitelist");
  }
}

export function confirmedCancelOutcomeText(reason: string): string | null {
  if (!isCancelReason(reason) || reason === "user_stopped") return null;
  const text = CONFIRMED_CANCEL_OUTCOME_TEXT[reason];
  if (text) assertCancelVisibleText(text);
  return text;
}

export function confirmedUnhandledNoticeText(reason: CancelReason): string | null {
  if (!(reason in CONFIRMED_UNHANDLED_NOTICE_TEXT)) return null;
  const text =
    CONFIRMED_UNHANDLED_NOTICE_TEXT[reason as keyof typeof CONFIRMED_UNHANDLED_NOTICE_TEXT];
  if (text) assertCancelVisibleText(text);
  return text;
}

export function reasonsReadyForCancelOutcome(): CancelReason[] {
  return (Object.entries(CONFIRMED_CANCEL_OUTCOME_TEXT) as Array<[CancelReason, string | null]>)
    .filter((entry): entry is [CancelReason, string] => entry[1] !== null)
    .map(([reason]) => reason);
}

export function delegationOutcomeKey(runId: string): string {
  return `auto-outcome:${runId}`;
}

export type CancelTerminalEffects = {
  callProvider?: () => void;
  callRuntime?: () => void;
};

export type ApplyCancelTerminalArgs = {
  policy: CancelTerminalPolicy;
  replacementRunId?: string;
  /** Today's Stop abandons every pending append in the conversation, not only rows on the run. */
  abandonThreadSteering?: { threadId: string; botIds: string[] };
  cancelOptions?: Omit<CancelRunsOptions, "cancelReason">;
  /** False when the caller appends run.cancelled itself. */
  appendEvents?: boolean;
  effects?: CancelTerminalEffects;
};

export type ApplyCancelTerminalResult = {
  rows: CancelledRunRow[];
  continuationRunIds: string[];
  eventSeq: number | null;
};

const ACTIVE = [...ACTIVE_RUN_STATUSES];

export async function applyCancelTerminalPolicy(
  tx: Prisma.TransactionClient,
  runs: ReadonlyArray<{ id: string; taskId: string }>,
  cancelledAt: Date,
  args: ApplyCancelTerminalArgs,
): Promise<ApplyCancelTerminalResult> {
  const policy = args.policy;
  if (policy.steering === "migrate" && !args.replacementRunId) {
    throw new Error("migrate requires a replacement run");
  }
  if (
    policy.reason === "superseded" &&
    policy.steering !== "migrate" &&
    policy.steering !== "retain_unhandled"
  ) {
    throw new Error("superseded must migrate or retain");
  }
  const rows = await cancelRunsInTransaction(tx, runs, cancelledAt, {
    ...args.cancelOptions,
    cancelReason: policy.reason,
  });
  if (rows.length === 0) {
    // Stop still abandons pending appends when nothing was running. Skipping
    // that left teaching-released steering for a later continuation.
    if (policy.steering === "delete" && args.abandonThreadSteering) {
      await tx.steeringMessage.deleteMany({
        where: {
          botId: { in: args.abandonThreadSteering.botIds },
          message: { threadId: args.abandonThreadSteering.threadId },
        },
      });
    }
    return { rows: [], continuationRunIds: [], eventSeq: null };
  }
  const ids = rows.map((run) => run.id);
  let eventSeq: number | null = null;
  if (args.appendEvents !== false) {
    for (const run of rows) {
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        type: "run.cancelled",
        payload: cancelEventPayload(policy, args.replacementRunId),
      });
      eventSeq = event.seq;
    }
  }
  const continuationRunIds = await disposeSteering(tx, rows, policy, args);
  if (policy.reportDelegationOutcome) await enqueueDelegationOutcomes(tx, ids, policy.reason);
  return { rows, continuationRunIds, eventSeq };
}

async function disposeSteering(
  tx: Prisma.TransactionClient,
  rows: readonly CancelledRunRow[],
  policy: CancelTerminalPolicy,
  args: ApplyCancelTerminalArgs,
): Promise<string[]> {
  const ids = rows.map((run) => run.id);
  if (policy.steering === "delete") {
    await tx.steeringMessage.deleteMany({ where: { runId: { in: ids } } });
    if (args.abandonThreadSteering) {
      await tx.steeringMessage.deleteMany({
        where: {
          botId: { in: args.abandonThreadSteering.botIds },
          message: { threadId: args.abandonThreadSteering.threadId },
        },
      });
    }
    return [];
  }
  if (policy.steering === "migrate") {
    return migrateOrRetain(tx, rows, args.replacementRunId!, policy.reason);
  }
  if (policy.steering === "retain_unhandled") {
    await retainUnhandled(tx, rows, policy.reason);
    return [];
  }
  await tx.steeringMessage.updateMany({
    where: { runId: { in: ids } },
    data: { runId: null, claimedAt: null },
  });
  const seen = new Set<string>();
  const continuationRunIds: string[] = [];
  for (const run of rows) {
    const key = `${run.threadId}:${run.botId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(await botMayContinueConversation(tx, run.botId, run.threadId))) continue;
    const continuationRunId = await continueReleasedSteeringInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
    });
    if (continuationRunId) continuationRunIds.push(continuationRunId);
  }
  return continuationRunIds;
}

async function migrateOrRetain(
  tx: Prisma.TransactionClient,
  rows: readonly CancelledRunRow[],
  replacementRunId: string,
  reason: CancelReason,
): Promise<string[]> {
  const replacement = await tx.run.findUnique({
    where: { id: replacementRunId },
    select: { id: true, botId: true, threadId: true, status: true },
  });
  const canReceive =
    replacement !== null && (ACTIVE as readonly string[]).includes(replacement.status);
  const movable = canReceive
    ? rows.filter((run) => run.botId === replacement.botId && run.threadId === replacement.threadId)
    : [];
  const held = rows.filter((run) => !movable.some((candidate) => candidate.id === run.id));
  if (movable.length > 0 && replacement) {
    await tx.steeringMessage.updateMany({
      where: { runId: { in: movable.map((run) => run.id) } },
      data: { runId: replacement.id, claimedAt: null },
    });
  }
  if (held.length > 0) await retainUnhandled(tx, held, reason);
  return [];
}

async function retainUnhandled(
  tx: Prisma.TransactionClient,
  rows: readonly CancelledRunRow[],
  reason: CancelReason,
): Promise<void> {
  const attached = await tx.steeringMessage.findMany({
    where: { runId: { in: rows.map((run) => run.id) } },
    select: { runId: true },
  });
  const withSteering = new Set(attached.map((row) => row.runId));
  const noticed = new Set<string>();
  for (const run of rows) {
    if (!withSteering.has(run.id)) continue;
    const key = `${run.threadId}:${run.botId}`;
    if (noticed.has(key)) continue;
    noticed.add(key);
    const already = await tx.event.findFirst({
      where: {
        threadId: run.threadId,
        type: "thread.meta",
        payload: { path: ["notice"], equals: "steering_unhandled" },
        AND: [{ payload: { path: ["botId"], equals: run.botId } }],
      },
      select: { id: true },
    });
    if (already) continue;
    await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "thread.meta",
      payload: {
        notice: "steering_unhandled",
        reason,
        botId: run.botId,
        runId: run.id,
      },
    });
    // The confirmed sentence is intentionally null until copy review.
    confirmedUnhandledNoticeText(reason);
  }
}

export async function botMayContinueConversation(
  tx: Prisma.TransactionClient,
  botId: string,
  threadId: string,
): Promise<boolean> {
  const bot = await tx.bot.findUnique({
    where: { id: botId },
    select: { archivedAt: true },
  });
  if (!bot || bot.archivedAt) return false;
  const teaching = await tx.taughtSkill.findFirst({
    where: { botId, status: { in: ["recording", "drafting"] } },
    select: { id: true },
  });
  if (teaching) return false;
  const thread = await tx.thread.findUnique({
    where: { id: threadId },
    select: { groupId: true, spaceId: true },
  });
  if (!thread) return false;
  if (!thread.groupId) return true;
  const group = await tx.chatGroup.findUnique({
    where: { id: thread.groupId },
    select: { archivedAt: true, kind: true },
  });
  if (!group || group.archivedAt) return false;
  if (group.kind !== "standard") return true;
  const member = await tx.chatGroupMember.findUnique({
    where: { groupId_botId: { groupId: thread.groupId, botId } },
    select: { id: true },
  });
  return member !== null;
}

/** After teaching ends, continue released steering or notice when the bot cannot run. */
export async function settleReleasedSteeringForBot(
  tx: Prisma.TransactionClient,
  botId: string,
): Promise<string[]> {
  const pending = await tx.steeringMessage.findMany({
    where: { botId, runId: null },
    select: {
      id: true,
      message: { select: { threadId: true } },
    },
  });
  const threadIds = [...new Set(pending.map((row) => row.message.threadId))];
  const continuationRunIds: string[] = [];
  for (const threadId of threadIds) {
    const thread = await tx.thread.findUnique({
      where: { id: threadId },
      select: { spaceId: true },
    });
    if (!thread) continue;
    if (await botMayContinueConversation(tx, botId, threadId)) {
      const continuationRunId = await continueReleasedSteeringInTransaction(tx, {
        spaceId: thread.spaceId,
        threadId,
        botId,
      });
      if (continuationRunId) continuationRunIds.push(continuationRunId);
      continue;
    }
    await tx.steeringMessage.deleteMany({
      where: { botId, runId: null, message: { threadId } },
    });
    const already = await tx.event.findFirst({
      where: {
        threadId,
        type: "thread.meta",
        payload: { path: ["notice"], equals: "steering_unhandled" },
        AND: [{ payload: { path: ["botId"], equals: botId } }],
      },
      select: { id: true },
    });
    if (!already) {
      await appendEventInTransaction(tx, {
        spaceId: thread.spaceId,
        threadId,
        botId,
        type: "thread.meta",
        payload: {
          notice: "steering_unhandled",
          reason: "teaching_started",
          botId,
        },
      });
    }
  }
  return continuationRunIds;
}

async function enqueueDelegationOutcomes(
  tx: Prisma.TransactionClient,
  runIds: readonly string[],
  reason: CancelReason,
): Promise<void> {
  const runs = await tx.run.findMany({
    where: { id: { in: [...runIds] }, trigger: "bot_message" },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      botId: true,
      threadId: true,
      sourceMessageId: true,
      originThreadId: true,
      originRunId: true,
      originMessageId: true,
      bot: { select: { name: true } },
    },
  });
  if (runs.length === 0) return;
  await tx.cancelOutcomeOutbox.createMany({
    data: runs.map((run) => ({
      id: randomUUID(),
      idempotencyKey: delegationOutcomeKey(run.id),
      runId: run.id,
      spaceId: run.spaceId,
      userId: run.userId,
      senderBotId: run.botId,
      senderName: run.bot.name,
      threadId: run.threadId,
      sourceMessageId: run.sourceMessageId,
      originThreadId: run.originThreadId,
      originRunId: run.originRunId,
      originMessageId: run.originMessageId,
      reason,
    })),
    skipDuplicates: true,
  });
}
