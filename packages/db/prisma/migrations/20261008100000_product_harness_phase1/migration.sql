-- Product Harness Phase 1: group lead + run orchestration snapshot.

-- AlterTable
ALTER TABLE "chat_groups" ADD COLUMN     "leadBotId" TEXT;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "orchestration" JSONB;

-- Backfill: preserve the historical default explicitly. Each existing group's
-- lead becomes its earliest-created active member (deterministic tie-break on
-- botId); groups with no active member fall back to the earliest member at all.
UPDATE "chat_groups" AS g
SET "leadBotId" = sub."botId"
FROM (
  SELECT DISTINCT ON (m."groupId") m."groupId", m."botId"
  FROM "chat_group_members" m
  JOIN "bots" b ON b."id" = m."botId"
  ORDER BY m."groupId", (b."archivedAt" IS NULL) DESC, m."createdAt" ASC, m."botId" ASC
) AS sub
WHERE sub."groupId" = g.id AND g."leadBotId" IS NULL;

-- AddForeignKey
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_leadBotId_fkey" FOREIGN KEY ("leadBotId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
