-- RT-14: distinguish a completed Task's amendment follow-up from a manual retry.
-- One predecessor can have only one amendment follow-up; the Run clientNonce
-- supplies the operation identity for replay and transaction retry recovery.

ALTER TABLE "runs" ADD COLUMN "followUpOfRunId" TEXT;

CREATE UNIQUE INDEX "runs_followUpOfRunId_key" ON "runs"("followUpOfRunId");
CREATE INDEX "runs_taskId_createdAt_id_idx" ON "runs"("taskId", "createdAt", "id");

ALTER TABLE "runs"
  ADD CONSTRAINT "runs_followUpOfRunId_fkey"
  FOREIGN KEY ("followUpOfRunId") REFERENCES "runs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
