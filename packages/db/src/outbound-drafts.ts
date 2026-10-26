import { createHash } from "node:crypto";
import {
  MAX_PRESENTATION_DETAIL_CHARS,
  OutboundDraftContentSchema,
  type OutboundDraftState,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { lockIntervention, lockInterventionThreads, lockRun } from "./locks.js";

/**
 * A10 outbound drafts.
 *
 * An approval Intervention backed by a `send_email` ExternalEffect is an
 * outbound draft card. Revision 1 is the effect's own request; every saved edit
 * appends an immutable `outbound_draft_revisions` row and moves the effect
 * request, so the approved replay sends exactly the content the user confirmed.
 */

export const OUTBOUND_EMAIL_EFFECT_KIND = "send_email";
const REVISION_META_LIMIT = 100;

export function outboundChannelForEffect(kind: string): "email" | null {
  return kind === OUTBOUND_EMAIL_EFFECT_KIND ? "email" : null;
}

export function outboundDraftFingerprint(content: {
  recipients: readonly string[];
  subject: string;
  body: string;
}): string {
  const canonical = JSON.stringify({
    recipients: content.recipients,
    subject: content.subject,
    body: content.body,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function outboundDraftContentFromEffectRequest(
  request: unknown,
): { recipients: string[]; subject: string; body: string } | null {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const record = request as Record<string, unknown>;
  const recipients = Array.isArray(record.to)
    ? record.to.filter((value): value is string => typeof value === "string")
    : typeof record.to === "string"
      ? [record.to]
      : [];
  const parsed = OutboundDraftContentSchema.safeParse({
    recipients,
    subject: record.subject,
    body: record.text,
  });
  return parsed.success ? parsed.data : null;
}

function revisionMeta(state: {
  revisions: Array<{ revision: number; fingerprint: string; subject: string; createdAt: string }>;
}): OutboundDraftState["revisions"] {
  const sorted = [...state.revisions].sort((a, b) => a.revision - b.revision);
  const latest = sorted[sorted.length - 1]?.revision ?? 0;
  return sorted.slice(-REVISION_META_LIMIT).map((entry) => ({
    revision: entry.revision,
    fingerprint: entry.fingerprint,
    subject: entry.subject,
    createdAt: entry.createdAt,
    status: entry.revision === latest ? ("pending" as const) : ("superseded" as const),
  }));
}

function buildState(
  effect: { id: string; kind: string; request: unknown; createdAt: Date },
  rows: Array<{
    revision: number;
    recipients: unknown;
    subject: string;
    body: string;
    fingerprint: string;
    createdAt: Date;
  }>,
): OutboundDraftState | null {
  const channel = outboundChannelForEffect(effect.kind);
  if (!channel) return null;
  const base = outboundDraftContentFromEffectRequest(effect.request);
  if (!base) return null;
  const sorted = [...rows].sort((a, b) => a.revision - b.revision);
  // Revision 1 is persisted before the first edit (the effect request is
  // mutable and follows the latest revision). Old rows without a stored r1
  // still fall back to the request as it was when this projection is built.
  const storedBase = sorted.find((row) => row.revision === 1);
  const revisions: Array<{
    revision: number;
    fingerprint: string;
    subject: string;
    createdAt: string;
    recipients?: unknown;
    body?: string;
  }> = [
    storedBase
      ? {
          revision: 1,
          fingerprint: storedBase.fingerprint,
          subject: storedBase.subject,
          createdAt: storedBase.createdAt.toISOString(),
          recipients: storedBase.recipients,
          body: storedBase.body,
        }
      : {
          revision: 1,
          fingerprint: outboundDraftFingerprint(base),
          subject: base.subject,
          createdAt: effect.createdAt.toISOString(),
          recipients: base.recipients,
          body: base.body,
        },
  ];
  for (const row of sorted) {
    if (row.revision <= 1) continue;
    revisions.push({
      revision: row.revision,
      fingerprint: row.fingerprint,
      subject: row.subject,
      createdAt: row.createdAt.toISOString(),
      recipients: row.recipients,
      body: row.body,
    });
  }
  const latest = revisions[revisions.length - 1]!;
  const parsedRecipients = Array.isArray(latest.recipients)
    ? latest.recipients.filter((value): value is string => typeof value === "string")
    : base.recipients;
  const draft = OutboundDraftContentSchema.safeParse({
    recipients: parsedRecipients,
    subject: latest.subject,
    body: latest.body,
  });
  if (!draft.success) return null;
  return {
    channel,
    draft: {
      revision: latest.revision,
      fingerprint: latest.fingerprint,
      ...draft.data,
    },
    revisions: revisionMeta({ revisions }),
  };
}

export interface OutboundEffectFact {
  id: string;
  kind: string;
  request: unknown;
  createdAt: Date;
}

/** Draft states for the approval Interventions in one page of messages. */
export async function loadOutboundDraftStates(
  tx: Prisma.TransactionClient,
  rows: readonly { id: string; effectId: string | null }[],
): Promise<Map<string, OutboundDraftState>> {
  const effectIds = [
    ...new Set(rows.map((row) => row.effectId).filter((id): id is string => !!id)),
  ];
  if (effectIds.length === 0) return new Map();
  const effects = await tx.externalEffect.findMany({
    where: { id: { in: effectIds } },
    select: { id: true, kind: true, request: true, createdAt: true },
  });
  const outboundEffects = effects.filter((effect) => outboundChannelForEffect(effect.kind));
  if (outboundEffects.length === 0) return new Map();
  const byEffectId = new Map(outboundEffects.map((effect) => [effect.id, effect]));
  const interventionIds = rows
    .filter((row) => (row.effectId ? byEffectId.has(row.effectId) : false))
    .map((row) => row.id);
  const revisions =
    interventionIds.length === 0
      ? []
      : await tx.outboundDraftRevision.findMany({
          where: { interventionId: { in: interventionIds } },
          orderBy: { revision: "asc" },
          select: {
            interventionId: true,
            revision: true,
            recipients: true,
            subject: true,
            body: true,
            fingerprint: true,
            createdAt: true,
          },
        });
  const byIntervention = new Map<string, typeof revisions>();
  for (const revision of revisions) {
    const list = byIntervention.get(revision.interventionId) ?? [];
    list.push(revision);
    byIntervention.set(revision.interventionId, list);
  }
  const states = new Map<string, OutboundDraftState>();
  for (const row of rows) {
    if (!row.effectId) continue;
    const effect = byEffectId.get(row.effectId);
    if (!effect) continue;
    const state = buildState(effect, byIntervention.get(row.id) ?? []);
    if (state) states.set(row.id, state);
  }
  return states;
}

/** `null` when the approval is not an outbound draft; otherwise the latest binding. */
export async function readOutboundDraftBinding(
  tx: Prisma.TransactionClient,
  input: { interventionId: string; effectId: string | null },
): Promise<{ revision: number; fingerprint: string } | null | "invalid"> {
  if (!input.effectId) return null;
  const effect = await tx.externalEffect.findUnique({
    where: { id: input.effectId },
    select: { id: true, kind: true, request: true, createdAt: true },
  });
  if (!effect || !outboundChannelForEffect(effect.kind)) return null;
  const rows = await tx.outboundDraftRevision.findMany({
    where: { interventionId: input.interventionId },
    orderBy: { revision: "asc" },
    select: {
      revision: true,
      recipients: true,
      subject: true,
      body: true,
      fingerprint: true,
      createdAt: true,
    },
  });
  const state = buildState(effect, rows);
  // A non-email request is simply not an outbound card. Once an edit row
  // exists, unreadable state is corruption and must fail closed.
  if (!state) return rows.length > 0 ? "invalid" : null;
  return { revision: state.draft.revision, fingerprint: state.draft.fingerprint };
}

export type OutboundDraftUpdateOutcome =
  | { outcome: "updated"; state: OutboundDraftState; threadId: string; seq: number }
  | { outcome: "rejected"; reason: "not_found" | "forbidden" | "conflict" };

class OutboundDraftConflictError extends Error {}

const OUTBOUND_DRAFT_TRANSACTION = { timeout: 20_000, maxWait: 20_000 } as const;

function approvalDetail(input: {
  recipients: readonly string[];
  subject: string;
  body: string;
}): string {
  return [`to: ${input.recipients.join(", ")}`, `subject: ${input.subject}`, `body: ${input.body}`]
    .join("\n")
    .slice(0, MAX_PRESENTATION_DETAIL_CHARS);
}

/**
 * Save an edit as a new immutable revision. The effect request moves with it so
 * the approved replay sends this exact content; the ask block and Intervention
 * presentation follow so gate-off and gate-on surfaces agree.
 */
export async function updateOutboundDraftRevision(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    threadId: string;
    userId: string;
    interventionId: string;
    expectedRevision: number;
    recipients: readonly string[];
    subject: string;
    body: string;
  },
): Promise<OutboundDraftUpdateOutcome> {
  try {
    return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const initial = await tx.intervention.findUnique({
        where: { id: input.interventionId },
        select: {
          id: true,
          spaceId: true,
          threadId: true,
          runId: true,
          kind: true,
          effectId: true,
        },
      });
      if (
        !initial ||
        initial.spaceId !== input.spaceId ||
        initial.threadId !== input.threadId ||
        !initial.effectId ||
        initial.kind !== "approval"
      ) {
        return { outcome: "rejected", reason: "not_found" } as const;
      }
      const initialRun = await tx.run.findFirst({
        where: { id: initial.runId, spaceId: input.spaceId },
        select: { userId: true, threadId: true },
      });
      if (!initialRun || initialRun.userId !== input.userId) {
        return { outcome: "rejected", reason: "forbidden" } as const;
      }
      // Same lock order as resolveInterventionInTransaction (Threads → Run →
      // Intervention), so an approval cannot settle the card between the pending
      // read and the effect write that follows.
      await lockInterventionThreads(tx, initialRun.threadId, initial.threadId);
      await lockRun(tx, initial.runId);
      await lockIntervention(tx, initial.id);
      const row = await tx.intervention.findUnique({ where: { id: initial.id } });
      if (!row || row.spaceId !== input.spaceId || row.threadId !== input.threadId) {
        return { outcome: "rejected", reason: "not_found" } as const;
      }
      if (!row.effectId || row.kind !== "approval") {
        return { outcome: "rejected", reason: "not_found" } as const;
      }
      const run = await tx.run.findFirst({
        where: { id: row.runId, spaceId: input.spaceId },
        select: { userId: true },
      });
      if (!run || run.userId !== input.userId) {
        return { outcome: "rejected", reason: "forbidden" } as const;
      }
      if (row.status !== "pending") {
        return { outcome: "rejected", reason: "conflict" } as const;
      }
      const effect = await tx.externalEffect.findUnique({
        where: { id: row.effectId },
        select: { id: true, kind: true, request: true, status: true, createdAt: true },
      });
      if (!effect || !outboundChannelForEffect(effect.kind)) {
        return { outcome: "rejected", reason: "not_found" } as const;
      }
      if (effect.status !== "intended") {
        return { outcome: "rejected", reason: "conflict" } as const;
      }
      const existing = await tx.outboundDraftRevision.findMany({
        where: { interventionId: row.id },
        orderBy: { revision: "asc" },
        select: {
          revision: true,
          recipients: true,
          subject: true,
          body: true,
          fingerprint: true,
          createdAt: true,
        },
      });
      const latestRevision = existing.reduce((max, row) => Math.max(max, row.revision), 1);
      if (latestRevision !== input.expectedRevision) {
        return { outcome: "rejected", reason: "conflict" } as const;
      }
      const content = OutboundDraftContentSchema.parse({
        recipients: input.recipients,
        subject: input.subject,
        body: input.body,
      });
      const fingerprint = outboundDraftFingerprint(content);
      const nextRevision = latestRevision + 1;
      try {
        // The effect request is about to move; snapshot the original as r1 first
        // so the immutable audit keeps every body the user could have confirmed.
        if (!existing.some((row) => row.revision === 1)) {
          const original = outboundDraftContentFromEffectRequest(effect.request);
          if (!original) return { outcome: "rejected", reason: "conflict" } as const;
          await tx.outboundDraftRevision.create({
            data: {
              interventionId: row.id,
              revision: 1,
              recipients: original.recipients as Prisma.InputJsonValue,
              subject: original.subject,
              body: original.body,
              fingerprint: outboundDraftFingerprint(original),
              createdAt: effect.createdAt,
            },
          });
        }
        await tx.outboundDraftRevision.create({
          data: {
            interventionId: row.id,
            revision: nextRevision,
            recipients: content.recipients as Prisma.InputJsonValue,
            subject: content.subject,
            body: content.body,
            fingerprint,
          },
        });
      } catch (error) {
        if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
          throw new OutboundDraftConflictError();
        }
        throw error;
      }
      const moved = await tx.externalEffect.updateMany({
        where: { id: effect.id, status: "intended" },
        data: {
          request: {
            to: [...content.recipients],
            subject: content.subject,
            text: content.body,
          } as Prisma.InputJsonValue,
        },
      });
      if (moved.count !== 1) throw new OutboundDraftConflictError();
      const detail = approvalDetail(content);
      const presentation =
        row.presentation && typeof row.presentation === "object" && !Array.isArray(row.presentation)
          ? { ...(row.presentation as Record<string, unknown>), detail }
          : { text: "", detail };
      const updated = await tx.intervention.updateMany({
        where: { id: row.id, status: "pending" },
        data: { presentation: presentation as Prisma.InputJsonValue },
      });
      if (updated.count !== 1) throw new OutboundDraftConflictError();
      // Realtime follows the message block: the pending card rides this message.
      let seq = 0;
      const message = await tx.message.findFirst({
        where: { id: row.messageId },
        select: { id: true, blocks: true },
      });
      if (message) {
        const blocks = Array.isArray(message.blocks) ? (message.blocks as unknown[]) : [];
        const nextBlocks = blocks.map((block) => {
          if (
            !block ||
            typeof block !== "object" ||
            (block as { kind?: unknown }).kind !== "ask" ||
            (block as { approvalEffectId?: unknown }).approvalEffectId !== effect.id
          ) {
            return block;
          }
          return { ...(block as Record<string, unknown>), detail };
        });
        await tx.message.update({
          where: { id: message.id },
          data: { blocks: nextBlocks as Prisma.InputJsonValue },
        });
        const event = await appendEventInTransaction(tx, {
          spaceId: row.spaceId,
          threadId: row.threadId,
          botId: row.botId,
          runId: row.runId,
          type: "thread.message.updated",
          payload: { messageId: message.id, role: "bot", blocks: nextBlocks },
        });
        seq = event.seq;
      }
      const rowsAfter = await tx.outboundDraftRevision.findMany({
        where: { interventionId: row.id },
        orderBy: { revision: "asc" },
        select: {
          revision: true,
          recipients: true,
          subject: true,
          body: true,
          fingerprint: true,
          createdAt: true,
        },
      });
      const state = buildState(
        {
          ...effect,
          request: { to: [...content.recipients], subject: content.subject, text: content.body },
        },
        rowsAfter,
      );
      if (!state) throw new OutboundDraftConflictError();
      return { outcome: "updated", state, threadId: row.threadId, seq } as const;
    }, OUTBOUND_DRAFT_TRANSACTION);
  } catch (error) {
    if (error instanceof OutboundDraftConflictError) {
      return { outcome: "rejected", reason: "conflict" };
    }
    throw error;
  }
}
