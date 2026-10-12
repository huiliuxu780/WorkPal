-- Lifecycle lookups filter background tasks by thread or bot, then status.
-- threadId + status uses the thread index. botId + status uses the bot index.
-- A filter on threadId + botId + status can use either leading pair.
CREATE INDEX "background_agent_tasks_threadId_status_idx"
    ON "background_agent_tasks"("threadId", "status");

CREATE INDEX "background_agent_tasks_botId_status_idx"
    ON "background_agent_tasks"("botId", "status");
