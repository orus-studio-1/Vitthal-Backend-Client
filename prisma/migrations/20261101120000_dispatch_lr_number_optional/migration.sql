-- The dispatch form needs only one of LR number, e-way bill, transporter or a document,
-- but the Admin Backend migration of 2026-09-30 created lr_number as NOT NULL, so saves
-- with documents only failed. Idempotent: DROP NOT NULL on a nullable column is a no-op.
ALTER TABLE "order_dispatch_details" ALTER COLUMN "lr_number" DROP NOT NULL;
