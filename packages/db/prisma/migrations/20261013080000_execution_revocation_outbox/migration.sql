-- Remote run abort and background-task revocation requests.
-- No foreign keys: bot, group, thread, and account deletes must not remove a
-- request the worker still has to retry. Presence of a row means pending.
CREATE TABLE "execution_revocations" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL DEFAULT '',
    "taskId" TEXT NOT NULL DEFAULT '',
    "userId" TEXT NOT NULL DEFAULT '',
    "spaceId" TEXT NOT NULL DEFAULT '',
    "botId" TEXT NOT NULL DEFAULT '',
    "threadId" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "execution_revocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "execution_revocations_kind_subjectId_key"
    ON "execution_revocations"("kind", "subjectId");
CREATE INDEX "execution_revocations_createdAt_idx"
    ON "execution_revocations"("createdAt");
