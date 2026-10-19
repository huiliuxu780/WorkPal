-- MR-01-R3: stable logical operation identity across a manual-retry chain.
-- Existing rows keep their effect id so historical ops stay distinct.
ALTER TABLE "external_effects" ADD COLUMN "operationId" TEXT;

UPDATE "external_effects" SET "operationId" = "id" WHERE "operationId" IS NULL;

ALTER TABLE "external_effects" ALTER COLUMN "operationId" SET NOT NULL;

CREATE INDEX "external_effects_operationId_idx" ON "external_effects"("operationId");
