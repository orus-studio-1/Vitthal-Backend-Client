ALTER TABLE products
  ADD COLUMN IF NOT EXISTS specifications JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE products p
SET specifications = COALESCE(
  (
    SELECT jsonb_object_agg(ps.spec_key, ps.spec_value ORDER BY ps.created_at)
    FROM product_specification ps
    WHERE ps.product_id = p.id
      AND ps.approval_status = 'approved'
  ),
  '{}'::jsonb
)
WHERE p.specifications = '{}'::jsonb
  AND EXISTS (
    SELECT 1
    FROM product_specification ps
    WHERE ps.product_id = p.id
      AND ps.approval_status = 'approved'
  );
