-- RT-26: a suspended native AgentScope pending state is isolated per Run and
-- Attempt before the RT-25 chat admission may be released. The checkpoint row
-- is the durable ack of the Runtime's clean/detached proof; the resume row
-- binds the restored state to a NEW execution fence and suspension key and
-- makes the persisted decision/answer idempotent.

-- The pending request itself carries the execution binding it was created
-- under, so a checkpoint can never claim another attempt's card.
ALTER TABLE "interventions" ADD COLUMN "executionFence" INTEGER;
ALTER TABLE "interventions" ADD COLUMN "suspensionKey" TEXT;

CREATE TABLE "agent_session_checkpoints" (
    "id" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "admissionFence" INTEGER NOT NULL,
    "suspensionKey" TEXT NOT NULL,
    "threadGeneration" INTEGER NOT NULL,
    "proofKind" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "pendingCalls" JSONB NOT NULL,
    "pendingInterventionId" TEXT,
    "coveredMessageSeq" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'recorded',
    "detachedAt" TIMESTAMP(3) NOT NULL,
    "ackedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_session_checkpoints_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_session_checkpoints_proof_check"
      CHECK ("proofKind" IN ('clean', 'detached')),
    CONSTRAINT "agent_session_checkpoints_status_check"
      CHECK ("status" IN ('recorded', 'superseded', 'consumed')),
    CONSTRAINT "agent_session_checkpoints_fence_check"
      CHECK ("admissionFence" > 0 AND "suspensionKey" <> '')
);

CREATE UNIQUE INDEX "agent_session_checkpoints_suspensionKey_key"
  ON "agent_session_checkpoints"("suspensionKey");
CREATE UNIQUE INDEX "agent_session_checkpoints_run_attempt_fence_key"
  ON "agent_session_checkpoints"("runId", "attemptId", "admissionFence");
CREATE INDEX "agent_session_checkpoints_runId_status_idx"
  ON "agent_session_checkpoints"("runId", "status");
CREATE INDEX "agent_session_checkpoints_sessionKey_detachedAt_idx"
  ON "agent_session_checkpoints"("sessionKey", "detachedAt");

CREATE TABLE "agent_session_checkpoint_resumes" (
    "id" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "fence" INTEGER NOT NULL,
    "suspensionKey" TEXT NOT NULL,
    "decisionKey" TEXT NOT NULL,
    "decision" JSONB,
    "answerDigest" TEXT,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "restoredAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_session_checkpoint_resumes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_session_checkpoint_resumes_status_check"
      CHECK ("status" IN ('prepared', 'restored', 'consumed')),
    CONSTRAINT "agent_session_checkpoint_resumes_checkpointId_fkey"
      FOREIGN KEY ("checkpointId") REFERENCES "agent_session_checkpoints"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "agent_session_checkpoint_resumes_suspensionKey_key"
  ON "agent_session_checkpoint_resumes"("suspensionKey");
CREATE UNIQUE INDEX "agent_session_checkpoint_resumes_decisionKey_key"
  ON "agent_session_checkpoint_resumes"("decisionKey");
CREATE UNIQUE INDEX "agent_session_checkpoint_resumes_checkpointId_executionId_key"
  ON "agent_session_checkpoint_resumes"("checkpointId", "executionId");
CREATE INDEX "agent_session_checkpoint_resumes_runId_status_idx"
  ON "agent_session_checkpoint_resumes"("runId", "status");
