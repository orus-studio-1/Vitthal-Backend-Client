-- Standalone Migration File: V3 Updates - Stock Update & Price Approval Flow
-- Add pending_price column to vendor_products table
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS pending_price NUMERIC(12,2) DEFAULT NULL CHECK (pending_price >= 0);
