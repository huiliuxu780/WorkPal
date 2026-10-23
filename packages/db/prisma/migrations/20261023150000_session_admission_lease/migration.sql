-- RT-25: a chat admission lease is a distinct resource from both Run claims
-- and computer execution leases. Expiry changes owned -> recovering; it never
-- transfers ownership without RT-26's clean/detached proof.
CREATE TABLE "agent_session_admissions" (
    "sessionKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "threadGeneration" INTEGER NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'chat',
    "state" TEXT NOT NULL DEFAULT 'available',
    "ownerRunId" TEXT,
    "ownerAttemptId" TEXT,
    "ownerExecutionId" TEXT,
    "ownerRunLeaseOwner" TEXT,
    "ownerRunLeaseFence" INTEGER,
    "fence" INTEGER NOT NULL DEFAULT 0,
    "suspensionKey" TEXT,
    "acquiredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "executionPreparedAt" TIMESTAMP(3),
    "runtimeStartedAt" TIMESTAMP(3),
    "lastReleaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_session_admissions_pkey" PRIMARY KEY ("sessionKey"),
    CONSTRAINT "agent_session_admissions_state_check"
      CHECK ("state" IN ('available', 'owned', 'recovering')),
    CONSTRAINT "agent_session_admissions_owner_check" CHECK (
      ("state" = 'available') OR
      ("ownerRunId" IS NOT NULL AND "ownerExecutionId" IS NOT NULL
        AND "ownerRunLeaseOwner" IS NOT NULL AND "ownerRunLeaseFence" IS NOT NULL
        AND "acquiredAt" IS NOT NULL AND "expiresAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "agent_session_admissions_identity_key"
  ON "agent_session_admissions"("userId", "spaceId", "botId", "threadId", "threadGeneration", "scope");
CREATE INDEX "agent_session_admissions_state_expiresAt_idx"
  ON "agent_session_admissions"("state", "expiresAt");
CREATE INDEX "agent_session_admissions_ownerRunId_idx"
  ON "agent_session_admissions"("ownerRunId");
CREATE UNIQUE INDEX "agent_session_admissions_suspensionKey_key"
  ON "agent_session_admissions"("suspensionKey");

CREATE TABLE "agent_session_admission_requests" (
    "position" BIGSERIAL NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_session_admission_requests_pkey" PRIMARY KEY ("position"),
    CONSTRAINT "agent_session_admission_requests_state_check"
      CHECK ("state" IN ('queued', 'owned', 'recovering', 'released')),
    CONSTRAINT "agent_session_admission_requests_sessionKey_fkey"
      FOREIGN KEY ("sessionKey") REFERENCES "agent_session_admissions"("sessionKey")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_session_admission_requests_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "runs"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "agent_session_admission_requests_executionId_key"
  ON "agent_session_admission_requests"("executionId");
CREATE INDEX "agent_session_admission_requests_session_state_position_idx"
  ON "agent_session_admission_requests"("sessionKey", "state", "position");
CREATE INDEX "agent_session_admission_requests_state_position_idx"
  ON "agent_session_admission_requests"("state", "position");
CREATE INDEX "agent_session_admission_requests_runId_idx"
  ON "agent_session_admission_requests"("runId");
CREATE UNIQUE INDEX "agent_session_admission_requests_active_session_key"
  ON "agent_session_admission_requests"("sessionKey")
  WHERE "state" IN ('owned', 'recovering');
CREATE UNIQUE INDEX "agent_session_admission_requests_queued_run_key"
  ON "agent_session_admission_requests"("sessionKey", "runId")
  WHERE "state" = 'queued';
