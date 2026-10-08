CREATE TABLE "background_agent_tasks" (
    "taskId" TEXT NOT NULL,
    "parentRunId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "toolNames" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "result" TEXT,
    "error" TEXT,
    CONSTRAINT "background_agent_tasks_pkey" PRIMARY KEY ("taskId")
);

CREATE INDEX "background_agent_tasks_spaceId_threadId_status_idx"
    ON "background_agent_tasks"("spaceId", "threadId", "status");
CREATE INDEX "background_agent_tasks_parentRunId_idx"
    ON "background_agent_tasks"("parentRunId");

ALTER TABLE "background_agent_tasks"
    ADD CONSTRAINT "background_agent_tasks_parentRunId_fkey"
    FOREIGN KEY ("parentRunId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
