-- 1. Create subcategories table (for all categories: product & service)
CREATE TABLE IF NOT EXISTS subcategories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID NOT NULL REFERENCES product_category(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_category_subcategory_name UNIQUE (category_id, name)
);

CREATE INDEX IF NOT EXISTS idx_subcategories_category_id ON subcategories(category_id);

-- 2. Migrate any existing records from service_subcategories to subcategories if any
INSERT INTO subcategories (id, category_id, name, description, created_at, updated_at)
SELECT id, category_id, name, description, created_at, updated_at
FROM service_subcategories
ON CONFLICT (category_id, name) DO NOTHING;

-- 3. Add subcategory_id column to products table
ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory_id UUID;

-- 4. Add foreign key constraint to products.subcategory_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_products_subcategory'
          AND table_name = 'products'
    ) THEN
        ALTER TABLE products
            ADD CONSTRAINT fk_products_subcategory
            FOREIGN KEY (subcategory_id)
            REFERENCES subcategories(id)
            ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_subcategory_id ON products(subcategory_id);
