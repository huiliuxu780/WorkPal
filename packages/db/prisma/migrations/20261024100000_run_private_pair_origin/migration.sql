-- RT-05: every Run created by a private-pair delivery persists the origin it
-- must return to. The columns are plain references (no foreign keys): the
-- origin is an immutable routing fact, and deleting the source Thread must not
-- cascade-delete the delegated Run's execution record.
ALTER TABLE "runs"
    ADD COLUMN "originThreadId" TEXT,
    ADD COLUMN "originRunId" TEXT,
    ADD COLUMN "originMessageId" TEXT;

CREATE INDEX "runs_originThreadId_originRunId_idx"
    ON "runs"("originThreadId", "originRunId");
