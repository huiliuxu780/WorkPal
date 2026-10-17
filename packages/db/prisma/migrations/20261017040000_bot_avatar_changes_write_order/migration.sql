-- "createdAt" is CURRENT_TIMESTAMP: the transaction START time. An executor
-- transaction that waits on its Run lock can start before a Studio transaction
-- yet commit after it, so timestamp order disagrees with serialized write
-- order. Order history, pruning and the undo "latest" check by a monotonic
-- write sequence instead; its value is assigned at INSERT, after the Bot lock.
ALTER TABLE "bot_avatar_changes" ADD COLUMN "seq" BIGSERIAL NOT NULL;

-- Keyed no-op tombstone flag: a Bot retry whose request was already satisfied
-- persists a metadata-only row so a lost result cannot later re-apply the
-- stale choice. Tombstones never appear in the visible history.
ALTER TABLE "bot_avatar_changes" ADD COLUMN "noop" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX "bot_avatar_changes_botId_createdAt_idx";
CREATE INDEX "bot_avatar_changes_botId_seq_idx" ON "bot_avatar_changes"("botId", "seq");
