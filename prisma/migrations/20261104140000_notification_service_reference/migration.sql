-- Production kept an older check that rejected reference_type 'service', so service notifications were lost.
-- NOT VALID so old rows are never rechecked; every new row must follow these lists.
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "chk_notification_reference_type";
ALTER TABLE "notifications"
ADD CONSTRAINT "chk_notification_reference_type"
CHECK ("reference_type" IS NULL OR "reference_type" IN ('quotation', 'order', 'product', 'service', 'service_quotation', 'service_booking', 'service_ticket', 'hire_request')) NOT VALID;

ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "chk_notification_type";
ALTER TABLE "notifications"
ADD CONSTRAINT "chk_notification_type"
CHECK ("type" IN ('admin_confirmation_accepted', 'admin_confirmation_rejected', 'admin_confirmation_sent', 'general', 'hire_completion_confirmed', 'hire_contract_completed', 'hire_message', 'hire_offer_accepted', 'hire_offer_received', 'hire_payment_successful', 'hire_request_accepted', 'hire_request_cancelled', 'hire_request_received', 'hire_request_rejected', 'hiring_access_unlocked', 'image_approved', 'image_rejected', 'product_approved', 'product_rejected', 'quotation_accepted', 'quotation_counter_received', 'quotation_dispatch_payment_requested', 'quotation_dispatched', 'quotation_offer_received', 'quotation_rejected', 'quotation_request_received', 'service_completed', 'vendor_product_approved', 'vendor_product_rejected')) NOT VALID;
