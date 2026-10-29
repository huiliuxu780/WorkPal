-- CARD-01E: persisted attention projection for pending Interventions.
--
-- CARD-01D read every pending Intervention on each attention request so it
-- could report an exact total. That materialization is proportional to all
-- outstanding requests, not to the page, and the read model never had a bound
-- of its own. This table keeps one narrow row per pending Intervention and is
-- maintained by the interventions trigger below. The queue then pages the
-- compact projection and counts it exactly without loading Intervention rows,
-- presentation JSON, or ExternalEffect facts for candidates it will not show.
--
-- The trigger derives userId from the owning Run, so every current and future
-- write path (including direct database inserts in tests) maintains the row by
-- construction. Rows are removed as soon as the Intervention leaves `pending`.

CREATE TABLE "attention_interventions" (
  "interactionId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "attentionAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3),

  CONSTRAINT "attention_interventions_pkey" PRIMARY KEY ("interactionId")
);

-- ASC defaults to NULLS LAST in PostgreSQL, which is the frozen attention sort
-- for a missing expiry. The trailing id keeps the keyset total order strict.
CREATE INDEX "attention_interventions_user_order"
  ON "attention_interventions" ("userId", "spaceId", "expiresAt", "attentionAt", "interactionId");

CREATE INDEX "attention_interventions_thread"
  ON "attention_interventions" ("threadId");

CREATE FUNCTION "sync_attention_intervention"() RETURNS trigger AS $$
DECLARE
  owner_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'pending' THEN
      DELETE FROM "attention_interventions" WHERE "interactionId" = OLD."id";
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."status" = 'pending' THEN
    SELECT run."userId" INTO owner_id FROM "runs" AS run WHERE run."id" = NEW."runId";
    IF owner_id IS NULL THEN
      RAISE EXCEPTION 'attention projection requires the owning run of intervention %', NEW."id";
    END IF;
    INSERT INTO "attention_interventions" (
      "interactionId",
      "spaceId",
      "userId",
      "threadId",
      "botId",
      "kind",
      "attentionAt",
      "expiresAt"
    ) VALUES (
      NEW."id",
      NEW."spaceId",
      owner_id,
      NEW."threadId",
      NEW."botId",
      NEW."kind",
      NEW."createdAt",
      NEW."expiresAt"
    )
    ON CONFLICT ("interactionId") DO UPDATE SET
      "spaceId" = EXCLUDED."spaceId",
      "userId" = EXCLUDED."userId",
      "threadId" = EXCLUDED."threadId",
      "botId" = EXCLUDED."botId",
      "kind" = EXCLUDED."kind",
      "attentionAt" = EXCLUDED."attentionAt",
      "expiresAt" = EXCLUDED."expiresAt";
  ELSE
    DELETE FROM "attention_interventions" WHERE "interactionId" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "interventions_attention_projection"
  AFTER INSERT OR UPDATE OR DELETE ON "interventions"
  FOR EACH ROW EXECUTE FUNCTION "sync_attention_intervention"();

-- Existing pending Interventions become addressable immediately after deploy.
INSERT INTO "attention_interventions" (
  "interactionId",
  "spaceId",
  "userId",
  "threadId",
  "botId",
  "kind",
  "attentionAt",
  "expiresAt"
)
SELECT
  intervention."id",
  intervention."spaceId",
  run."userId",
  intervention."threadId",
  intervention."botId",
  intervention."kind",
  intervention."createdAt",
  intervention."expiresAt"
FROM "interventions" AS intervention
JOIN "runs" AS run ON run."id" = intervention."runId"
WHERE intervention."status" = 'pending'
ON CONFLICT ("interactionId") DO NOTHING;
