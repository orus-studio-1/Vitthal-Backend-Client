-- Migration: Add pickup and delivery verification tokens to orders table
-- Date: 2026-07-06

ALTER TABLE orders 
    ADD COLUMN IF NOT EXISTS pickup_otp VARCHAR(6),
    ADD COLUMN IF NOT EXISTS pickup_qr_token VARCHAR(255),
    ADD COLUMN IF NOT EXISTS delivery_otp VARCHAR(6),
    ADD COLUMN IF NOT EXISTS delivery_qr_token VARCHAR(255);
