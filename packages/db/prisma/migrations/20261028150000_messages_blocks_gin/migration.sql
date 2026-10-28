-- CARD-01D: the attention queue matches pending approval blocks with JSONB
-- containment. Build concurrently so an existing deployment keeps writing
-- messages while the index is created.
CREATE INDEX CONCURRENTLY "messages_blocks_gin"
ON "messages" USING GIN ("blocks" jsonb_path_ops);
