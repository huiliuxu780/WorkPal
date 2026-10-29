-- CARD-01E review fix: persist the strict-renderability decision in the
-- attention projection instead of re-reading and projecting every complex
-- pending row on each request.
--
-- `renderable` is maintained by the interventions trigger:
--   - plan_review: the nested plan payload is validated by
--     attention_plan_review_valid(), mirroring PlanReviewContentSchema.
--   - approval: when a RT-12 membership request exists, its presentation and
--     IDs are validated by attention_membership_renderable(); the request
--     trigger keeps the flag in sync when that request changes.
--   - input/other: simple shape is decided by the read eligibility predicate;
--     the flag stays true.
-- Dynamic facts (thread/group/Bot archival, expiry, membership permission and
-- effect status) remain read-time SQL filters, so they exit the queue without
-- rewriting the projection.

ALTER TABLE "attention_interventions" ADD COLUMN "renderable" BOOLEAN NOT NULL DEFAULT TRUE;

CREATE FUNCTION "attention_jsonb_keys_are"(value jsonb, expected text[]) RETURNS boolean AS $$
DECLARE
  key text;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' THEN
    RETURN false;
  END IF;
  FOR key IN SELECT jsonb_object_keys(value) LOOP
    IF NOT (key = ANY(expected)) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION "attention_jsonb_positive_int"(value jsonb) RETURNS boolean AS $$
DECLARE
  parsed numeric;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'number' THEN
    RETURN false;
  END IF;
  BEGIN
    parsed := (value #>> '{}')::numeric;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  RETURN parsed > 0 AND parsed = trunc(parsed);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION "attention_plan_review_valid"(review jsonb) RETURNS boolean AS $$
DECLARE
  content jsonb;
  item jsonb;
  status text;
  source text;
  decision text;
BEGIN
  IF review IS NULL OR jsonb_typeof(review) <> 'object' THEN
    RETURN false;
  END IF;
  IF NOT attention_jsonb_keys_are(review, ARRAY['content', 'decision', 'feedback']) THEN
    RETURN false;
  END IF;
  IF NOT (review ? 'content') THEN
    RETURN false;
  END IF;
  content := review -> 'content';
  IF jsonb_typeof(content) <> 'object' THEN
    RETURN false;
  END IF;
  IF NOT attention_jsonb_keys_are(
    content,
    ARRAY['planId', 'contentVersion', 'revision', 'goal', 'items', 'source']
  ) THEN
    RETURN false;
  END IF;
  IF NOT (
    content ? 'planId'
    AND content ? 'contentVersion'
    AND content ? 'revision'
    AND content ? 'goal'
    AND content ? 'items'
    AND content ? 'source'
  ) THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(content -> 'planId') <> 'string' OR length(content ->> 'planId') = 0 THEN
    RETURN false;
  END IF;
  IF NOT attention_jsonb_positive_int(content -> 'contentVersion')
     OR NOT attention_jsonb_positive_int(content -> 'revision') THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(content -> 'goal') <> 'string'
     OR length(content ->> 'goal') < 1
     OR length(content ->> 'goal') > 1000 THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(content -> 'items') <> 'array'
     OR jsonb_array_length(content -> 'items') < 1
     OR jsonb_array_length(content -> 'items') > 20 THEN
    RETURN false;
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(content -> 'items') LOOP
    IF jsonb_typeof(item) <> 'object' THEN
      RETURN false;
    END IF;
    IF NOT attention_jsonb_keys_are(item, ARRAY['id', 'title', 'status'])
       OR NOT (item ? 'id' AND item ? 'title' AND item ? 'status') THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(item -> 'id') <> 'string'
       OR length(item ->> 'id') < 1
       OR length(item ->> 'id') > 64 THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(item -> 'title') <> 'string'
       OR length(item ->> 'title') < 1
       OR length(item ->> 'title') > 200 THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(item -> 'status') <> 'string' THEN
      RETURN false;
    END IF;
    status := item ->> 'status';
    IF status NOT IN ('pending', 'active', 'completed', 'skipped', 'superseded', 'unresolved') THEN
      RETURN false;
    END IF;
  END LOOP;
  IF jsonb_typeof(content -> 'source') <> 'string' THEN
    RETURN false;
  END IF;
  source := content ->> 'source';
  IF source NOT IN ('plan_exit', 'plan_write', 'publish_run_plan', 'legacy_native') THEN
    RETURN false;
  END IF;
  IF review ? 'decision' THEN
    IF jsonb_typeof(review -> 'decision') <> 'string' THEN
      RETURN false;
    END IF;
    decision := review ->> 'decision';
    IF decision NOT IN ('approve', 'request_changes', 'reject') THEN
      RETURN false;
    END IF;
  END IF;
  IF review ? 'feedback' THEN
    IF jsonb_typeof(review -> 'feedback') <> 'string'
       OR length(review ->> 'feedback') > 2000 THEN
      RETURN false;
    END IF;
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION "attention_membership_renderable"(
  presentation jsonb,
  group_id text,
  bot_id text,
  request_id text,
  source_thread_id text,
  source_run_id text,
  source_message_id text,
  source_space_id text,
  request_revision integer
) RETURNS boolean AS $$
DECLARE
  credential jsonb;
  auth_type text;
BEGIN
  IF presentation IS NULL OR jsonb_typeof(presentation) <> 'object' THEN
    RETURN false;
  END IF;
  IF NOT attention_jsonb_keys_are(presentation, ARRAY['text', 'detail', 'credential']) THEN
    RETURN false;
  END IF;
  IF NOT (presentation ? 'text')
     OR jsonb_typeof(presentation -> 'text') <> 'string'
     OR length(presentation ->> 'text') > 4000 THEN
    RETURN false;
  END IF;
  IF presentation ? 'detail' THEN
    IF jsonb_typeof(presentation -> 'detail') <> 'string'
       OR length(presentation ->> 'detail') > 8000 THEN
      RETURN false;
    END IF;
  END IF;
  IF presentation ? 'credential' THEN
    credential := presentation -> 'credential';
    IF jsonb_typeof(credential) <> 'object'
       OR NOT attention_jsonb_keys_are(credential, ARRAY['name', 'origin', 'authType'])
       OR NOT (credential ? 'name' AND credential ? 'origin' AND credential ? 'authType') THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(credential -> 'name') <> 'string'
       OR length(credential ->> 'name') < 1
       OR length(credential ->> 'name') > 64 THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(credential -> 'origin') <> 'string'
       OR length(credential ->> 'origin') < 1
       OR length(credential ->> 'origin') > 2048 THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(credential -> 'authType') <> 'string' THEN
      RETURN false;
    END IF;
    auth_type := credential ->> 'authType';
    IF auth_type NOT IN ('bearer', 'header', 'basic', 'login') THEN
      RETURN false;
    END IF;
  END IF;
  IF group_id IS NULL OR length(group_id) = 0
     OR bot_id IS NULL OR length(bot_id) = 0
     OR request_id IS NULL OR length(request_id) = 0
     OR source_thread_id IS NULL OR length(source_thread_id) = 0
     OR source_run_id IS NULL OR length(source_run_id) = 0
     OR source_space_id IS NULL OR length(source_space_id) = 0 THEN
    RETURN false;
  END IF;
  IF source_message_id IS NOT NULL AND length(source_message_id) = 0 THEN
    RETURN false;
  END IF;
  IF request_revision IS NULL OR request_revision < 1 THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Recompute the projection flag from the same strict rules.
CREATE OR REPLACE FUNCTION "sync_attention_intervention"() RETURNS trigger AS $$
DECLARE
  owner_id TEXT;
  renderable BOOLEAN;
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
    renderable := CASE
      WHEN NEW."kind" = 'plan_review' THEN attention_plan_review_valid(NEW."planReview")
      WHEN NEW."kind" IN ('input', 'approval') THEN COALESCE((
        SELECT attention_membership_renderable(
          request."presentation",
          request."groupId",
          request."botId",
          request."id",
          request."sourceThreadId",
          request."sourceRunId",
          request."cardMessageId",
          request."spaceId",
          request."requestRevision"
        )
        FROM "group_membership_requests" AS request
        WHERE request."interventionId" = NEW."id"
        LIMIT 1
      ), TRUE)
      ELSE FALSE
    END;
    INSERT INTO "attention_interventions" (
      "interactionId",
      "spaceId",
      "userId",
      "threadId",
      "botId",
      "kind",
      "attentionAt",
      "expiresAt",
      "renderable"
    ) VALUES (
      NEW."id",
      NEW."spaceId",
      owner_id,
      NEW."threadId",
      NEW."botId",
      NEW."kind",
      NEW."createdAt",
      NEW."expiresAt",
      renderable
    )
    ON CONFLICT ("interactionId") DO UPDATE SET
      "spaceId" = EXCLUDED."spaceId",
      "userId" = EXCLUDED."userId",
      "threadId" = EXCLUDED."threadId",
      "botId" = EXCLUDED."botId",
      "kind" = EXCLUDED."kind",
      "attentionAt" = EXCLUDED."attentionAt",
      "expiresAt" = EXCLUDED."expiresAt",
      "renderable" = EXCLUDED."renderable";
  ELSE
    DELETE FROM "attention_interventions" WHERE "interactionId" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "sync_attention_membership"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."interventionId" IS NOT NULL THEN
      -- Without a request, an approval falls back to its effect projection;
      -- the read eligibility still requires an effect or request to exist.
      UPDATE "attention_interventions" SET "renderable" = TRUE
      WHERE "interactionId" = OLD."interventionId";
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."interventionId" IS NOT NULL THEN
    UPDATE "attention_interventions"
    SET "renderable" = attention_membership_renderable(
      NEW."presentation",
      NEW."groupId",
      NEW."botId",
      NEW."id",
      NEW."sourceThreadId",
      NEW."sourceRunId",
      NEW."cardMessageId",
      NEW."spaceId",
      NEW."requestRevision"
    )
    WHERE "interactionId" = NEW."interventionId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "group_membership_attention_projection"
  AFTER INSERT OR UPDATE OR DELETE ON "group_membership_requests"
  FOR EACH ROW EXECUTE FUNCTION "sync_attention_membership"();

-- Backfill every projection row, including rows inserted by the previous
-- migration's pending-Intervention backfill.
UPDATE "attention_interventions" AS ai
SET "renderable" = CASE
  WHEN intervention."kind" = 'plan_review'
    THEN attention_plan_review_valid(intervention."planReview")
  WHEN intervention."kind" = 'approval'
    THEN COALESCE((
      SELECT attention_membership_renderable(
        request."presentation",
        request."groupId",
        request."botId",
        request."id",
        request."sourceThreadId",
        request."sourceRunId",
        request."cardMessageId",
        request."spaceId",
        request."requestRevision"
      )
      FROM "group_membership_requests" AS request
      WHERE request."interventionId" = intervention."id"
      LIMIT 1
    ), TRUE)
  WHEN intervention."kind" = 'input' THEN TRUE
  ELSE FALSE
END
FROM "interventions" AS intervention
WHERE intervention."id" = ai."interactionId";
