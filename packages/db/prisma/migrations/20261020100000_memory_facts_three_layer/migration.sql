-- ME-01/ME-02 expand step: three-layer long-term memory (facts, shards,
-- summaries), evidence governance, extraction cursors, quota accounting and
-- auditable application-compaction revisions.
--
-- Expand-only: no existing row is rewritten, no model is called during
-- deployment, and legacy memory_documents stay untouched as the compatibility
-- write entry. Active/candidate dedupe uses partial unique indexes because
-- superseded/deleted/rejected rows must keep their canonicalKey for
-- resurrection guards. memory_evidence.messageId deliberately has no foreign
-- key: thread clear deletes messages and must explicitly invalidate evidence
-- in the same transaction instead of relying on SET NULL. memory_job_outbox
-- follows the execution_revocations pattern (no FKs; presence means pending;
-- success deletes the row).

CREATE TABLE "memory_facts" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "botId" TEXT,
    "scopeKind" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "canonicalKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "language" TEXT,
    "literalValues" JSONB,
    "origin" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "supersedesFactId" TEXT,
    "promotionSourceFactId" TEXT,
    "sourceDocumentId" TEXT,
    "learnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validFrom" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "lastConfirmedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "lastChangedBy" TEXT NOT NULL,
    "sourceRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_facts_pkey" PRIMARY KEY ("id")
);

-- One active proposition per canonical identity inside its authorized scope.
CREATE UNIQUE INDEX "memory_facts_active_dedup_key"
    ON "memory_facts"("spaceId", "scopeKind", "scopeKey", "canonicalKey")
    WHERE "state" = 'active';
-- One open candidate per canonical identity so repeated extraction merges
-- evidence into the same row instead of duplicating candidates.
CREATE UNIQUE INDEX "memory_facts_candidate_dedup_key"
    ON "memory_facts"("spaceId", "scopeKind", "scopeKey", "canonicalKey")
    WHERE "state" = 'candidate';
CREATE INDEX "memory_facts_spaceId_scopeKind_scopeKey_state_idx"
    ON "memory_facts"("spaceId", "scopeKind", "scopeKey", "state");
CREATE INDEX "memory_facts_spaceId_scopeKind_scopeKey_canonicalKey_idx"
    ON "memory_facts"("spaceId", "scopeKind", "scopeKey", "canonicalKey");
CREATE INDEX "memory_facts_spaceId_ownerUserId_state_idx"
    ON "memory_facts"("spaceId", "ownerUserId", "state");
CREATE INDEX "memory_facts_sourceDocumentId_idx" ON "memory_facts"("sourceDocumentId");
CREATE INDEX "memory_facts_state_expiresAt_idx" ON "memory_facts"("state", "expiresAt");

ALTER TABLE "memory_facts"
    ADD CONSTRAINT "memory_facts_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_facts"
    ADD CONSTRAINT "memory_facts_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "bots"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "memory_fact_revisions" (
    "id" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "text" TEXT,
    "kind" TEXT NOT NULL,
    "literalValues" JSONB,
    "changedBy" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_fact_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_fact_revisions_factId_revision_key"
    ON "memory_fact_revisions"("factId", "revision");

ALTER TABLE "memory_fact_revisions"
    ADD CONSTRAINT "memory_fact_revisions_factId_fkey"
    FOREIGN KEY ("factId") REFERENCES "memory_facts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "memory_evidence" (
    "id" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "threadGeneration" INTEGER NOT NULL,
    "messageId" TEXT,
    "messageSeq" INTEGER NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "originKind" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "sourceDigest" TEXT NOT NULL,
    "accessible" BOOLEAN NOT NULL DEFAULT true,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_evidence_pkey" PRIMARY KEY ("id")
);

-- The same message cannot back the same fact twice through the same evidence
-- type. NULLS NOT DISTINCT keeps user_edit evidence (no message) unique too.
CREATE UNIQUE INDEX "memory_evidence_factId_messageId_evidenceType_key"
    ON "memory_evidence"("factId", "messageId", "evidenceType") NULLS NOT DISTINCT;
CREATE INDEX "memory_evidence_factId_idx" ON "memory_evidence"("factId");
CREATE INDEX "memory_evidence_threadId_threadGeneration_idx"
    ON "memory_evidence"("threadId", "threadGeneration");

ALTER TABLE "memory_evidence"
    ADD CONSTRAINT "memory_evidence_factId_fkey"
    FOREIGN KEY ("factId") REFERENCES "memory_facts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "memory_shards" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "profileMarkdown" TEXT,
    "profileVersion" INTEGER NOT NULL DEFAULT -1,
    "lastRebuiltAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_shards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_shards_spaceId_scopeKind_scopeKey_key"
    ON "memory_shards"("spaceId", "scopeKind", "scopeKey");

ALTER TABLE "memory_shards"
    ADD CONSTRAINT "memory_shards_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "context_summaries" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "recipientBotId" TEXT NOT NULL,
    "sourceVersions" JSONB NOT NULL,
    "sourceVersionDigest" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "summaryModel" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "tokenEstimate" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_summaries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "context_summaries_spaceId_recipientUserId_recipientBotId_sourceVersionDigest_key"
    ON "context_summaries"("spaceId", "recipientUserId", "recipientBotId", "sourceVersionDigest");
CREATE INDEX "context_summaries_spaceId_recipientUserId_recipientBotId_idx"
    ON "context_summaries"("spaceId", "recipientUserId", "recipientBotId");

ALTER TABLE "context_summaries"
    ADD CONSTRAINT "context_summaries_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "memory_job_outbox" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sourceVersionDigest" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_job_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_job_outbox_kind_targetId_sourceVersionDigest_key"
    ON "memory_job_outbox"("kind", "targetId", "sourceVersionDigest");
CREATE INDEX "memory_job_outbox_nextAttemptAt_idx" ON "memory_job_outbox"("nextAttemptAt");

CREATE TABLE "memory_extraction_cursors" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "threadId" TEXT NOT NULL,
    "threadGeneration" INTEGER NOT NULL DEFAULT 0,
    "highWatermarkSeq" INTEGER NOT NULL DEFAULT -1,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_extraction_cursors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_extraction_cursors_threadId_key"
    ON "memory_extraction_cursors"("threadId");
CREATE INDEX "memory_extraction_cursors_spaceId_userId_idx"
    ON "memory_extraction_cursors"("spaceId", "userId");

ALTER TABLE "memory_extraction_cursors"
    ADD CONSTRAINT "memory_extraction_cursors_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "threads"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "memory_model_usage" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "purpose" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_model_usage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_model_usage_spaceId_userId_day_purpose_key"
    ON "memory_model_usage"("spaceId", "userId", "day", "purpose");

ALTER TABLE "memory_model_usage"
    ADD CONSTRAINT "memory_model_usage_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "space_memory_policies" (
    "spaceId" TEXT NOT NULL,
    "autoExtraction" TEXT NOT NULL DEFAULT 'off',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "space_memory_policies_pkey" PRIMARY KEY ("spaceId")
);

ALTER TABLE "space_memory_policies"
    ADD CONSTRAINT "space_memory_policies_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "thread_compaction_revisions" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "fromSeqExclusive" INTEGER NOT NULL,
    "toSeqInclusive" INTEGER NOT NULL,
    "previousRevisionId" TEXT,
    "summary" TEXT NOT NULL,
    "inputDigest" TEXT NOT NULL,
    "sourceRunId" TEXT,
    "modelProvider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "includesToolResults" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thread_compaction_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "thread_compaction_revisions_threadId_generation_toSeqInclusive_key"
    ON "thread_compaction_revisions"("threadId", "generation", "toSeqInclusive");
CREATE INDEX "thread_compaction_revisions_threadId_idx"
    ON "thread_compaction_revisions"("threadId");

ALTER TABLE "thread_compaction_revisions"
    ADD CONSTRAINT "thread_compaction_revisions_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "threads"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
