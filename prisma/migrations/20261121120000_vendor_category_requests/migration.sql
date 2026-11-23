-- Product vendors ask for extra product categories. An admin approves or rejects each requested
-- category on its own; approved ones are added to vendor_categories.
CREATE TABLE IF NOT EXISTS "vendor_category_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vendor_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "admin_note" TEXT,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    CONSTRAINT "vendor_category_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_vendor_category_requests_vendor" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE,
    CONSTRAINT "fk_vendor_category_requests_reviewer" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "chk_vendor_category_requests_status" CHECK ("status" IN ('pending', 'approved', 'partially_approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS "idx_vendor_category_requests_vendor_id" ON "vendor_category_requests"("vendor_id");
CREATE INDEX IF NOT EXISTS "idx_vendor_category_requests_status" ON "vendor_category_requests"("status", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "vendor_category_request_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    CONSTRAINT "vendor_category_request_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_vendor_category_request_items_request" FOREIGN KEY ("request_id") REFERENCES "vendor_category_requests"("id") ON DELETE CASCADE,
    CONSTRAINT "fk_vendor_category_request_items_category" FOREIGN KEY ("category_id") REFERENCES "product_category"("id") ON DELETE CASCADE,
    CONSTRAINT "unique_vendor_category_request_item" UNIQUE ("request_id", "category_id"),
    CONSTRAINT "chk_vendor_category_request_items_status" CHECK ("status" IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS "idx_vendor_category_request_items_category_id" ON "vendor_category_request_items"("category_id");

-- Vendors still pick at most 3 categories themselves (registration / setup). Categories an admin
-- approves through a request may go beyond that: the admin review sets this transaction-local flag.
CREATE OR REPLACE FUNCTION enforce_vendor_category_limit()
RETURNS TRIGGER AS $$
DECLARE
    category_count INTEGER;
BEGIN
    IF COALESCE(current_setting('app.vendor_category_admin_grant', true), '') = 'on' THEN
        RETURN NEW;
    END IF;

    SELECT COUNT(*) INTO category_count
    FROM vendor_categories
    WHERE vendor_id = NEW.vendor_id;

    IF category_count >= 3 THEN
        RAISE EXCEPTION 'A vendor can select up to 3 categories only';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
