CREATE TABLE "avatar_failure_receipts" (
  "userId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "avatar_failure_receipts_pkey" PRIMARY KEY ("userId", "runId")
);

ALTER TABLE "avatar_failure_receipts"
  ADD CONSTRAINT "avatar_failure_receipts_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "avatar_failure_receipts"
  ADD CONSTRAINT "avatar_failure_receipts_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "avatar_failure_receipts_spaceId_userId_idx"
  ON "avatar_failure_receipts"("spaceId", "userId");
CREATE INDEX "events_threadId_type_createdAt_idx"
  ON "events"("threadId", "type", "createdAt");

-- Historical failures predate avatar receipts. Keep them seen rather than
-- making an old backlog appear as a new incident after the feature ships.
INSERT INTO "avatar_failure_receipts" ("userId", "runId", "spaceId")
SELECT "userId", "id", "spaceId" FROM "runs" WHERE "status" = 'failed';
