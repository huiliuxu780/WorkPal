ALTER TABLE "bots"
  ADD COLUMN "avatarMode" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "avatarCharacter" TEXT;

ALTER TABLE "bots"
  ADD CONSTRAINT "bots_avatar_identity_check" CHECK (
    ("avatarMode" = 'character' AND "avatarCharacter" IN ('dot', 'treble', 'wave', 'bounce'))
    OR ("avatarMode" IN ('legacy', 'upload') AND "avatarCharacter" IS NULL)
  );

CREATE INDEX "bots_userId_avatarMode_avatarCharacter_idx"
  ON "bots"("userId", "avatarMode", "avatarCharacter");
