ALTER TABLE "messages"
  ADD COLUMN "originKind" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "authorUserId" TEXT;
