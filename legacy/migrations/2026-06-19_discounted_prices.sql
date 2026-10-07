-- Migration: Add discounted_price to vendor_products and original_price to order_items
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS discounted_price NUMERIC(12,2) DEFAULT NULL CHECK (discounted_price >= 0);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS original_price NUMERIC(12,2) DEFAULT NULL;
