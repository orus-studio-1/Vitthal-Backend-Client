-- Standalone Migration File: V2 Updates
-- Drop check constraint restricting product types to 'plastic' or 'metal'
ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_products_product_type;

-- Add gst_percentage column to vendor_products table
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS gst_percentage NUMERIC(5,2) DEFAULT 0.00;

-- Add media_type column to products_images table
ALTER TABLE products_images ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'image';

-- Add check constraint for media_type to products_images table
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'chk_products_images_media_type'
          AND table_name = 'products_images'
    ) THEN
        ALTER TABLE products_images
            ADD CONSTRAINT chk_products_images_media_type
            CHECK (media_type IN ('image', 'video'));
    END IF;
END $$;
