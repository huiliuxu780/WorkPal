-- HISTORY-001 rev signal: the Run-row visible-transition counter.
--
-- The snapshot version is `rev = MAX(events.seq for the run) + runs.snapshotRev`.
-- The event component covers every content change (activity, results,
-- artifacts, interventions, plans/steps/todos, lifecycle events). But the
-- worker hot paths — claim (queued→leased), promote (leased→running,
-- startedAt), fence reconciliation, computer requeue — deliberately write the
-- Run row with standalone CAS updates: no transaction-held Thread lock and no
-- product event. Appending events there would drag the Thread lock into the
-- lock-free claim path and risk Run→Thread acquisition, so those visible
-- transitions cannot be derived from the event log.
--
-- A BEFORE UPDATE trigger keeps the counter convention-free: every current and
-- future write path is covered by construction, and only a real change of a
-- snapshot-visible column (status, waitKind, startedAt, completedAt, error)
-- bumps it. Lease renewals, budget overrides, model switches and mirror
-- timestamps therefore never invalidate UI expansion state. The trigger takes
-- no new locks — the row is already locked by the UPDATE itself — so the
-- Thread → Run lock order is untouched, and the increment commits atomically
-- with the transition it counts.

ALTER TABLE "runs" ADD COLUMN "snapshotRev" INTEGER NOT NULL DEFAULT 0;

CREATE FUNCTION "bump_run_snapshot_rev"() RETURNS trigger AS $$
BEGIN
  IF (NEW."status" IS DISTINCT FROM OLD."status")
     OR (NEW."waitKind" IS DISTINCT FROM OLD."waitKind")
     OR (NEW."startedAt" IS DISTINCT FROM OLD."startedAt")
     OR (NEW."completedAt" IS DISTINCT FROM OLD."completedAt")
     OR (NEW."error" IS DISTINCT FROM OLD."error") THEN
    NEW."snapshotRev" := OLD."snapshotRev" + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "runs_snapshot_rev"
  BEFORE UPDATE ON "runs"
  FOR EACH ROW
  EXECUTE FUNCTION "bump_run_snapshot_rev"();
