ALTER TABLE "events"
  ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "causationId" TEXT,
  ADD COLUMN "parentRunId" TEXT;

ALTER TABLE "runs" ADD COLUMN "waitKind" TEXT;

UPDATE "runs"
SET "waitKind" = CASE
  WHEN "status" = 'waiting_takeover' THEN 'takeover'
  WHEN "status" = 'waiting_input' THEN 'input'
  ELSE NULL
END;

ALTER TABLE "runs" ADD CONSTRAINT "runs_wait_kind_status_check" CHECK (
  ("status" = 'waiting_input' AND "waitKind" IN ('input', 'approval')) OR
  ("status" = 'waiting_takeover' AND "waitKind" = 'takeover') OR
  ("status" NOT IN ('waiting_input', 'waiting_takeover') AND "waitKind" IS NULL)
);
