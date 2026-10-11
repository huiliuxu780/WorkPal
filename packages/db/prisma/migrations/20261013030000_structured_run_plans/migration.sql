CREATE TABLE "run_plans" (
    "runId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "threadGeneration" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "current" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "run_plans_pkey" PRIMARY KEY ("runId")
);

CREATE UNIQUE INDEX "run_plans_planId_key" ON "run_plans"("planId");
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "run_plan_revisions" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "eventSeq" INTEGER NOT NULL,
    "toolExecutionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "run_plan_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "run_plan_revisions_runId_revision_key" ON "run_plan_revisions"("runId", "revision");
CREATE UNIQUE INDEX "run_plan_revisions_runId_toolExecutionId_key" ON "run_plan_revisions"("runId", "toolExecutionId");
CREATE INDEX "run_plan_revisions_runId_revision_idx" ON "run_plan_revisions"("runId", "revision" DESC);
ALTER TABLE "run_plan_revisions" ADD CONSTRAINT "run_plan_revisions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "run_plans"("runId") ON DELETE CASCADE ON UPDATE CASCADE;
