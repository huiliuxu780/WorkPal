-- Preserve uploaded image bytes and the original color value for rollback.
-- Stable MD5 bucketing makes the one-time legacy conversion independent of row order.
WITH identities AS (
  SELECT "id", "color" LIKE 'data:image/%' AS "uploaded",
         get_byte(decode(md5("id"), 'hex'), 0) % 4 AS "bucket"
  FROM "bots"
  WHERE "avatarMode" = 'legacy'
)
UPDATE "bots" AS bot
SET "avatarMode" = CASE WHEN identities."uploaded" THEN 'upload' ELSE 'character' END,
    "avatarCharacter" = CASE
      WHEN identities."uploaded" THEN NULL
      WHEN identities."bucket" = 0 THEN 'dot'
      WHEN identities."bucket" = 1 THEN 'treble'
      WHEN identities."bucket" = 2 THEN 'wave'
      ELSE 'bounce'
    END
FROM identities
WHERE bot."id" = identities."id";
