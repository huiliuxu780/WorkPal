-- CANCEL-01: typed cancel reason on the run, and a delegation-outcome outbox
-- that is not cascaded when the run or bot row disappears.
ALTER TABLE "runs" ADD COLUMN "cancelReason" TEXT;

CREATE TABLE "cancel_outcome_outbox" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "senderBotId" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "originThreadId" TEXT,
    "originRunId" TEXT,
    "originMessageId" TEXT,
    "reason" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cancel_outcome_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cancel_outcome_outbox_idempotencyKey_key"
    ON "cancel_outcome_outbox"("idempotencyKey");

CREATE INDEX "cancel_outcome_outbox_deliveredAt_reason_idx"
    ON "cancel_outcome_outbox"("deliveredAt", "reason");
