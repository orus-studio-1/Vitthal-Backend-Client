-- Migration: Update notifications constraint for service types
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS chk_notification_reference_type;
ALTER TABLE notifications
    ADD CONSTRAINT chk_notification_reference_type
    CHECK (reference_type IS NULL OR reference_type IN ('quotation', 'order', 'product', 'service_quotation', 'service_booking'));
