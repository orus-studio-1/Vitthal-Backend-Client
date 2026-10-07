-- MIGRATION: 2026-06-08_dynamic_specifications.sql
-- Goal: Move 'material', 'grade', 'application', and 'standard' fields from products columns to dynamic specifications JSON / key-value table.

-- 1. Ensure 'specifications' column exists in products table (safeguard for older setups)
ALTER TABLE products ADD COLUMN IF NOT EXISTS specifications JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2. Backfill existing data to the product_specification table
-- Backfill material
INSERT INTO product_specification (product_id, spec_key, spec_value, approval_status, created_by_user_id)
SELECT 
    p.id, 
    'material', 
    p.material, 
    'approved', 
    COALESCE(p.created_by_user_id, (SELECT id FROM users WHERE role = 'super_admin' LIMIT 1), (SELECT id FROM users LIMIT 1))
FROM products p
WHERE p.material IS NOT NULL AND p.material <> ''
  AND NOT EXISTS (
      SELECT 1 FROM product_specification ps 
      WHERE ps.product_id = p.id AND ps.spec_key = 'material'
  );

-- Backfill grade
INSERT INTO product_specification (product_id, spec_key, spec_value, approval_status, created_by_user_id)
SELECT 
    p.id, 
    'grade', 
    p.grade, 
    'approved', 
    COALESCE(p.created_by_user_id, (SELECT id FROM users WHERE role = 'super_admin' LIMIT 1), (SELECT id FROM users LIMIT 1))
FROM products p
WHERE p.grade IS NOT NULL AND p.grade <> ''
  AND NOT EXISTS (
      SELECT 1 FROM product_specification ps 
      WHERE ps.product_id = p.id AND ps.spec_key = 'grade'
  );

-- Backfill application
INSERT INTO product_specification (product_id, spec_key, spec_value, approval_status, created_by_user_id)
SELECT 
    p.id, 
    'application', 
    p.application, 
    'approved', 
    COALESCE(p.created_by_user_id, (SELECT id FROM users WHERE role = 'super_admin' LIMIT 1), (SELECT id FROM users LIMIT 1))
FROM products p
WHERE p.application IS NOT NULL AND p.application <> ''
  AND NOT EXISTS (
      SELECT 1 FROM product_specification ps 
      WHERE ps.product_id = p.id AND ps.spec_key = 'application'
  );

-- Backfill standard
INSERT INTO product_specification (product_id, spec_key, spec_value, approval_status, created_by_user_id)
SELECT 
    p.id, 
    'standard', 
    p.standard, 
    'approved', 
    COALESCE(p.created_by_user_id, (SELECT id FROM users WHERE role = 'super_admin' LIMIT 1), (SELECT id FROM users LIMIT 1))
FROM products p
WHERE p.standard IS NOT NULL AND p.standard <> ''
  AND NOT EXISTS (
      SELECT 1 FROM product_specification ps 
      WHERE ps.product_id = p.id AND ps.spec_key = 'standard'
  );

-- 3. Synchronize products.specifications JSONB column with the approved specs
UPDATE products p
SET specifications = COALESCE(
    (
        SELECT jsonb_object_agg(ps.spec_key, ps.spec_value)
        FROM product_specification ps
        WHERE ps.product_id = p.id AND ps.approval_status = 'approved'
    ),
    '{}'::jsonb
);

-- 4. Safely drop old hardcoded columns from products table
ALTER TABLE products DROP COLUMN IF EXISTS material;
ALTER TABLE products DROP COLUMN IF EXISTS grade;
ALTER TABLE products DROP COLUMN IF EXISTS application;
ALTER TABLE products DROP COLUMN IF EXISTS standard;
