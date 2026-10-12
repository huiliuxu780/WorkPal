-- One Attempt per Run fence. Create the unique index before dropping the old
-- lookup index. If historical duplicates exist, this statement fails and reports
-- the conflicting key. Those rows are not deleted or merged.
CREATE UNIQUE INDEX "attempts_runId_fence_key" ON "attempts"("runId", "fence");
DROP INDEX IF EXISTS "attempts_runId_idx";
