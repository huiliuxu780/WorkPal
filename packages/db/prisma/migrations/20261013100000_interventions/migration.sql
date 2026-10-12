-- Addressable Intervention requests.
-- No foreign keys to runs, messages, or external_effects: cascade deletes must
-- not erase a terminal audit row. Historical messages, events, runs, attempts,
-- and effects are left untouched. A still-pending legacy ask is materialized
-- on the first resolve, timeout, or cancel as legacy_<messageId>. A snapshot
-- read only synthesizes a virtual view and does not insert. Old message JSON
-- is not rewritten.

CREATE TABLE "interventions" (
    "id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "pendingRunKey" TEXT,
    "expiresAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "supersededById" TEXT,
    "agentId" TEXT,
    "backgroundTaskId" TEXT,
    "inputMode" TEXT,
    "inputPurpose" TEXT,
    "inputActions" JSONB,
    "effectId" TEXT,
    "decision" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interventions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "interventions_pendingRunKey_key" ON "interventions"("pendingRunKey");
CREATE INDEX "interventions_threadId_status_idx" ON "interventions"("threadId", "status");
CREATE INDEX "interventions_runId_status_idx" ON "interventions"("runId", "status");
CREATE INDEX "interventions_messageId_idx" ON "interventions"("messageId");

CREATE TABLE "intervention_submissions" (
    "id" TEXT NOT NULL,
    "interventionId" TEXT NOT NULL,
    "clientSubmissionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intervention_submissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "intervention_submissions_interventionId_clientSubmissionId_key"
    ON "intervention_submissions"("interventionId", "clientSubmissionId");
CREATE INDEX "intervention_submissions_interventionId_idx"
    ON "intervention_submissions"("interventionId");

ALTER TABLE "intervention_submissions"
    ADD CONSTRAINT "intervention_submissions_interventionId_fkey"
    FOREIGN KEY ("interventionId") REFERENCES "interventions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
