import { agentScopeChatSessionKey } from "@rakazo/core/node/session-admission";
import type { Prisma, PrismaClient } from "./client.js";

export { agentScopeChatSessionKey } from "@rakazo/core/node/session-admission";

const DEFAULT_ADMISSION_TTL_MS = 5 * 60_000;

export interface SessionAdmissionIdentity {
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  threadGeneration: number;
  runId: string;
  executionId: string;
  runLeaseOwner: string;
  runLeaseFence: number;
}

export interface SessionAdmissionLease {
  kind: "acquired";
  sessionKey: string;
  runId: string;
  executionId: string;
  admissionFence: number;
  expiresAt: Date;
}

export type SessionAdmissionAcquireResult =
  | SessionAdmissionLease
  | {
      kind: "queued" | "recovering";
      sessionKey: string;
      ownerRunId: string | null;
    };

export type SessionAdmissionReleaseResult =
  | { kind: "released"; nextRunId: string | null }
  | { kind: "stale" };

type AdmissionRow = {
  sessionKey: string;
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  threadGeneration: number;
  scope: string;
  state: "available" | "owned" | "recovering";
  ownerRunId: string | null;
  ownerAttemptId: string | null;
  ownerExecutionId: string | null;
  ownerRunLeaseOwner: string | null;
  ownerRunLeaseFence: number | null;
  fence: number;
  suspensionKey: string | null;
  acquiredAt: Date | null;
  expiresAt: Date | null;
  heartbeatAt: Date | null;
  executionPreparedAt: Date | null;
  runtimeStartedAt: Date | null;
};

type RequestRow = {
  position: bigint;
  sessionKey: string;
  runId: string;
  executionId: string;
  state: "queued" | "owned" | "recovering" | "released";
};

function expiresFrom(now: Date, ttlMs: number): Date {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("Session admission TTL must be a positive safe integer");
  }
  return new Date(now.getTime() + ttlMs);
}

async function lockAdmission(
  tx: Prisma.TransactionClient,
  sessionKey: string,
): Promise<AdmissionRow> {
  const rows = await tx.$queryRaw<AdmissionRow[]>`
    SELECT * FROM "agent_session_admissions"
    WHERE "sessionKey" = ${sessionKey}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new Error("Session admission row disappeared while acquiring its lock");
  return row;
}

function assertMatchingIdentity(row: AdmissionRow, input: SessionAdmissionIdentity): void {
  if (
    row.userId !== input.userId ||
    row.spaceId !== input.spaceId ||
    row.botId !== input.botId ||
    row.threadId !== input.threadId ||
    row.threadGeneration !== input.threadGeneration ||
    row.scope !== "chat"
  ) {
    throw new Error("Session admission key resolves to a different chat identity");
  }
}

async function insertAndReadRequest(
  tx: Prisma.TransactionClient,
  input: SessionAdmissionIdentity,
  sessionKey: string,
): Promise<RequestRow> {
  const exactRows = await tx.$queryRaw<RequestRow[]>`
    SELECT "position", "sessionKey", "runId", "executionId", "state"
    FROM "agent_session_admission_requests"
    WHERE "executionId" = ${input.executionId}
    FOR UPDATE
  `;
  let request = exactRows[0];
  if (!request) {
    const queuedRows = await tx.$queryRaw<RequestRow[]>`
      SELECT "position", "sessionKey", "runId", "executionId", "state"
      FROM "agent_session_admission_requests"
      WHERE "sessionKey" = ${sessionKey}
        AND "runId" = ${input.runId}
        AND "state" = 'queued'
      ORDER BY "position" ASC
      LIMIT 1
      FOR UPDATE
    `;
    const queued = queuedRows[0];
    if (queued) {
      await tx.$executeRaw`
        UPDATE "agent_session_admission_requests"
        SET "executionId" = ${input.executionId}, "updatedAt" = now()
        WHERE "position" = ${queued.position} AND "state" = 'queued'
      `;
      request = { ...queued, executionId: input.executionId };
    }
  }
  if (!request) {
    await tx.$executeRaw`
      INSERT INTO "agent_session_admission_requests"
        ("sessionKey", "runId", "executionId", "state", "queuedAt", "updatedAt")
      VALUES (${sessionKey}, ${input.runId}, ${input.executionId}, 'queued', now(), now())
      ON CONFLICT ("executionId") DO NOTHING
    `;
    const insertedRows = await tx.$queryRaw<RequestRow[]>`
      SELECT "position", "sessionKey", "runId", "executionId", "state"
      FROM "agent_session_admission_requests"
      WHERE "executionId" = ${input.executionId}
      FOR UPDATE
    `;
    request = insertedRows[0];
  }
  if (!request) throw new Error("Session admission request was not persisted");
  if (request.sessionKey !== sessionKey || request.runId !== input.runId) {
    throw new Error("Session admission execution identity was reused for a different Run");
  }
  return request;
}

async function firstQueuedRequest(
  tx: Prisma.TransactionClient,
  sessionKey: string,
): Promise<RequestRow | null> {
  await tx.$executeRaw`
    UPDATE "agent_session_admission_requests" request
    SET "state" = 'released', "updatedAt" = now()
    FROM "runs" run
    WHERE request."sessionKey" = ${sessionKey}
      AND request."state" = 'queued'
      AND run."id" = request."runId"
      AND run."status" IN ('completed', 'failed', 'cancelled')
  `;
  const rows = await tx.$queryRaw<RequestRow[]>`
    SELECT "position", "sessionKey", "runId", "executionId", "state"
    FROM "agent_session_admission_requests"
    WHERE "sessionKey" = ${sessionKey} AND "state" = 'queued'
    ORDER BY "position" ASC
    LIMIT 1
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function parkRunForRecovery(
  tx: Prisma.TransactionClient,
  row: AdmissionRow,
  reason: string,
  now: Date,
): Promise<void> {
  if (!row.ownerRunId || !row.ownerExecutionId) return;
  await tx.$executeRaw`
    UPDATE "agent_session_admissions"
    SET "state" = 'recovering', "updatedAt" = ${now}
    WHERE "sessionKey" = ${row.sessionKey}
      AND "state" = 'owned'
      AND "ownerRunId" = ${row.ownerRunId}
      AND "ownerExecutionId" = ${row.ownerExecutionId}
      AND "fence" = ${row.fence}
  `;
  await tx.$executeRaw`
    UPDATE "agent_session_admission_requests"
    SET "state" = 'recovering', "updatedAt" = ${now}
    WHERE "executionId" = ${row.ownerExecutionId} AND "state" = 'owned'
  `;
  if (!row.ownerRunLeaseOwner || row.ownerRunLeaseFence === null) return;
  const run = await tx.run.findFirst({
    where: {
      id: row.ownerRunId,
      status: { in: ["leased", "running"] },
      leaseOwner: row.ownerRunLeaseOwner,
      leaseFence: row.ownerRunLeaseFence,
    },
    select: { id: true, taskId: true },
  });
  if (!run) return;
  const parked = await tx.run.updateMany({
    where: {
      id: run.id,
      status: { in: ["leased", "running"] },
      leaseOwner: row.ownerRunLeaseOwner,
      leaseFence: row.ownerRunLeaseFence,
    },
    data: {
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      retryAt: null,
      error: null,
    },
  });
  if (parked.count !== 1) return;
  if (row.ownerAttemptId) {
    await tx.attempt.updateMany({
      where: { id: row.ownerAttemptId, runId: run.id, status: "running" },
      data: { status: "interrupted", error: reason, finishedAt: now },
    });
  }
  await tx.task.updateMany({
    where: { id: run.taskId, status: { in: ["leased", "running"] } },
    data: { status: "queued" },
  });
}

export async function acquireSessionAdmission(
  prisma: PrismaClient,
  input: SessionAdmissionIdentity,
  options: { now?: Date; ttlMs?: number } = {},
): Promise<SessionAdmissionAcquireResult> {
  const now = options.now ?? new Date();
  const expiresAt = expiresFrom(now, options.ttlMs ?? DEFAULT_ADMISSION_TTL_MS);
  const sessionKey = agentScopeChatSessionKey(input);
  return prisma.$transaction(async (tx) => {
    // A row lock cannot protect a resource row that does not exist yet. Serialize
    // first creation by canonical key so concurrent speculative inserts cannot
    // deadlock across the PK and composite identity unique indexes.
    await tx.$queryRaw`
      WITH session_lock AS (
        SELECT pg_advisory_xact_lock(hashtextextended(${sessionKey}, 0))
      )
      SELECT 1::int AS "locked" FROM session_lock
    `;
    await tx.$executeRaw`
      INSERT INTO "agent_session_admissions"
        ("sessionKey", "userId", "spaceId", "botId", "threadId", "threadGeneration",
         "scope", "state", "createdAt", "updatedAt")
      VALUES (${sessionKey}, ${input.userId}, ${input.spaceId}, ${input.botId}, ${input.threadId},
        ${input.threadGeneration}, 'chat', 'available', ${now}, ${now})
      ON CONFLICT ("sessionKey") DO NOTHING
    `;
    let row = await lockAdmission(tx, sessionKey);
    assertMatchingIdentity(row, input);
    const request = await insertAndReadRequest(tx, input, sessionKey);

    if (
      row.state === "owned" &&
      row.ownerRunId === input.runId &&
      row.ownerExecutionId === input.executionId &&
      row.ownerRunLeaseOwner === input.runLeaseOwner &&
      row.ownerRunLeaseFence === input.runLeaseFence
    ) {
      if (!row.expiresAt) throw new Error("Owned session admission is missing its expiry");
      return {
        kind: "acquired",
        sessionKey,
        runId: input.runId,
        executionId: input.executionId,
        admissionFence: row.fence,
        expiresAt: row.expiresAt,
      };
    }

    if (row.state === "owned" && row.expiresAt && row.expiresAt <= now) {
      await parkRunForRecovery(tx, row, "session_admission_expired", now);
      row = { ...row, state: "recovering" };
    }
    if (row.state === "recovering") {
      return { kind: "recovering", sessionKey, ownerRunId: row.ownerRunId };
    }
    if (
      row.state === "owned" &&
      row.ownerRunId === input.runId &&
      row.ownerRunLeaseFence !== null &&
      input.runLeaseFence > row.ownerRunLeaseFence
    ) {
      const nextFence = row.fence + 1;
      await tx.$executeRaw`
        UPDATE "agent_session_admissions"
        SET "ownerAttemptId" = NULL,
            "ownerExecutionId" = ${input.executionId},
            "ownerRunLeaseOwner" = ${input.runLeaseOwner},
            "ownerRunLeaseFence" = ${input.runLeaseFence},
            "fence" = ${nextFence},
            "suspensionKey" = NULL,
            "acquiredAt" = ${now},
            "expiresAt" = ${expiresAt},
            "heartbeatAt" = ${now},
            "executionPreparedAt" = NULL,
            "runtimeStartedAt" = NULL,
            "lastReleaseReason" = NULL,
            "updatedAt" = ${now}
        WHERE "sessionKey" = ${sessionKey}
          AND "state" = 'owned'
          AND "ownerRunId" = ${input.runId}
          AND "ownerExecutionId" = ${row.ownerExecutionId}
          AND "fence" = ${row.fence}
      `;
      await tx.$executeRaw`
        UPDATE "agent_session_admission_requests"
        SET "state" = 'released', "updatedAt" = ${now}
        WHERE "executionId" = ${row.ownerExecutionId} AND "state" = 'owned'
      `;
      await tx.$executeRaw`
        UPDATE "agent_session_admission_requests"
        SET "state" = 'owned', "updatedAt" = ${now}
        WHERE "executionId" = ${input.executionId} AND "state" = 'queued'
      `;
      return {
        kind: "acquired",
        sessionKey,
        runId: input.runId,
        executionId: input.executionId,
        admissionFence: nextFence,
        expiresAt,
      };
    }
    if (row.state === "owned") {
      return { kind: "queued", sessionKey, ownerRunId: row.ownerRunId };
    }
    if (request.state === "released") {
      return { kind: "queued", sessionKey, ownerRunId: row.ownerRunId };
    }
    const first = await firstQueuedRequest(tx, sessionKey);
    if (!first || first.executionId !== input.executionId) {
      return { kind: "queued", sessionKey, ownerRunId: row.ownerRunId };
    }
    const nextFence = row.fence + 1;
    await tx.$executeRaw`
      UPDATE "agent_session_admissions"
      SET "state" = 'owned',
          "ownerRunId" = ${input.runId},
          "ownerAttemptId" = NULL,
          "ownerExecutionId" = ${input.executionId},
          "ownerRunLeaseOwner" = ${input.runLeaseOwner},
          "ownerRunLeaseFence" = ${input.runLeaseFence},
          "fence" = ${nextFence},
          "suspensionKey" = NULL,
          "acquiredAt" = ${now},
          "expiresAt" = ${expiresAt},
          "heartbeatAt" = ${now},
          "executionPreparedAt" = NULL,
          "runtimeStartedAt" = NULL,
          "lastReleaseReason" = NULL,
          "updatedAt" = ${now}
      WHERE "sessionKey" = ${sessionKey} AND "state" = 'available'
    `;
    await tx.$executeRaw`
      UPDATE "agent_session_admission_requests"
      SET "state" = 'owned', "updatedAt" = ${now}
      WHERE "executionId" = ${input.executionId} AND "state" = 'queued'
    `;
    return {
      kind: "acquired",
      sessionKey,
      runId: input.runId,
      executionId: input.executionId,
      admissionFence: nextFence,
      expiresAt,
    };
  });
}

export async function renewSessionAdmission(
  prisma: PrismaClient,
  lease: SessionAdmissionLease,
  options: { now?: Date; ttlMs?: number } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const expiresAt = expiresFrom(now, options.ttlMs ?? DEFAULT_ADMISSION_TTL_MS);
  const updated = await prisma.$executeRaw`
    UPDATE "agent_session_admissions"
    SET "heartbeatAt" = ${now}, "expiresAt" = ${expiresAt}, "updatedAt" = ${now}
    WHERE "sessionKey" = ${lease.sessionKey}
      AND "state" = 'owned'
      AND "ownerRunId" = ${lease.runId}
      AND "ownerExecutionId" = ${lease.executionId}
      AND "fence" = ${lease.admissionFence}
      AND "expiresAt" > ${now}
  `;
  return updated === 1;
}

export async function prepareSessionExecution(
  prisma: PrismaClient,
  input: SessionAdmissionLease & { attemptId: string; suspensionKey: string },
  now = new Date(),
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const row = await lockAdmission(tx, input.sessionKey);
    if (
      row.state !== "owned" ||
      row.ownerRunId !== input.runId ||
      row.ownerExecutionId !== input.executionId ||
      row.fence !== input.admissionFence ||
      !row.expiresAt ||
      row.expiresAt <= now
    ) {
      return false;
    }
    if (
      (row.ownerAttemptId !== null && row.ownerAttemptId !== input.attemptId) ||
      (row.suspensionKey !== null && row.suspensionKey !== input.suspensionKey)
    ) {
      return false;
    }
    await tx.$executeRaw`
      UPDATE "agent_session_admissions"
      SET "ownerAttemptId" = ${input.attemptId},
          "suspensionKey" = ${input.suspensionKey},
          "executionPreparedAt" = COALESCE("executionPreparedAt", ${now}),
          "updatedAt" = ${now}
      WHERE "sessionKey" = ${input.sessionKey}
    `;
    return true;
  });
}

export async function markSessionRuntimeStarted(
  prisma: PrismaClient,
  input: SessionAdmissionLease & { attemptId: string; suspensionKey: string },
  now = new Date(),
): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "agent_session_admissions"
    SET "runtimeStartedAt" = COALESCE("runtimeStartedAt", ${now}), "updatedAt" = ${now}
    WHERE "sessionKey" = ${input.sessionKey}
      AND "state" = 'owned'
      AND "ownerRunId" = ${input.runId}
      AND "ownerExecutionId" = ${input.executionId}
      AND "ownerAttemptId" = ${input.attemptId}
      AND "suspensionKey" = ${input.suspensionKey}
      AND "fence" = ${input.admissionFence}
      AND "expiresAt" > ${now}
  `;
  return updated === 1;
}

async function release(
  prisma: PrismaClient,
  lease: SessionAdmissionLease,
  reason: string,
  now: Date,
): Promise<SessionAdmissionReleaseResult> {
  return prisma.$transaction(async (tx) => {
    const row = await lockAdmission(tx, lease.sessionKey);
    const exactOwner =
      row.ownerRunId === lease.runId &&
      row.ownerExecutionId === lease.executionId &&
      row.fence === lease.admissionFence;
    if (row.state === "available" && exactOwner) {
      const next = await firstQueuedRequest(tx, lease.sessionKey);
      return { kind: "released", nextRunId: next?.runId ?? null };
    }
    if (row.state !== "owned" || !exactOwner) return { kind: "stale" };
    await tx.$executeRaw`
      UPDATE "agent_session_admissions"
      SET "state" = 'available',
          "expiresAt" = NULL,
          "lastReleaseReason" = ${reason},
          "updatedAt" = ${now}
      WHERE "sessionKey" = ${lease.sessionKey}
        AND "state" = 'owned'
        AND "ownerRunId" = ${lease.runId}
        AND "ownerExecutionId" = ${lease.executionId}
        AND "fence" = ${lease.admissionFence}
    `;
    await tx.$executeRaw`
      UPDATE "agent_session_admission_requests"
      SET "state" = 'released', "updatedAt" = ${now}
      WHERE "executionId" = ${lease.executionId} AND "state" = 'owned'
    `;
    const next = await firstQueuedRequest(tx, lease.sessionKey);
    return { kind: "released", nextRunId: next?.runId ?? null };
  });
}

export function releaseSessionAdmission(
  prisma: PrismaClient,
  lease: SessionAdmissionLease,
  now = new Date(),
): Promise<SessionAdmissionReleaseResult> {
  return release(prisma, lease, "released", now);
}

export function completeSessionAdmission(
  prisma: PrismaClient,
  lease: SessionAdmissionLease,
  now = new Date(),
): Promise<SessionAdmissionReleaseResult> {
  return release(prisma, lease, "completed", now);
}

export async function markSessionAdmissionRecovering(
  prisma: PrismaClient,
  lease: SessionAdmissionLease,
  reason: string,
  now = new Date(),
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const row = await lockAdmission(tx, lease.sessionKey);
    if (
      row.state === "recovering" &&
      row.ownerRunId === lease.runId &&
      row.ownerExecutionId === lease.executionId &&
      row.fence === lease.admissionFence
    ) {
      return true;
    }
    if (
      row.state !== "owned" ||
      row.ownerRunId !== lease.runId ||
      row.ownerExecutionId !== lease.executionId ||
      row.fence !== lease.admissionFence
    ) {
      return false;
    }
    await parkRunForRecovery(tx, row, reason, now);
    return true;
  });
}

export async function recoverExpiredSessionAdmissions(
  prisma: PrismaClient,
  now = new Date(),
  limit = 100,
): Promise<Array<{ sessionKey: string; runId: string }>> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<AdmissionRow[]>`
      SELECT * FROM "agent_session_admissions"
      WHERE "state" = 'owned' AND "expiresAt" <= ${now}
      ORDER BY "expiresAt" ASC, "sessionKey" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    const recovered: Array<{ sessionKey: string; runId: string }> = [];
    for (const row of rows) {
      await parkRunForRecovery(tx, row, "session_admission_expired", now);
      if (row.ownerRunId) recovered.push({ sessionKey: row.sessionKey, runId: row.ownerRunId });
    }
    return recovered;
  });
}

export async function requeueExpiredSessionAdmissionWaiter(
  prisma: PrismaClient,
  input: {
    sessionKey: string;
    runId: string;
    executionId: string;
    runLeaseOwner: string;
    runLeaseFence: number;
  },
  now = new Date(),
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockAdmission(tx, input.sessionKey);
    const requests = await tx.$queryRaw<RequestRow[]>`
      SELECT "position", "sessionKey", "runId", "executionId", "state"
      FROM "agent_session_admission_requests"
      WHERE "sessionKey" = ${input.sessionKey}
        AND "runId" = ${input.runId}
        AND "executionId" = ${input.executionId}
      FOR UPDATE
    `;
    if (requests[0]?.state !== "queued") return false;
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        status: "leased",
        leaseOwner: input.runLeaseOwner,
        leaseFence: input.runLeaseFence,
        leaseExpiresAt: { lte: now },
      },
      select: { id: true, taskId: true },
    });
    if (!run) return false;
    const activeAttempt = await tx.attempt.findFirst({
      where: { runId: run.id, fence: input.runLeaseFence, status: "running" },
      select: { id: true },
    });
    if (activeAttempt) return false;
    const requeued = await tx.run.updateMany({
      where: {
        id: run.id,
        status: "leased",
        leaseOwner: input.runLeaseOwner,
        leaseFence: input.runLeaseFence,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        retryAt: null,
        error: null,
      },
    });
    if (requeued.count !== 1) return false;
    await tx.task.updateMany({
      where: { id: run.taskId, status: { in: ["leased", "running"] } },
      data: { status: "queued" },
    });
    return true;
  });
}

/** A Runtime proof that may authorize releasing a suspended owner. */
export interface SessionCheckpointProofRef {
  kind: "clean" | "detached";
  checkpointId: string;
  digest: string;
}

export type SuspendedReleaseResult =
  | { kind: "released"; nextRunId: string | null }
  | { kind: "stale" }
  | { kind: "unconfirmed" };

async function checkpointProvesCleanOrDetached(
  tx: Prisma.TransactionClient,
  input: {
    sessionKey: string;
    runId: string;
    executionId: string;
    fence: number;
    suspensionKey?: string;
    proof: SessionCheckpointProofRef;
  },
): Promise<boolean> {
  const checkpoint = await tx.agentSessionCheckpoint.findUnique({
    where: { id: input.proof.checkpointId },
    select: {
      sessionKey: true,
      runId: true,
      executionId: true,
      admissionFence: true,
      suspensionKey: true,
      proofKind: true,
      digest: true,
      status: true,
      ackedAt: true,
    },
  });
  return Boolean(
    checkpoint &&
      checkpoint.sessionKey === input.sessionKey &&
      checkpoint.runId === input.runId &&
      checkpoint.executionId === input.executionId &&
      checkpoint.admissionFence === input.fence &&
      (input.suspensionKey === undefined || checkpoint.suspensionKey === input.suspensionKey) &&
      checkpoint.proofKind === input.proof.kind &&
      checkpoint.digest === input.proof.digest &&
      checkpoint.status === "recorded" &&
      checkpoint.ackedAt,
  );
}

async function releaseOwnedWithProof(
  tx: Prisma.TransactionClient,
  lease: SessionAdmissionLease,
  proof: SessionCheckpointProofRef,
  reason: string,
  now: Date,
): Promise<SuspendedReleaseResult> {
  const row = await lockAdmission(tx, lease.sessionKey);
  if (row.state === "available" && row.ownerRunId === lease.runId) {
    const next = await firstQueuedRequest(tx, lease.sessionKey);
    return { kind: "released", nextRunId: next?.runId ?? null };
  }
  if (
    row.state !== "owned" ||
    row.ownerRunId !== lease.runId ||
    row.ownerExecutionId !== lease.executionId ||
    row.fence !== lease.admissionFence
  ) {
    return { kind: "stale" };
  }
  const proven = await checkpointProvesCleanOrDetached(tx, {
    sessionKey: lease.sessionKey,
    runId: lease.runId,
    executionId: lease.executionId,
    fence: lease.admissionFence,
    proof,
  });
  if (!proven) return { kind: "unconfirmed" };
  const updated = await tx.$executeRaw`
    UPDATE "agent_session_admissions"
    SET "state" = 'available',
        "expiresAt" = NULL,
        "lastReleaseReason" = ${reason},
        "updatedAt" = ${now}
    WHERE "sessionKey" = ${lease.sessionKey}
      AND "state" = 'owned'
      AND "ownerRunId" = ${lease.runId}
      AND "ownerExecutionId" = ${lease.executionId}
      AND "fence" = ${lease.admissionFence}
  `;
  if (updated !== 1) return { kind: "stale" };
  await tx.$executeRaw`
    UPDATE "agent_session_admission_requests"
    SET "state" = 'released', "updatedAt" = ${now}
    WHERE "executionId" = ${lease.executionId} AND "state" = 'owned'
  `;
  const next = await firstQueuedRequest(tx, lease.sessionKey);
  return { kind: "released", nextRunId: next?.runId ?? null };
}

/**
 * RT-26: the only release path for a Run that suspended inside AgentScope. It
 * requires the acknowledged checkpoint proof for the exact owner, execution,
 * and fence. Timeout, DELETE success, or a missing row is never a proof.
 */
export async function releaseSuspendedSessionAdmission(
  prisma: PrismaClient,
  lease: SessionAdmissionLease,
  proof: SessionCheckpointProofRef,
  now = new Date(),
): Promise<SuspendedReleaseResult> {
  return prisma.$transaction((tx) =>
    releaseOwnedWithProof(tx, lease, proof, "suspended_checkpoint", now),
  );
}

/**
 * RT-26 recovery hook for an RT-25 `recovering` owner: a fresh Runtime proof
 * obtained by the caller is required, so an unreachable Runtime leaves the
 * owner absorbing/blocked instead of granting the next Run the session.
 */
export async function releaseRecoveredSessionAdmission(
  prisma: PrismaClient,
  input: {
    lease: SessionAdmissionLease;
    attemptId: string;
    suspensionKey: string;
    proof: SessionCheckpointProofRef;
  },
  now = new Date(),
): Promise<SuspendedReleaseResult> {
  return prisma.$transaction(async (tx) => {
    const lease = input.lease;
    const row = await lockAdmission(tx, lease.sessionKey);
    const exactOwner =
      row.ownerRunId === lease.runId &&
      row.ownerExecutionId === lease.executionId &&
      row.fence === lease.admissionFence;
    if (row.state === "available") {
      if (exactOwner) {
        const next = await firstQueuedRequest(tx, lease.sessionKey);
        return { kind: "released" as const, nextRunId: next?.runId ?? null };
      }
      return { kind: "stale" as const };
    }
    if (
      row.state !== "recovering" ||
      !exactOwner ||
      row.ownerAttemptId !== input.attemptId ||
      row.suspensionKey !== input.suspensionKey
    ) {
      return { kind: "stale" as const };
    }
    const proven = await checkpointProvesCleanOrDetached(tx, {
      sessionKey: lease.sessionKey,
      runId: lease.runId,
      executionId: lease.executionId,
      fence: lease.admissionFence,
      suspensionKey: input.suspensionKey,
      proof: input.proof,
    });
    if (!proven) return { kind: "unconfirmed" as const };
    const updated = await tx.$executeRaw`
      UPDATE "agent_session_admissions"
      SET "state" = 'available',
          "expiresAt" = NULL,
          "lastReleaseReason" = 'recovered_checkpoint_proof',
          "updatedAt" = ${now}
      WHERE "sessionKey" = ${lease.sessionKey}
        AND "state" = 'recovering'
        AND "ownerRunId" = ${lease.runId}
        AND "ownerExecutionId" = ${lease.executionId}
        AND "fence" = ${lease.admissionFence}
    `;
    if (updated !== 1) return { kind: "stale" as const };
    await tx.$executeRaw`
      UPDATE "agent_session_admission_requests"
      SET "state" = 'released', "updatedAt" = ${now}
      WHERE "executionId" = ${lease.executionId} AND "state" = 'recovering'
    `;
    const next = await firstQueuedRequest(tx, lease.sessionKey);
    return { kind: "released" as const, nextRunId: next?.runId ?? null };
  });
}

export async function listAvailableSessionAdmissionHeads(
  prisma: PrismaClient,
  limit = 100,
): Promise<Array<{ sessionKey: string; runId: string }>> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "agent_session_admission_requests" request
      SET "state" = 'released', "updatedAt" = now()
      FROM "runs" run
      WHERE request."state" = 'queued'
        AND run."id" = request."runId"
        AND run."status" IN ('completed', 'failed', 'cancelled')
    `;
    return tx.$queryRaw<Array<{ sessionKey: string; runId: string }>>`
      SELECT admission."sessionKey", request."runId"
      FROM "agent_session_admissions" admission
      JOIN LATERAL (
        SELECT queued."runId"
        FROM "agent_session_admission_requests" queued
        JOIN "runs" run ON run."id" = queued."runId"
        WHERE queued."sessionKey" = admission."sessionKey"
          AND queued."state" = 'queued'
          AND run."status" IN ('queued', 'leased', 'running', 'waiting_input', 'waiting_takeover')
        ORDER BY queued."position" ASC
        LIMIT 1
      ) request ON TRUE
      WHERE admission."state" = 'available'
      ORDER BY admission."updatedAt" ASC, admission."sessionKey" ASC
      LIMIT ${limit}
    `;
  });
}
