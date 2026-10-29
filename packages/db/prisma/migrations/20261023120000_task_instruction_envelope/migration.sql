-- RT-13: append-only Task instruction revisions.
--
-- tasks.prompt stays the immutable original instruction. Natural-language
-- amendments live in Messages plus task.amended Events, and tasks.revision is
-- the aggregate revision of that envelope: 1 = original only, each amendment
-- adds one. Existing rows read as revision 1, original only, with no backfill
-- and no rewrite.
ALTER TABLE "tasks" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

-- The Task instruction revision an execution consumed at lease acquisition.
-- NULL marks Runs created before this migration; they are not guessed.
ALTER TABLE "runs" ADD COLUMN "consumedRevision" INTEGER;
