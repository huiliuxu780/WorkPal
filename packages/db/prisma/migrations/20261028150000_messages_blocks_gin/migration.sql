-- CARD-01D: JSONB containment index for the attention queue's pending approval
-- blocks. Without it each poll scans every bot message in the user's threads.
CREATE INDEX IF NOT EXISTS "messages_blocks_gin" ON "messages" USING GIN ("blocks" jsonb_path_ops);
