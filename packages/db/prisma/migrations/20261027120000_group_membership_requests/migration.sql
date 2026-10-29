-- RT-12: bound cross-group membership requests. The Intervention row owns the
-- decision lifecycle; this table owns the immutable original request and the
-- business result of an approval. No foreign keys on purpose: the audit fact
-- must survive group, Bot, run or thread deletion.
CREATE TABLE "group_membership_requests" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "sourceThreadId" TEXT NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "requestMessageId" TEXT,
    "cardMessageId" TEXT,
    "interventionId" TEXT,
    "deliveryKey" TEXT NOT NULL,
    "requestRevision" INTEGER NOT NULL DEFAULT 1,
    "message" TEXT NOT NULL,
    "topic" TEXT,
    "presentation" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "receiptMessageId" TEXT,
    "targetMessageId" TEXT,
    "targetRunId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_membership_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "group_membership_requests_sourceRunId_deliveryKey_key"
    ON "group_membership_requests"("sourceRunId", "deliveryKey");

CREATE UNIQUE INDEX "group_membership_requests_interventionId_key"
    ON "group_membership_requests"("interventionId");

CREATE INDEX "group_membership_requests_sourceThreadId_createdAt_idx"
    ON "group_membership_requests"("sourceThreadId", "createdAt");
