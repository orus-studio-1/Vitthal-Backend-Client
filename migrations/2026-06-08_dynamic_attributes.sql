-- Migration: 2026-06-08_dynamic_attributes.sql
-- Goal: Create attributes column and migrate material, grade, application, standard from specifications table.

-- 1. Ensure attributes column exists in products table
ALTER TABLE products ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2. Backfill existing material, grade, application, standard specs from product_specification to products.attributes
UPDATE products p
SET attributes = COALESCE(p.attributes, '{}'::jsonb) || COALESCE(
    (
        SELECT jsonb_object_agg(ps.spec_key, ps.spec_value)
        FROM product_specification ps
        WHERE ps.product_id = p.id
          AND ps.spec_key IN ('material', 'grade', 'application', 'standard')
    ),
    '{}'::jsonb
)
WHERE EXISTS (
    SELECT 1 
    FROM product_specification ps
    WHERE ps.product_id = p.id
      AND ps.spec_key IN ('material', 'grade', 'application', 'standard')
);

-- 3. Delete those keys from product_specification to keep them strictly separate
DELETE FROM product_specification
WHERE spec_key IN ('material', 'grade', 'application', 'standard');

-- 4. Clean up any specifications column from products if it was added
ALTER TABLE products DROP COLUMN IF EXISTS specifications;
