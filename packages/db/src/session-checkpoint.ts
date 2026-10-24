import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "./client.js";

/**
 * RT-26 checkpoint contract.
 *
 * A native AgentScope pending state exists only for one Run and one Attempt:
 * the Attempt's chat admission fence and random suspension key are part of the
 * binding, the pending Intervention created by the pause carries the same
 * binding, and the Runtime must prove the shared session slot is clean or has
 * been detached into this checkpoint. The chat admission may then be released.
 */
export interface SessionCheckpointBinding {
  sessionKey: string;
  runId: string;
  attemptId: string;
  executionId: string;
  admissionFence: number;
  suspensionKey: string;
}

export interface SessionCheckpointResumeBinding {
  attemptId: string;
  executionId: string;
  admissionFence: number;
  suspensionKey: string;
}

export interface RuntimeCheckpointProof {
  kind: "clean" | "detached";
  checkpointId: string;
  digest: string;
  pendingCalls: Array<{ id?: string; name?: string; state?: string }>;
  runtimeInstanceId?: string;
}

export type CheckpointRow = {
  id: string;
  sessionKey: string;
  runId: string;
  attemptId: string;
  executionId: string;
  admissionFence: number;
  suspensionKey: string;
  threadGeneration: number;
  proofKind: string;
  digest: string;
  pendingCalls: Prisma.JsonValue;
  pendingInterventionId: string | null;
  coveredMessageSeq: number | null;
  status: string;
  detachedAt: Date;
  ackedAt: Date | null;
};

/** Deterministic id so a crash before the ack can retry the same Runtime snapshot. */
export function sessionCheckpointId(input: {
  runId: string;
  attemptId: string;
  admissionFence: number;
}): string {
  return `ckpt_${createHash("sha256")
    .update(`${input.runId}\u0000${input.attemptId}\u0000${input.admissionFence}`)
    .digest("hex")
    .slice(0, 40)}`;
}

function assertBinding(binding: SessionCheckpointBinding): void {
  if (
    !binding.sessionKey ||
    !binding.runId ||
    !binding.attemptId ||
    !binding.executionId ||
    !Number.isSafeInteger(binding.admissionFence) ||
    binding.admissionFence <= 0 ||
    !binding.suspensionKey
  ) {
    throw new Error("Session checkpoint binding is incomplete");
  }
}

function sameBinding(row: CheckpointRow, binding: SessionCheckpointBinding): boolean {
  return (
    row.sessionKey === binding.sessionKey &&
    row.runId === binding.runId &&
    row.attemptId === binding.attemptId &&
    row.executionId === binding.executionId &&
    row.admissionFence === binding.admissionFence &&
    row.suspensionKey === binding.suspensionKey
  );
}

function normalizePendingCalls(
  calls: RuntimeCheckpointProof["pendingCalls"],
): Array<{ id: string; name: string; state: string }> {
  if (!Array.isArray(calls) || calls.length > 200) {
    throw new Error("Runtime checkpoint proof is malformed");
  }
  return calls.map((call) => ({
    id: typeof call.id === "string" ? call.id.slice(0, 200) : "",
    name: typeof call.name === "string" ? call.name.slice(0, 200) : "tool",
    state: typeof call.state === "string" ? call.state.slice(0, 40) : "pending",
  }));
}

function validateProof(checkpointId: string, proof: RuntimeCheckpointProof): void {
  if (proof.checkpointId !== checkpointId) {
    throw new Error("Runtime detached a different checkpoint id");
  }
  if (proof.kind !== "clean" && proof.kind !== "detached") {
    throw new Error("Runtime returned an unsupported checkpoint proof");
  }
  if (!/^[0-9a-f]{64}$/.test(proof.digest)) {
    throw new Error("Runtime checkpoint digest is malformed");
  }
}

/**
 * Persist the Runtime proof under its exact execution binding. Repeating the
 * same proof is idempotent; any different digest or binding is a conflict and
 * must never replace an acknowledged checkpoint.
 */
export async function recordCheckpointProof(
  prisma: PrismaClient,
  input: {
    binding: SessionCheckpointBinding;
    proof: RuntimeCheckpointProof;
    threadGeneration: number;
    detachedAt?: Date;
  },
): Promise<CheckpointRow> {
  assertBinding(input.binding);
  const id = sessionCheckpointId(input.binding);
  validateProof(id, input.proof);
  const pendingCalls = normalizePendingCalls(input.proof.pendingCalls);
  const detachedAt = input.detachedAt ?? new Date();
  return prisma.$transaction(async (tx) => {
    const existing = await tx.agentSessionCheckpoint.findUnique({ where: { id } });
    if (existing) {
      if (
        !sameBinding(existing as CheckpointRow, input.binding) ||
        existing.proofKind !== input.proof.kind ||
        existing.digest !== input.proof.digest
      ) {
        throw new Error("Session checkpoint proof does not match its persisted binding");
      }
      return existing as CheckpointRow;
    }
    await tx.agentSessionCheckpoint.updateMany({
      where: {
        runId: input.binding.runId,
        status: "recorded",
        id: { not: id },
        // A clean probe from a crashed attempt must not retire the Run's real
        // detached checkpoint that is still waiting for its answer.
        OR: [{ proofKind: "clean" }, { proofKind: input.proof.kind }],
      },
      data: { status: "superseded" },
    });
    return (await tx.agentSessionCheckpoint.create({
      data: {
        id,
        sessionKey: input.binding.sessionKey,
        runId: input.binding.runId,
        attemptId: input.binding.attemptId,
        executionId: input.binding.executionId,
        admissionFence: input.binding.admissionFence,
        suspensionKey: input.binding.suspensionKey,
        threadGeneration: input.threadGeneration,
        proofKind: input.proof.kind,
        digest: input.proof.digest,
        pendingCalls: pendingCalls as Prisma.InputJsonValue,
        detachedAt,
      },
    })) as CheckpointRow;
  });
}

/**
 * Acknowledge the proof and bind the pending request that produced the pause.
 * Only an acknowledged checkpoint can release a suspended admission, and the
 * pending Intervention must have been created under the same Attempt, fence,
 * and suspension key. A crash before this commit leaves the owner unconfirmed.
 */
export async function acknowledgeSessionCheckpoint(
  prisma: PrismaClient,
  input: {
    binding: SessionCheckpointBinding;
    proof: RuntimeCheckpointProof;
    pendingInterventionId: string | null;
    coveredMessageSeq: number;
  },
): Promise<boolean> {
  assertBinding(input.binding);
  if (!Number.isSafeInteger(input.coveredMessageSeq) || input.coveredMessageSeq < -1) {
    throw new Error("Checkpoint message watermark is invalid");
  }
  const id = sessionCheckpointId(input.binding);
  validateProof(id, input.proof);
  return prisma.$transaction(async (tx) => {
    const row = (await tx.agentSessionCheckpoint.findUnique({
      where: { id },
    })) as CheckpointRow | null;
    if (!row || !sameBinding(row, input.binding)) return false;
    if (row.proofKind !== input.proof.kind || row.digest !== input.proof.digest) return false;
    if (row.ackedAt) return row.status === "recorded";
    if (row.status !== "recorded") return false;
    if (input.pendingInterventionId) {
      const intervention = await tx.intervention.findUnique({
        where: { id: input.pendingInterventionId },
        select: {
          runId: true,
          attemptId: true,
          executionFence: true,
          suspensionKey: true,
          status: true,
        },
      });
      if (
        !intervention ||
        intervention.runId !== input.binding.runId ||
        intervention.attemptId !== input.binding.attemptId ||
        intervention.executionFence !== input.binding.admissionFence ||
        intervention.suspensionKey !== input.binding.suspensionKey ||
        !["pending", "answered"].includes(intervention.status)
      ) {
        return false;
      }
    }
    const updated = await tx.agentSessionCheckpoint.updateMany({
      where: { id, status: "recorded", ackedAt: null },
      data: {
        ackedAt: new Date(),
        pendingInterventionId: input.pendingInterventionId,
        coveredMessageSeq: input.coveredMessageSeq,
      },
    });
    return updated.count === 1;
  });
}

export type ResumableCheckpoint = CheckpointRow & {
  intervention: {
    id: string;
    status: string;
    revision: number;
    decision: string | null;
    resolvedByUserId: string | null;
  } | null;
};

/**
 * Load the acknowledged, not-yet-consumed checkpoint of THIS Run. The Run id
 * is part of the query, so Run B can never observe or resume Run A's state.
 */
export async function findResumableCheckpoint(
  prisma: PrismaClient,
  input: { runId: string; sessionKey: string; threadGeneration: number },
): Promise<ResumableCheckpoint | null> {
  const row = (await prisma.agentSessionCheckpoint.findFirst({
    where: {
      runId: input.runId,
      sessionKey: input.sessionKey,
      threadGeneration: input.threadGeneration,
      status: "recorded",
      ackedAt: { not: null },
      proofKind: "detached",
    },
    orderBy: { detachedAt: "desc" },
  })) as CheckpointRow | null;
  if (!row) return null;
  const intervention = row.pendingInterventionId
    ? await prisma.intervention.findUnique({
        where: { id: row.pendingInterventionId },
        select: {
          id: true,
          status: true,
          revision: true,
          decision: true,
          resolvedByUserId: true,
        },
      })
    : null;
  return { ...row, intervention };
}

function answerDigestOf(answer: string | undefined): string | null {
  return answer === undefined ? null : createHash("sha256").update(answer).digest("hex");
}

export type BeginCheckpointResumeResult =
  | { kind: "started" | "replayed"; resumeId: string; checkpoint: ResumableCheckpoint }
  | { kind: "rejected"; reason: "missing" | "binding_conflict" | "decision_conflict" };

/**
 * Bind a restore to the NEW execution fence and suspension key. The decision
 * key (one answered card revision) and answer digest are unique, so a crash
 * that retries the same decision replaces only the transport binding instead
 * of applying a second answer.
 */
export async function beginCheckpointResume(
  prisma: PrismaClient,
  input: {
    checkpointId: string;
    runId: string;
    sessionKey: string;
    threadGeneration: number;
    resume: SessionCheckpointResumeBinding;
    decisionKey: string;
    decision?: Prisma.InputJsonValue;
    answer?: string;
  },
): Promise<BeginCheckpointResumeResult> {
  const { resume } = input;
  if (
    !input.decisionKey ||
    !resume.attemptId ||
    !resume.executionId ||
    !resume.suspensionKey ||
    !Number.isSafeInteger(resume.admissionFence) ||
    resume.admissionFence <= 0
  ) {
    return { kind: "rejected", reason: "binding_conflict" };
  }
  const result = await prisma.$transaction(async (tx) => {
    const checkpoint = (await tx.agentSessionCheckpoint.findUnique({
      where: { id: input.checkpointId },
      include: {
        resumes: { where: { decisionKey: input.decisionKey }, take: 1 },
      },
    })) as (CheckpointRow & { resumes: Array<Record<string, unknown>> }) | null;
    if (
      !checkpoint ||
      checkpoint.runId !== input.runId ||
      checkpoint.sessionKey !== input.sessionKey ||
      checkpoint.threadGeneration !== input.threadGeneration ||
      checkpoint.proofKind !== "detached" ||
      checkpoint.status !== "recorded" ||
      !checkpoint.ackedAt
    ) {
      return { kind: "rejected" as const, reason: "missing" as const };
    }
    const digest = answerDigestOf(input.answer);
    const previous = checkpoint.resumes?.[0] as
      | { id: string; executionId: string; answerDigest: string | null; status: string }
      | undefined;
    if (previous) {
      if (previous.answerDigest !== digest) {
        return { kind: "rejected" as const, reason: "decision_conflict" as const };
      }
      if (previous.executionId !== resume.executionId) {
        // A crashed attempt's prepared/restored binding is replaced by the new
        // execution; the single decision row keeps the answer idempotent.
        const rebound = await tx.agentSessionCheckpointResume.updateMany({
          where: {
            id: previous.id,
            decisionKey: input.decisionKey,
            answerDigest: digest,
            status: { in: ["prepared", "restored"] },
          },
          data: {
            attemptId: resume.attemptId,
            executionId: resume.executionId,
            fence: resume.admissionFence,
            suspensionKey: resume.suspensionKey,
            decision: input.decision,
            status: "prepared",
            restoredAt: null,
          },
        });
        if (rebound.count !== 1) {
          return { kind: "rejected" as const, reason: "binding_conflict" as const };
        }
        return { kind: "replayed" as const, resumeId: previous.id };
      }
      return { kind: "replayed" as const, resumeId: previous.id };
    }
    const created = await tx.agentSessionCheckpointResume.create({
      data: {
        checkpointId: checkpoint.id,
        runId: input.runId,
        attemptId: resume.attemptId,
        executionId: resume.executionId,
        fence: resume.admissionFence,
        suspensionKey: resume.suspensionKey,
        decisionKey: input.decisionKey,
        decision: input.decision,
        answerDigest: digest,
      },
      select: { id: true },
    });
    return { kind: "started" as const, resumeId: created.id };
  });
  if (result.kind === "rejected") return result;
  const checkpoint = await findResumableCheckpoint(prisma, {
    runId: input.runId,
    sessionKey: input.sessionKey,
    threadGeneration: input.threadGeneration,
  });
  if (!checkpoint || checkpoint.id !== input.checkpointId) {
    return { kind: "rejected", reason: "missing" };
  }
  return { kind: result.kind, resumeId: result.resumeId, checkpoint };
}

export async function markCheckpointResumeRestored(
  prisma: PrismaClient,
  input: { resumeId: string; executionId: string },
  now = new Date(),
): Promise<boolean> {
  const updated = await prisma.agentSessionCheckpointResume.updateMany({
    where: { id: input.resumeId, executionId: input.executionId, status: "prepared" },
    data: { status: "restored", restoredAt: now },
  });
  return updated.count === 1;
}

export async function markCheckpointResumeConsumed(
  prisma: PrismaClient,
  input: { resumeId: string; executionId: string },
  now = new Date(),
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const resume = await tx.agentSessionCheckpointResume.updateMany({
      where: {
        id: input.resumeId,
        executionId: input.executionId,
        status: { in: ["prepared", "restored"] },
      },
      data: { status: "consumed", consumedAt: now },
    });
    if (resume.count !== 1) return false;
    const row = await tx.agentSessionCheckpointResume.findUnique({
      where: { id: input.resumeId },
      select: { checkpointId: true },
    });
    if (!row) return false;
    await tx.agentSessionCheckpoint.updateMany({
      where: { id: row.checkpointId, status: "recorded" },
      data: { status: "consumed" },
    });
    return true;
  });
}

/**
 * Deterministic new-Thread context: trusted PostgreSQL messages appended while
 * this Run was suspended, excluding this Run's own ask/answer traffic. Ordered
 * by message sequence; the Runtime renders and caps them identically.
 */
export async function loadThreadContextAfterCheckpoint(
  prisma: PrismaClient,
  input: { threadId: string; afterSeq: number; excludeRunId: string; limit?: number },
): Promise<Array<{ seq: number; role: "user" | "assistant"; content: string }>> {
  const limit = Math.min(Math.max(input.limit ?? 40, 1), 100);
  const rows = await prisma.message.findMany({
    where: {
      threadId: input.threadId,
      seq: { gt: input.afterSeq },
      // RT-26 review (P2): production bot replies persist with role "bot"
      // (events.ts), so querying only user/assistant dropped the bot side of an
      // interleaved turn and the resumed Run saw the user side only. "bot" rows
      // are normalized to "assistant" below for the runtime contract; every
      // other role stays excluded.
      role: { in: ["user", "assistant", "bot"] },
      OR: [{ runId: null }, { runId: { not: input.excludeRunId } }],
    },
    orderBy: { seq: "asc" },
    take: limit,
    select: { seq: true, role: true, blocks: true },
  });
  return rows.flatMap((row) => {
    if (row.role !== "user" && row.role !== "assistant" && row.role !== "bot") return [];
    const content = messageText(row.blocks);
    if (!content) return [];
    return [{
      seq: row.seq,
      role: row.role === "bot" ? "assistant" as const : row.role as "user" | "assistant",
      content,
    }];
  });
}

function messageText(blocks: Prisma.JsonValue): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const value = block as { kind?: unknown; text?: unknown };
    if (value.kind === "text" && typeof value.text === "string" && value.text.trim()) {
      parts.push(value.text.trim());
    }
  }
  return parts.join("\n").slice(0, 4_000);
}
