-- Migration: Add product-related notification types
-- Date: 2026-05-28
-- Description: Expands the notifications table constraints to support
--              product approval/rejection notification types and product references.

-- ================================
-- 1. Drop and recreate the notification type constraint
-- ================================
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS chk_notification_type;
ALTER TABLE notifications
    ADD CONSTRAINT chk_notification_type
    CHECK (type IN (
        -- Quotation-related
        'quotation_request_received',
        'quotation_offer_received',
        'quotation_counter_received',
        'quotation_accepted',
        'quotation_rejected',
        'admin_confirmation_sent',
        'admin_confirmation_accepted',
        'admin_confirmation_rejected',
        -- Product-related
        'product_approved',
        'product_rejected',
        'image_approved',
        'image_rejected',
        'vendor_product_approved',
        'vendor_product_rejected',
        -- General
        'general'
    ));

-- ================================
-- 2. Drop and recreate the reference type constraint
-- ================================
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS chk_notification_reference_type;
ALTER TABLE notifications
    ADD CONSTRAINT chk_notification_reference_type
    CHECK (reference_type IS NULL OR reference_type IN ('quotation', 'order', 'product'));
