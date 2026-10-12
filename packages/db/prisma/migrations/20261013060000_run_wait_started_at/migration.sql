ALTER TABLE "runs" ADD COLUMN "waitStartedAt" TIMESTAMP(3);
-- Existing waits have no entry timestamp. Preserve the previous expiry clock on migration.
UPDATE "runs" SET "waitStartedAt" = "updatedAt"
WHERE "status" IN ('waiting_input', 'waiting_takeover');
CREATE INDEX "runs_status_waitStartedAt_id_idx" ON "runs"("status", "waitStartedAt", "id");
