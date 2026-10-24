CREATE TABLE "agent_pair_message_origins" (
    "messageId" TEXT NOT NULL,
    "pairThreadId" TEXT NOT NULL,
    "sourceThreadId" TEXT NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "sourceReceiptMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_pair_message_origins_pkey" PRIMARY KEY ("messageId")
);

CREATE INDEX "agent_pair_message_origins_pairThreadId_sourceThreadId_idx"
    ON "agent_pair_message_origins"("pairThreadId", "sourceThreadId");
CREATE INDEX "agent_pair_message_origins_sourceReceiptMessageId_pairThreadId_idx"
    ON "agent_pair_message_origins"("sourceReceiptMessageId", "pairThreadId");
CREATE INDEX "agent_pair_message_origins_sourceRunId_idx"
    ON "agent_pair_message_origins"("sourceRunId");

ALTER TABLE "agent_pair_message_origins"
    ADD CONSTRAINT "agent_pair_message_origins_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_pair_message_origins"
    ADD CONSTRAINT "agent_pair_message_origins_pairThreadId_fkey"
    FOREIGN KEY ("pairThreadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_pair_message_origins"
    ADD CONSTRAINT "agent_pair_message_origins_sourceThreadId_fkey"
    FOREIGN KEY ("sourceThreadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_pair_message_origins"
    ADD CONSTRAINT "agent_pair_message_origins_sourceRunId_fkey"
    FOREIGN KEY ("sourceRunId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_pair_message_origins"
    ADD CONSTRAINT "agent_pair_message_origins_sourceReceiptMessageId_fkey"
    FOREIGN KEY ("sourceReceiptMessageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
