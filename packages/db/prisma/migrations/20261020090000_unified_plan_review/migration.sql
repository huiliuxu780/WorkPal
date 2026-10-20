-- UX-02 unified plan review: one authoritative Plan per Run.
--
-- run_plans gains the approval-basis axis (contentVersion + fingerprints +
-- review state) next to the existing execution-progress axis (revision).
-- run_plan_reviews is the durable audit of every review round: submission
-- source, deciding actor, time, feedback, and the intervention pairing.
-- runs.planPhase mirrors the native PLAN/BUILD mode so the backend tool
-- surface and the execute-time guard can express the planning phase without
-- trusting model-reported state.
--
-- Compatibility: existing rows keep reviewStatus NULL (legacy plans). A
-- legacy plan is grandfathered on its current content — it keeps executing
-- without a suddenly-required approval — and its first post-upgrade content
-- change opens the first real review round. contentVersion is seeded from
-- revision so the existing v{revision} display reads unchanged until then.

ALTER TABLE "runs" ADD COLUMN "planPhase" TEXT;

ALTER TABLE "run_plans" ADD COLUMN "contentVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "run_plans" ADD COLUMN "contentFingerprint" TEXT;
ALTER TABLE "run_plans" ADD COLUMN "reviewStatus" TEXT;
ALTER TABLE "run_plans" ADD COLUMN "approvedContentVersion" INTEGER;
ALTER TABLE "run_plans" ADD COLUMN "approvedFingerprint" TEXT;

UPDATE "run_plans" SET "contentVersion" = "revision";

ALTER TABLE "interventions" ADD COLUMN "planReview" JSONB;

CREATE TABLE "run_plan_reviews" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "contentVersion" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "toolExecutionId" TEXT,
    "interventionId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "submittedSeq" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "feedback" TEXT,
    "decisionSubmissionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_plan_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "run_plan_reviews_runId_toolExecutionId_key"
    ON "run_plan_reviews"("runId", "toolExecutionId");

CREATE INDEX "run_plan_reviews_runId_contentVersion_idx"
    ON "run_plan_reviews"("runId", "contentVersion");

-- At most one pending review round per Run, mirroring the interventions
-- pendingRunKey rule: a submission can never stack a second waiting card.
CREATE UNIQUE INDEX "run_plan_reviews_one_pending_per_run"
    ON "run_plan_reviews"("runId") WHERE "status" = 'pending';

ALTER TABLE "run_plan_reviews"
    ADD CONSTRAINT "run_plan_reviews_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
