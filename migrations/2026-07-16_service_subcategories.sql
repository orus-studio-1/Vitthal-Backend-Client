CREATE TABLE IF NOT EXISTS service_subcategories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID NOT NULL REFERENCES product_category(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_subcategory_name_per_category UNIQUE (category_id, name)
);

ALTER TABLE services ADD COLUMN IF NOT EXISTS subcategory_id UUID REFERENCES service_subcategories(id) ON DELETE SET NULL;
