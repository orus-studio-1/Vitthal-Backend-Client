-- Migration: 2026-06-19_add_variant_image_relation.sql
-- Goal: Add product_variant_id column to products_images table

-- 1. Add product_variant_id column if it doesn't exist
ALTER TABLE products_images ADD COLUMN IF NOT EXISTS product_variant_id UUID;

-- 2. Add foreign key constraint if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_products_images_product_variant'
          AND table_name = 'products_images'
    ) THEN
        ALTER TABLE products_images
            ADD CONSTRAINT fk_products_images_product_variant
            FOREIGN KEY (product_variant_id)
            REFERENCES product_variants(id)
            ON DELETE CASCADE;
    END IF;
END $$;

-- 3. Create index for fast retrieval of variant images
CREATE INDEX IF NOT EXISTS idx_products_images_variant_id ON products_images(product_variant_id);
