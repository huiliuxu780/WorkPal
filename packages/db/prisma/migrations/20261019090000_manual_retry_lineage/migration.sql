-- MR-01: manual retry lineage. One Run has at most one direct successor.
-- ON DELETE RESTRICT keeps predecessor history when a successor exists.
ALTER TABLE "runs" ADD COLUMN "retryOfRunId" TEXT;

CREATE UNIQUE INDEX "runs_retryOfRunId_key" ON "runs"("retryOfRunId");

ALTER TABLE "runs"
  ADD CONSTRAINT "runs_retryOfRunId_fkey"
  FOREIGN KEY ("retryOfRunId") REFERENCES "runs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
