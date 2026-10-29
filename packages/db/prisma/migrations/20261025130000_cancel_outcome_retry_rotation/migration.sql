-- CANCEL-01: rotate a failed cancellation outcome so it cannot block newer rows.
ALTER TABLE "cancel_outcome_outbox"
    ADD COLUMN "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DROP INDEX "cancel_outcome_outbox_deliveredAt_reason_idx";

CREATE INDEX "cancel_outcome_outbox_deliveredAt_reason_lastAttemptAt_idx"
    ON "cancel_outcome_outbox"("deliveredAt", "reason", "lastAttemptAt");
