-- ============================================
-- Migration: Quotation Documents & Vendor Terms
-- Date: 2026-05-27
-- Description:
--   1. Creates quotation_documents table (one PDF per quotation_group_id)
--   2. Adds delivery_days, token_percentage, token_amount, vendor_document fields
--      to quotation_requests for vendor-specific terms
-- ============================================

BEGIN;

-- 1. Quotation documents table
CREATE TABLE IF NOT EXISTS quotation_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quotation_group_id UUID NOT NULL,
    quotation_number TEXT NOT NULL UNIQUE,
    document_url TEXT NOT NULL,
    s3_key TEXT NOT NULL,
    valid_until DATE NOT NULL,
    product_id UUID NOT NULL,
    user_id UUID NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_qd_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    CONSTRAINT fk_qd_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_qd_group_id ON quotation_documents(quotation_group_id);
CREATE INDEX IF NOT EXISTS idx_qd_quotation_number ON quotation_documents(quotation_number);

-- 2. Vendor response terms on quotation_requests
ALTER TABLE quotation_requests ADD COLUMN IF NOT EXISTS delivery_days INTEGER CHECK (delivery_days > 0);
ALTER TABLE quotation_requests ADD COLUMN IF NOT EXISTS token_percentage NUMERIC(5,2) CHECK (token_percentage >= 0 AND token_percentage <= 100);
ALTER TABLE quotation_requests ADD COLUMN IF NOT EXISTS token_amount NUMERIC(12,2) CHECK (token_amount >= 0);
ALTER TABLE quotation_requests ADD COLUMN IF NOT EXISTS vendor_document_url TEXT;
ALTER TABLE quotation_requests ADD COLUMN IF NOT EXISTS vendor_document_s3_key TEXT;

-- 3. Sequence for quotation numbers (QTN-YYYY-NNNNN)
CREATE SEQUENCE IF NOT EXISTS quotation_number_seq START WITH 1 INCREMENT BY 1;

COMMIT;


-- 1. Alter the default column values for any future insertions
ALTER TABLE products ALTER COLUMN approval_status SET DEFAULT 'pending';
ALTER TABLE products ALTER COLUMN is_active SET DEFAULT FALSE;

-- 2. Update any existing pending products to be inactive so they are hidden from storefront
UPDATE products SET is_active = FALSE WHERE approval_status = 'pending';
