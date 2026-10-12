CREATE TABLE "run_steps" (
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "threadGeneration" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "current" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "run_steps_pkey" PRIMARY KEY ("runId","stepId")
);
CREATE INDEX "run_steps_runId_sortOrder_idx" ON "run_steps"("runId","sortOrder");
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "run_step_mutations" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "toolExecutionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "eventSeq" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "run_step_mutations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "run_step_mutations_runId_toolExecutionId_key" ON "run_step_mutations"("runId","toolExecutionId");
CREATE UNIQUE INDEX "run_step_mutations_runId_stepId_revision_key" ON "run_step_mutations"("runId","stepId","revision");
CREATE INDEX "run_step_mutations_runId_stepId_revision_idx" ON "run_step_mutations"("runId","stepId","revision" DESC);
ALTER TABLE "run_step_mutations" ADD CONSTRAINT "run_step_mutations_runId_stepId_fkey" FOREIGN KEY ("runId","stepId") REFERENCES "run_steps"("runId","stepId") ON DELETE CASCADE ON UPDATE CASCADE;
