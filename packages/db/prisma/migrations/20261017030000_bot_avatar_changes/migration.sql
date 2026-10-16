CREATE TABLE "bot_avatar_changes" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "runId" TEXT,
  "operationKey" TEXT,
  "beforeMode" TEXT NOT NULL,
  "beforeCharacter" TEXT,
  "beforeColor" TEXT NOT NULL,
  "afterMode" TEXT NOT NULL,
  "afterCharacter" TEXT,
  "afterColor" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undoneAt" TIMESTAMP(3),
  CONSTRAINT "bot_avatar_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bot_avatar_changes_source_check" CHECK ("source" IN ('user', 'bot')),
  CONSTRAINT "bot_avatar_changes_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "bot_avatar_changes_operationKey_key" ON "bot_avatar_changes"("operationKey");
CREATE INDEX "bot_avatar_changes_botId_createdAt_idx" ON "bot_avatar_changes"("botId", "createdAt");
