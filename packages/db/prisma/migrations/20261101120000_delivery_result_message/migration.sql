-- The visible message a delivery record projects its envelope onto. The envelope
-- fields themselves stay a read-time projection.
ALTER TABLE "delivery_records" ADD COLUMN "resultMessageId" TEXT;
