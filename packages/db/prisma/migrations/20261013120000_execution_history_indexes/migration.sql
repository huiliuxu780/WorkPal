-- ExecutionSnapshot read-model indexes (HISTORY-001).
-- messages(runId, seq): per-Run transcript facts — first bot message (the
-- server-chosen anchor) and the newest bot message (the committed result),
-- resolved in grouped passes instead of thread scans.
-- artifacts(runId, createdAt): the Run's artifact list + totals.
-- events(runId, type, seq) already exists and serves the rev ceiling, the
-- action count, and the Activity page walk.
-- CREATE INDEX (not IF NOT EXISTS): fresh clones replay from empty and
-- duplicate-application must fail loudly.

CREATE INDEX "messages_runId_seq_idx" ON "messages"("runId", "seq");
CREATE INDEX "artifacts_runId_createdAt_idx" ON "artifacts"("runId", "createdAt");
