-- ============================================
-- MIGRATION: Product-Level Quotation Limit
-- Date: 2026-05-27
-- Description:
--   Move quotation threshold from vendor_products to products.
--   quotation_limit on products = universal threshold for this product.
--   quotation_enabled on vendor_products = opt-in flag (vendor participates in quotation deals).
--   quotation_group_id on quotation_requests = groups multi-vendor quotation requests.
--   vendor_can_set_quotation_limit = admin toggle allowing vendors to set quotation_limit.
-- ============================================

-- ================================
-- 1. Add quotation_limit to products
-- ================================
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS quotation_limit INTEGER CHECK (quotation_limit > 0);

-- Admin toggle: if TRUE, vendors can also set/suggest quotation_limit for products.
-- Admin always has superiority (can override).
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS vendor_can_set_quotation_limit BOOLEAN NOT NULL DEFAULT FALSE;

-- ================================
-- 2. Add quotation_group_id to quotation_requests
--    Groups quotation requests for the same product+client across multiple vendors.
-- ================================
ALTER TABLE quotation_requests
    ADD COLUMN IF NOT EXISTS quotation_group_id UUID;

CREATE INDEX IF NOT EXISTS idx_quotation_requests_group_id
    ON quotation_requests(quotation_group_id)
    WHERE quotation_group_id IS NOT NULL;

-- ================================
-- 3. Migrate existing vendor-level quotation_min_qty to product-level quotation_limit
--    Strategy: Take MAX(quotation_min_qty) across all vendors for each product.
-- ================================
UPDATE products p
SET quotation_limit = sub.max_min_qty
FROM (
    SELECT product_id, MAX(quotation_min_qty) AS max_min_qty
    FROM vendor_products
    WHERE quotation_enabled = TRUE
      AND quotation_min_qty IS NOT NULL
      AND quotation_min_qty > 0
    GROUP BY product_id
) sub
WHERE p.id = sub.product_id
  AND p.quotation_limit IS NULL;

-- ================================
-- 4. Group existing quotation_requests by (user_id, product_id) and assign group IDs
--    So existing quotations for the same product by the same client are grouped.
-- ================================
WITH groups AS (
    SELECT
        user_id,
        product_id,
        gen_random_uuid() AS group_id
    FROM quotation_requests
    WHERE quotation_group_id IS NULL
    GROUP BY user_id, product_id
)
UPDATE quotation_requests qr
SET quotation_group_id = g.group_id
FROM groups g
WHERE qr.user_id = g.user_id
  AND qr.product_id = g.product_id
  AND qr.quotation_group_id IS NULL;
