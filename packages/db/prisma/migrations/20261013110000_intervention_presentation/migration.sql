-- Sanitized display snapshot on the Intervention row.
-- The card renders from this whitelist (question, safe detail, public
-- credential display fields) so a pending or terminal Intervention stays
-- complete after a refresh even when its source message left the current
-- page. Never an answer plaintext, a secret, or an ExternalEffect body.
-- Rows written before this column stay NULL; the read path synthesizes a
-- presentation from the Ask block for them, and the first terminalization
-- persists it.

ALTER TABLE "interventions" ADD COLUMN "presentation" JSONB;
