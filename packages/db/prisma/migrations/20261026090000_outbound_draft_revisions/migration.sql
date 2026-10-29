-- CARD-01B / A10: immutable outbound draft revisions. One row per saved edit;
-- revision 1 stays the effect's own request and is not stored here.
CREATE TABLE "outbound_draft_revisions" (
    "id" TEXT NOT NULL,
    "interventionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "recipients" JSONB NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_draft_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outbound_draft_revisions_interventionId_revision_key"
    ON "outbound_draft_revisions"("interventionId", "revision");

ALTER TABLE "outbound_draft_revisions"
    ADD CONSTRAINT "outbound_draft_revisions_interventionId_fkey"
    FOREIGN KEY ("interventionId") REFERENCES "interventions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;