-- Migration: Update vendor_products default status and active status for Supreme Admin Control
-- Description: Alters the default values for the 'vendor_products' table to ensure that new mappings are created as inactive and waiting for approval.

-- 1. Set default for is_active to FALSE
ALTER TABLE vendor_products ALTER COLUMN is_active SET DEFAULT FALSE;

-- 2. Set default for status to 'waiting'
ALTER TABLE vendor_products ALTER COLUMN status SET DEFAULT 'waiting'::vendor_product_status;
