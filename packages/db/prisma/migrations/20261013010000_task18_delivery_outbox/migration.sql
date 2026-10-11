CREATE TABLE "delivery_records" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "backgroundTaskId" TEXT,
  "threadId" TEXT NOT NULL,
  "threadGeneration" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "idempotencyKey" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "claimedBy" TEXT,
  "deliveryRunId" TEXT,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3),
  CONSTRAINT "delivery_records_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "background_agent_tasks" ADD COLUMN "threadGeneration" INTEGER NOT NULL DEFAULT 0;
UPDATE "background_agent_tasks" AS task
SET "threadGeneration" = COALESCE((
  SELECT event."seq"
  FROM "events" AS event
  WHERE event."threadId" = task."threadId"
    AND event."type" = 'thread.cleared'
    AND event."createdAt" <= task."startedAt"
  ORDER BY event."seq" DESC
  LIMIT 1
), 0);

CREATE UNIQUE INDEX "delivery_records_idempotencyKey_key" ON "delivery_records"("idempotencyKey");
CREATE INDEX "delivery_records_status_nextAttemptAt_idx" ON "delivery_records"("status", "nextAttemptAt");
CREATE INDEX "delivery_records_threadId_status_idx" ON "delivery_records"("threadId", "status");
CREATE INDEX "delivery_records_deliveryRunId_idx" ON "delivery_records"("deliveryRunId");
CREATE INDEX "delivery_records_backgroundTaskId_idx" ON "delivery_records"("backgroundTaskId");
ALTER TABLE "delivery_records" ADD CONSTRAINT "delivery_records_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
