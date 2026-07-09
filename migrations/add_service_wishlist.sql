-- Migration: add_service_wishlist.sql
-- Makes product columns nullable, adds service_id FK, and adds check constraints

-- 1. Make product columns nullable (were NOT NULL)
ALTER TABLE wishlist_items
    ALTER COLUMN product_id           DROP NOT NULL,
    ALTER COLUMN product_variant_id   DROP NOT NULL;

-- 2. Add service_id column (nullable FK to services table)
ALTER TABLE wishlist_items
    ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES services(id) ON DELETE CASCADE;

-- 3. CHECK: each row is either a product row OR a service row, never both
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'chk_wishlist_item_type'
          AND table_name = 'wishlist_items'
    ) THEN
        ALTER TABLE wishlist_items
            ADD CONSTRAINT chk_wishlist_item_type
            CHECK (
                (product_id IS NOT NULL AND product_variant_id IS NOT NULL AND service_id IS NULL)
                OR
                (service_id IS NOT NULL AND product_id IS NULL AND product_variant_id IS NULL)
            );
    END IF;
END $$;

-- 4. Unique constraint to prevent duplicate service entries in same wishlist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'unique_wishlist_service'
          AND table_name = 'wishlist_items'
    ) THEN
        ALTER TABLE wishlist_items
            ADD CONSTRAINT unique_wishlist_service UNIQUE (wishlist_id, service_id);
    END IF;
END $$;

