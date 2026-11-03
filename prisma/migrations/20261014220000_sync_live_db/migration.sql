-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "public"."OrderStatus" AS ENUM ('placed', 'payment_pending', 'payment_completed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "public"."UserRole" AS ENUM ('client', 'vendor', 'admin', 'super_admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterEnum
ALTER TYPE "public"."vendor_approval_status" ADD VALUE IF NOT EXISTS 'reconsideration';

-- DropForeignKey
ALTER TABLE "public"."order_items" DROP CONSTRAINT IF EXISTS "fk_order_items_variant";

-- DropIndex
DROP INDEX IF EXISTS "public"."idx_carts_user_id";

-- DropIndex
DROP INDEX IF EXISTS "public"."idx_carts_user_type";

-- DropIndex
ALTER TABLE "public"."vendors" DROP CONSTRAINT IF EXISTS "vendors_gst_number_key";

-- AlterTable
ALTER TABLE "public"."contact_queries" ALTER COLUMN "email" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "public"."fulfillment_centers" ADD COLUMN IF NOT EXISTS "capacity" TEXT,
ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "public"."order_items" ALTER COLUMN "product_variant_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "dispatch_payment_percentage" DECIMAL(5,2) NOT NULL DEFAULT 75.00,
ADD COLUMN IF NOT EXISTS "dispatch_payment_status" VARCHAR(30) NOT NULL DEFAULT 'not_required',
ADD COLUMN IF NOT EXISTS "is_bulk_order" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "public"."payments" ADD COLUMN IF NOT EXISTS "dispatch_payment_request_id" UUID,
ADD COLUMN IF NOT EXISTS "payment_stage" VARCHAR(30) NOT NULL DEFAULT 'order';

-- AlterTable
ALTER TABLE "public"."product_category" ADD COLUMN IF NOT EXISTS "maximum_commision_percentage" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN IF NOT EXISTS "minimum_commision_percentage" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "image" SET DEFAULT '';

-- AlterTable
ALTER TABLE "public"."products" ALTER COLUMN "category" DROP NOT NULL;

-- AlterTable
ALTER TABLE "public"."quotation_requests" ALTER COLUMN "product_variant_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "public"."service_tickets" ADD COLUMN IF NOT EXISTS "closed_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS "payment_details" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN IF NOT EXISTS "payment_status" VARCHAR(30) NOT NULL DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS "review_comment" TEXT;

-- AlterTable
ALTER TABLE "public"."vendor_products" ADD COLUMN IF NOT EXISTS "modification_status" VARCHAR(50),
ADD COLUMN IF NOT EXISTS "pending_modifications" JSONB;

-- AlterTable
ALTER TABLE "public"."vendor_quotations" ADD COLUMN IF NOT EXISTS "product_id" UUID,
ADD COLUMN IF NOT EXISTS "quotation_kind" TEXT NOT NULL DEFAULT 'vendor_agreement';

-- AlterTable
ALTER TABLE "public"."vendors" ADD COLUMN IF NOT EXISTS "account_holder_name" VARCHAR(100),
ADD COLUMN IF NOT EXISTS "account_number" TEXT,
ADD COLUMN IF NOT EXISTS "account_number_last4" CHAR(4),
ADD COLUMN IF NOT EXISTS "bank_name" VARCHAR(100),
ADD COLUMN IF NOT EXISTS "cancelled_cheque_link" TEXT,
ADD COLUMN IF NOT EXISTS "ifsc_code" VARCHAR(20);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."Order" (
    "id" UUID NOT NULL,
    "customer_name" TEXT NOT NULL,
    "customer_email" TEXT NOT NULL,
    "customer_phone" TEXT,
    "vendor_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "total_amount" DOUBLE PRECISION NOT NULL,
    "status" "public"."OrderStatus" NOT NULL DEFAULT 'placed',
    "qr_code" TEXT,
    "order_notes" TEXT,
    "delivery_address" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."Product" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "product_type" TEXT,
    "specifications" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."ProductImage" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "image_url" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."User" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "public"."UserRole" NOT NULL DEFAULT 'client',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "refresh_token" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."Vendor" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "business_type" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."dispatch_payment_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "percentage" DECIMAL(5,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "razorpay_order_id" VARCHAR(255),
    "razorpay_payment_id" VARCHAR(255),
    "razorpay_signature" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_payment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."order_dispatch_details" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "lr_number" VARCHAR(100),
    "eway_bill_number" VARCHAR(100),
    "transporter_name" VARCHAR(150),
    "eway_bill_url" TEXT,
    "delivery_challan_url" TEXT,
    "invoice_url" TEXT,
    "lr_document_url" TEXT,
    "dispatched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_dispatch_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."payout_commission_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "vendor_commission_percentage" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "worker_commission_percentage" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_commission_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."vendor_payout_bank_access_audit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vendor_payout_request_id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "accessed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_payout_bank_access_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."vendor_payout_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vendor_id" UUID NOT NULL,
    "order_id" UUID,
    "booking_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'requested',
    "eligible_amount" DECIMAL(12,2) NOT NULL,
    "paid_amount" DECIMAL(12,2),
    "transfer_reference" TEXT,
    "rejection_reason" TEXT,
    "admin_note" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "processed_by" UUID,
    "gross_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "commission_percentage" DECIMAL(5,2) NOT NULL DEFAULT 0,

    CONSTRAINT "vendor_payout_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."vendor_payout_transfers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "transfer_reference" TEXT NOT NULL,
    "transferred_by" UUID NOT NULL,
    "transferred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_payout_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."worker_payout_bank_access_audit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "worker_payout_request_id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "accessed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_payout_bank_access_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."worker_payout_bank_details" (
    "worker_user_id" UUID NOT NULL,
    "bank_name" VARCHAR(100) NOT NULL,
    "account_holder_name" VARCHAR(100) NOT NULL,
    "account_number" TEXT NOT NULL,
    "account_number_last4" CHAR(4) NOT NULL,
    "ifsc_code" VARCHAR(20) NOT NULL,
    "cancelled_cheque_link" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_payout_bank_details_pkey" PRIMARY KEY ("worker_user_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."worker_payout_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "worker_user_id" UUID NOT NULL,
    "hire_request_id" UUID NOT NULL,
    "gross_amount" DECIMAL(12,2) NOT NULL,
    "commission_percentage" DECIMAL(5,2) NOT NULL,
    "eligible_amount" DECIMAL(12,2) NOT NULL,
    "paid_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'requested',
    "transfer_reference" TEXT,
    "rejection_reason" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "processed_by" UUID,

    CONSTRAINT "worker_payout_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."worker_payout_transfers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "transfer_reference" TEXT NOT NULL,
    "transferred_by" UUID NOT NULL,
    "transferred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_payout_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Order_qr_code_key" ON "public"."Order"("qr_code" ASC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "public"."User"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Vendor_email_key" ON "public"."Vendor"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "dispatch_payment_requests_order_id_key" ON "public"."dispatch_payment_requests"("order_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "dispatch_payment_requests_razorpay_order_id_key" ON "public"."dispatch_payment_requests"("razorpay_order_id" ASC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_dispatch_payment_requests_order" ON "public"."dispatch_payment_requests"("order_id" ASC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_dispatch_payment_requests_user_status" ON "public"."dispatch_payment_requests"("user_id" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_order_dispatch_vendor" ON "public"."order_dispatch_details"("vendor_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "order_dispatch_details_order_id_key" ON "public"."order_dispatch_details"("order_id" ASC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_vendor_payout_bank_audit_admin" ON "public"."vendor_payout_bank_access_audit"("admin_user_id" ASC, "accessed_at" ASC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_vendor_payout_bank_audit_request" ON "public"."vendor_payout_bank_access_audit"("vendor_payout_request_id" ASC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_vendor_payout_requests_vendor_status" ON "public"."vendor_payout_requests"("vendor_id" ASC, "status" ASC, "requested_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_vendor_payout_requests_active_booking" ON "public"."vendor_payout_requests"("booking_id" ASC) WHERE ((booking_id IS NOT NULL) AND ((status)::text = ANY ((ARRAY['requested'::character varying, 'partially_paid'::character varying, 'paid'::character varying])::text[])));

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_vendor_payout_requests_active_order" ON "public"."vendor_payout_requests"("order_id" ASC) WHERE ((order_id IS NOT NULL) AND ((status)::text = ANY ((ARRAY['requested'::character varying, 'partially_paid'::character varying, 'paid'::character varying])::text[])));

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_vendor_payout_requests_transfer_reference" ON "public"."vendor_payout_requests"("transfer_reference" ASC) WHERE (transfer_reference IS NOT NULL);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_vendor_payout_transfers_request" ON "public"."vendor_payout_transfers"("request_id" ASC, "transferred_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_payout_transfers_transfer_reference_key" ON "public"."vendor_payout_transfers"("transfer_reference" ASC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_worker_payout_bank_audit_admin" ON "public"."worker_payout_bank_access_audit"("admin_user_id" ASC, "accessed_at" ASC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_worker_payout_requests_worker_status" ON "public"."worker_payout_requests"("worker_user_id" ASC, "status" ASC, "requested_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_worker_payout_requests_active_hire" ON "public"."worker_payout_requests"("hire_request_id" ASC) WHERE ((status)::text = ANY ((ARRAY['requested'::character varying, 'partially_paid'::character varying, 'paid'::character varying])::text[]));

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_worker_payout_requests_transfer_reference" ON "public"."worker_payout_requests"("transfer_reference" ASC) WHERE (transfer_reference IS NOT NULL);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_worker_payout_transfers_request" ON "public"."worker_payout_transfers"("request_id" ASC, "transferred_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "worker_payout_transfers_transfer_reference_key" ON "public"."worker_payout_transfers"("transfer_reference" ASC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_addresses_user_id_unique" ON "public"."addresses"("user_id" ASC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_cart_items_product_variant_id" ON "public"."cart_items"("product_variant_id" ASC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_contact_queries_created_at" ON "public"."contact_queries"("created_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_contact_queries_status" ON "public"."contact_queries"("status" ASC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_oft_delivery_agent_id" ON "public"."order_fulfillment_tracking"("delivery_agent_id" ASC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_order_items_order_id" ON "public"."order_items"("order_id" ASC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_orders_dispatch_payment_status" ON "public"."orders"("dispatch_payment_status" ASC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_orders_vendor_id" ON "public"."orders"("vendor_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_payments_dispatch_payment_request" ON "public"."payments"("dispatch_payment_request_id" ASC) WHERE (dispatch_payment_request_id IS NOT NULL);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_service_tickets_asset_created" ON "public"."service_tickets"("asset_id" ASC, "created_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_vendor_quotations_product_id" ON "public"."vendor_quotations"("product_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_vendors_gst_number_unique" ON "public"."vendors"("gst_number" ASC) WHERE (gst_number IS NOT NULL);

-- RenameForeignKey
DO $$ BEGIN
  ALTER TABLE "public"."cart_items" RENAME CONSTRAINT "fk_cart_items_variant" TO "fk_cart_items_product_variant";
EXCEPTION WHEN undefined_object OR undefined_table OR duplicate_object OR duplicate_table THEN NULL;
END $$;

-- RenameForeignKey
DO $$ BEGIN
  ALTER TABLE "public"."fulfillment_centers" RENAME CONSTRAINT "fulfillment_centers_user_id_fkey" TO "fk_fulfillment_centers_user";
EXCEPTION WHEN undefined_object OR undefined_table OR duplicate_object OR duplicate_table THEN NULL;
END $$;

-- RenameForeignKey
DO $$ BEGIN
  ALTER TABLE "public"."quotation_documents" RENAME CONSTRAINT "quotation_documents_product_id_fkey" TO "fk_qd_product";
EXCEPTION WHEN undefined_object OR undefined_table OR duplicate_object OR duplicate_table THEN NULL;
END $$;

-- RenameForeignKey
DO $$ BEGIN
  ALTER TABLE "public"."quotation_documents" RENAME CONSTRAINT "quotation_documents_user_id_fkey" TO "fk_qd_user";
EXCEPTION WHEN undefined_object OR undefined_table OR duplicate_object OR duplicate_table THEN NULL;
END $$;

-- RenameForeignKey
DO $$ BEGIN
  ALTER TABLE "public"."services" RENAME CONSTRAINT "services_subcategory_id_fkey" TO "fk_services_subcategory";
EXCEPTION WHEN undefined_object OR undefined_table OR duplicate_object OR duplicate_table THEN NULL;
END $$;

-- RenameForeignKey
DO $$ BEGIN
  ALTER TABLE "public"."subcategories" RENAME CONSTRAINT "subcategories_category_id_fkey" TO "fk_subcategories_category_unified";
EXCEPTION WHEN undefined_object OR undefined_table OR duplicate_object OR duplicate_table THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_product_id_fkey') THEN
    ALTER TABLE "public"."Order" ADD CONSTRAINT "Order_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_vendor_id_fkey') THEN
    ALTER TABLE "public"."Order" ADD CONSTRAINT "Order_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProductImage_product_id_fkey') THEN
    ALTER TABLE "public"."ProductImage" ADD CONSTRAINT "ProductImage_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'delivery_agents_fulfillment_center_id_fkey') THEN
    ALTER TABLE "public"."delivery_agents" ADD CONSTRAINT "delivery_agents_fulfillment_center_id_fkey" FOREIGN KEY ("fulfillment_center_id") REFERENCES "public"."fulfillment_centers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_payment_requests_order_id_fkey') THEN
    ALTER TABLE "public"."dispatch_payment_requests" ADD CONSTRAINT "dispatch_payment_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_payment_requests_user_id_fkey') THEN
    ALTER TABLE "public"."dispatch_payment_requests" ADD CONSTRAINT "dispatch_payment_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_dispatch_details_order_id_fkey') THEN
    ALTER TABLE "public"."order_dispatch_details" ADD CONSTRAINT "order_dispatch_details_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_dispatch_details_vendor_id_fkey') THEN
    ALTER TABLE "public"."order_dispatch_details" ADD CONSTRAINT "order_dispatch_details_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_order_items_variant') THEN
    ALTER TABLE "public"."order_items" ADD CONSTRAINT "fk_order_items_variant" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_payout_requests_vendor_id_fkey') THEN
    ALTER TABLE "public"."vendor_payout_requests" ADD CONSTRAINT "vendor_payout_requests_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_payout_transfers_request_id_fkey') THEN
    ALTER TABLE "public"."vendor_payout_transfers" ADD CONSTRAINT "vendor_payout_transfers_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."vendor_payout_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_quotations_product') THEN
    ALTER TABLE "public"."vendor_quotations" ADD CONSTRAINT "fk_vendor_quotations_product" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_payout_bank_access_audit_worker_payout_request_id_fkey') THEN
    ALTER TABLE "public"."worker_payout_bank_access_audit" ADD CONSTRAINT "worker_payout_bank_access_audit_worker_payout_request_id_fkey" FOREIGN KEY ("worker_payout_request_id") REFERENCES "public"."worker_payout_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_payout_bank_details_worker_user_id_fkey') THEN
    ALTER TABLE "public"."worker_payout_bank_details" ADD CONSTRAINT "worker_payout_bank_details_worker_user_id_fkey" FOREIGN KEY ("worker_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_payout_requests_hire_request_id_fkey') THEN
    ALTER TABLE "public"."worker_payout_requests" ADD CONSTRAINT "worker_payout_requests_hire_request_id_fkey" FOREIGN KEY ("hire_request_id") REFERENCES "public"."hire_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_payout_requests_worker_user_id_fkey') THEN
    ALTER TABLE "public"."worker_payout_requests" ADD CONSTRAINT "worker_payout_requests_worker_user_id_fkey" FOREIGN KEY ("worker_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_payout_transfers_request_id_fkey') THEN
    ALTER TABLE "public"."worker_payout_transfers" ADD CONSTRAINT "worker_payout_transfers_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."worker_payout_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

-- RenameIndex
DO $$ BEGIN
  ALTER INDEX "public"."product_category_code_key" RENAME TO "idx_product_category_code";
EXCEPTION WHEN undefined_object OR undefined_table OR duplicate_object OR duplicate_table THEN NULL;
END $$;

-- RenameIndex
DO $$ BEGIN
  ALTER INDEX "public"."unique_cart_vendor_service" RENAME TO "service_cart_items_cart_id_vendor_service_id_key";
EXCEPTION WHEN undefined_object OR undefined_table OR duplicate_object OR duplicate_table THEN NULL;
END $$;

-- RenameIndex
DO $$ BEGIN
  ALTER INDEX "public"."users_email_key" RENAME TO "idx_users_email_unique";
EXCEPTION WHEN undefined_object OR undefined_table OR duplicate_object OR duplicate_table THEN NULL;
END $$;

-- RenameIndex
DO $$ BEGIN
  ALTER INDEX "public"."vendors_user_id_key" RENAME TO "idx_vendors_user_id_unique";
EXCEPTION WHEN undefined_object OR undefined_table OR duplicate_object OR duplicate_table THEN NULL;
END $$;

