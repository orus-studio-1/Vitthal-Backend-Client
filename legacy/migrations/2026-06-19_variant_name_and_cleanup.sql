-- Migration: 2026-06-19_variant_name_and_cleanup.sql
-- Goal: Add name column to product_variants and backfill existing variants.

-- 1. Add name column if it doesn't exist
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS name TEXT;

-- 2. Backfill existing variant names using properties JSONB
UPDATE product_variants
SET name = (
    SELECT COALESCE(string_agg(key || ': ' || value, ', '), 'Default Variation')
    FROM jsonb_each_text(properties)
)
WHERE name IS NULL AND properties IS NOT NULL AND properties != '{}'::jsonb;

-- 3. Set default for empty properties
UPDATE product_variants
SET name = 'Default Variation'
WHERE name IS NULL AND (properties IS NULL OR properties = '{}'::jsonb);
