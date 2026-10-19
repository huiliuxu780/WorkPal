ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "avatarBodyColor" TEXT NOT NULL DEFAULT 'ink';
ALTER TABLE "bot_avatar_changes" ADD COLUMN IF NOT EXISTS "beforeBodyColor" TEXT NOT NULL DEFAULT 'ink';
ALTER TABLE "bot_avatar_changes" ADD COLUMN IF NOT EXISTS "afterBodyColor" TEXT NOT NULL DEFAULT 'ink';
