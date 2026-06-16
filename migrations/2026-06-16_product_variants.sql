-- MIGRATION: 2026-06-16_product_variants.sql
-- Goal: Create product_variants table and migrate existing records in products, vendor_products, cart_items, wishlist_items, order_items, and quotation_requests to variants.

-- 1. Create product_variants table
CREATE TABLE IF NOT EXISTS product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL,
    sku TEXT,
    properties JSONB NOT NULL DEFAULT '{}'::jsonb, -- e.g., {"size": "10mm"}
    approval_status TEXT NOT NULL DEFAULT 'approved', -- 'pending', 'approved', 'rejected'
    approval_notes TEXT,
    created_by_user_id UUID,
    reviewed_by_user_id UUID,
    reviewed_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT fk_product_variants_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    CONSTRAINT fk_product_variants_created_by FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_product_variants_reviewed_by FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_product_variants_approval_status CHECK (approval_status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_approval_status ON product_variants(approval_status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_id_properties ON product_variants(product_id, properties);

-- 2. Backfill: Create a default variant for every existing product
INSERT INTO product_variants (product_id, sku, properties, approval_status, is_active)
SELECT id, item_code, '{}'::jsonb, 'approved', true FROM products
ON CONFLICT (product_id, properties) DO NOTHING;

-- 3. Modify vendor_products to reference product_variant_id
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS product_variant_id UUID;

-- Update existing vendor_products to point to the newly created default variants
UPDATE vendor_products vp
SET product_variant_id = pv.id
FROM product_variants pv
WHERE pv.product_id = vp.product_id AND vp.product_variant_id IS NULL;

-- Make product_variant_id NOT NULL now that it is backfilled
ALTER TABLE vendor_products ALTER COLUMN product_variant_id SET NOT NULL;

-- Drop old uniqueness constraint (vendor_id, product_id)
ALTER TABLE vendor_products DROP CONSTRAINT IF EXISTS unique_vendor_product;

-- Add new uniqueness constraint (vendor_id, product_variant_id)
ALTER TABLE vendor_products ADD CONSTRAINT unique_vendor_product_variant UNIQUE (vendor_id, product_variant_id);

-- Add foreign key constraint to product_variants
ALTER TABLE vendor_products ADD CONSTRAINT fk_vendor_products_variant FOREIGN KEY (product_variant_id) REFERENCES product_variants(id) ON DELETE CASCADE;

-- 4. Modify cart_items to reference product_variant_id
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS product_variant_id UUID;

-- Update existing cart_items to point to variants
UPDATE cart_items ci
SET product_variant_id = pv.id
FROM product_variants pv
WHERE pv.product_id = ci.product_id AND ci.product_variant_id IS NULL;

-- Make product_variant_id NOT NULL
ALTER TABLE cart_items ALTER COLUMN product_variant_id SET NOT NULL;

-- Drop old uniqueness constraint
ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS unique_cart_product_vendor;

-- Add new uniqueness constraint
ALTER TABLE cart_items ADD CONSTRAINT unique_cart_product_variant_vendor UNIQUE (cart_id, product_variant_id, vendor_id);

-- Add foreign key
ALTER TABLE cart_items ADD CONSTRAINT fk_cart_items_variant FOREIGN KEY (product_variant_id) REFERENCES product_variants(id) ON DELETE CASCADE;

-- 5. Modify wishlist_items to reference product_variant_id
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS product_variant_id UUID;

-- Update existing wishlist_items to point to variants
UPDATE wishlist_items wi
SET product_variant_id = pv.id
FROM product_variants pv
WHERE pv.product_id = wi.product_id AND wi.product_variant_id IS NULL;

-- Make product_variant_id NOT NULL
ALTER TABLE wishlist_items ALTER COLUMN product_variant_id SET NOT NULL;

-- Drop old uniqueness constraint
ALTER TABLE wishlist_items DROP CONSTRAINT IF EXISTS unique_wishlist_product;

-- Add new uniqueness constraint
ALTER TABLE wishlist_items ADD CONSTRAINT unique_wishlist_product_variant UNIQUE (wishlist_id, product_variant_id);

-- Add foreign key
ALTER TABLE wishlist_items ADD CONSTRAINT fk_wishlist_items_variant FOREIGN KEY (product_variant_id) REFERENCES product_variants(id) ON DELETE CASCADE;

-- 6. Modify order_items to reference product_variant_id (nullable for past order safety)
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_variant_id UUID;

-- Update existing order_items to point to default variants
UPDATE order_items oi
SET product_variant_id = pv.id
FROM product_variants pv
WHERE pv.product_id = oi.product_id AND oi.product_variant_id IS NULL;

-- Add foreign key
ALTER TABLE order_items ADD CONSTRAINT fk_order_items_variant FOREIGN KEY (product_variant_id) REFERENCES product_variants(id) ON DELETE SET NULL;

-- 7. Modify quotation_requests to reference product_variant_id (nullable for past request safety)
ALTER TABLE quotation_requests ADD COLUMN IF NOT EXISTS product_variant_id UUID;

-- Update existing quotation_requests to point to default variants
UPDATE quotation_requests qr
SET product_variant_id = pv.id
FROM product_variants pv
WHERE pv.product_id = qr.product_id AND qr.product_variant_id IS NULL;

-- Add foreign key
ALTER TABLE quotation_requests ADD CONSTRAINT fk_quotation_requests_variant FOREIGN KEY (product_variant_id) REFERENCES product_variants(id) ON DELETE CASCADE;
