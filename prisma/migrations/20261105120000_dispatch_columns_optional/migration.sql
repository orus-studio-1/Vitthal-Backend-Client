-- The dispatch form needs only one detail or document, but production required some columns.
-- Idempotent: DROP NOT NULL on a nullable column is a no-op.
ALTER TABLE "order_dispatch_details" ALTER COLUMN "lr_number" DROP NOT NULL;
ALTER TABLE "order_dispatch_details" ALTER COLUMN "eway_bill_number" DROP NOT NULL;
ALTER TABLE "order_dispatch_details" ALTER COLUMN "transporter_name" DROP NOT NULL;
ALTER TABLE "order_dispatch_details" ALTER COLUMN "eway_bill_url" DROP NOT NULL;
ALTER TABLE "order_dispatch_details" ALTER COLUMN "delivery_challan_url" DROP NOT NULL;
ALTER TABLE "order_dispatch_details" ALTER COLUMN "invoice_url" DROP NOT NULL;
ALTER TABLE "order_dispatch_details" ALTER COLUMN "lr_document_url" DROP NOT NULL;
