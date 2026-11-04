-- Vendor deletion requests stay live until an admin decides.
ALTER TABLE "vendor_products"
ADD COLUMN IF NOT EXISTS "deletion_status" TEXT,
ADD COLUMN IF NOT EXISTS "deletion_reason" TEXT,
ADD COLUMN IF NOT EXISTS "deletion_requested_at" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "idx_vendor_products_deletion_status"
ON "vendor_products"("deletion_status");

-- Vendor proposed sub-categories stay hidden until their service is approved. Existing rows are admin created.
ALTER TABLE "service_subcategories"
ADD COLUMN IF NOT EXISTS "approval_status" TEXT NOT NULL DEFAULT 'approved',
ADD COLUMN IF NOT EXISTS "created_by_user_id" UUID;

CREATE INDEX IF NOT EXISTS "idx_service_subcategories_approval_status"
ON "service_subcategories"("approval_status");

-- Vendor requests to remove approved media; the media stays live until an admin decides.
ALTER TABLE "services_media"
ADD COLUMN IF NOT EXISTS "removal_requested_at" TIMESTAMPTZ(6);

-- Clients now only see approved media, and until now nothing approved it. Keep what approved services already show.
UPDATE "services_media" sm
SET "approval_status" = 'approved', "is_approved" = TRUE
FROM "services" s
WHERE s."id" = sm."service_id" AND s."status" = 'approved' AND sm."approval_status" = 'pending';
