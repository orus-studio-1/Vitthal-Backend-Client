-- Used by the Admin Backend for vendor service edit approvals. Its own migration was never
-- applied on deploy, so this is written to be safe whether or not the columns already exist.
ALTER TABLE "vendor_services"
ADD COLUMN IF NOT EXISTS "pending_modifications" JSONB,
ADD COLUMN IF NOT EXISTS "modification_status" TEXT;

CREATE INDEX IF NOT EXISTS "idx_vendor_services_modification_status"
ON "vendor_services"("modification_status");
