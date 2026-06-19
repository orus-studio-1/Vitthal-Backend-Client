-- SETUP INSTRUCTIONS:
-- 1. Create a new database (in psql): CREATE DATABASE vitthal_db;
-- 2. Connect to it: \c vitthal_db;
-- 3. Then run this entire script.

-- This schema is designed to be idempotent where PostgreSQL supports it.

-- ============================================
-- B2B Multi-Vendor Marketplace - PostgreSQL Schema
-- ============================================

-- ================================
-- EXTENSIONS
-- ================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- PostGIS is optional. This schema stores latitude/longitude as numeric columns,
-- so it works on plain PostgreSQL without PostGIS installed.

-- ================================
-- TYPES
-- ================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('client', 'vendor', 'admin', 'super_admin');
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vendor_product_status') THEN
        CREATE TYPE vendor_product_status AS ENUM ('active', 'inactive', 'out_of_stock', 'discontinued', 'waiting');
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vendor_approval_status') THEN
        CREATE TYPE vendor_approval_status AS ENUM ('pending', 'agreement_sent', 'approved', 'rejected');
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status') THEN
        CREATE TYPE order_status AS ENUM ('pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded', 'handed_over', 'received', 'dispatched');
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cart_type') THEN
        CREATE TYPE cart_type AS ENUM ('direct', 'quotation');
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quotation_status') THEN
        CREATE TYPE quotation_status AS ENUM (
            'pending_vendor',
            'vendor_offered',
            'vendor_countered',
            'client_countered',
            'client_accepted',
            'client_rejected',
            'vendor_rejected',
            'cancelled',
            'expired',
            'admin_confirmation_pending',
            'admin_confirmed',
            'admin_confirmation_rejected'
        );
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quotation_message_action') THEN
        CREATE TYPE quotation_message_action AS ENUM ('request', 'offer', 'counter', 'accept', 'reject', 'note', 'admin_confirm_request', 'admin_confirmed', 'admin_rejected');
    END IF;
END$$;

-- ================================
-- AUTHENTICATION LAYER
-- ================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email CITEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role user_role NOT NULL DEFAULT 'client',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    OTP TEXT,
    refresh_token TEXT,
    OTP_Expiry TIMESTAMPTZ,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ================================
-- BUSINESS LAYER
-- ================================

CREATE TABLE IF NOT EXISTS vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE,
    company_name TEXT NOT NULL,
    gst_number TEXT UNIQUE,
    gst_certificate_link TEXT,
    business_type TEXT,
    company_website TEXT,
    phone TEXT,
    alternative_number TEXT,
    designation TEXT,
    business_description TEXT,
    credit_cycle TEXT,
    minimum_commision_percentage INTEGER DEFAULT 0,
    maximum_commision_percentage INTEGER DEFAULT 0,
    application_number TEXT UNIQUE,
    rating NUMERIC(2,1) NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
    review_count INTEGER NOT NULL DEFAULT 0,
    is_approved BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
    approval_status vendor_approval_status NOT NULL DEFAULT 'pending',
    approval_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_vendors_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_category (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    description TEXT,
    image TEXT NOT NULL,
    min_commision_percentage INTEGER NOT NULL DEFAULT 0,
    max_commision_percentage INTEGER NOT NULL DEFAULT 10,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ================================
-- SEED: default product categories (idempotent)
-- These inserts are guarded by WHERE NOT EXISTS so running the script
-- multiple times will not create duplicates.
-- ================================
INSERT INTO product_category (code, label, description, image, sort_order, is_active) VALUES
('metal_fabrication_parts', 'Metal & Fabrication Products', 'Sheet metal, structural parts, and custom fabricated components.', 'https://res.cloudinary.com/djolzxgct/image/upload/v1780292933/Metal_Fabricated_n51kin.jpg', 1, true),
('electrical_automation_components', 'Electrical & Electronics Manufacturing', 'Industrial panels, sensors, and automation hardware.', 'https://res.cloudinary.com/djolzxgct/image/upload/v1780293409/Electrical_Electronics_twuwgm.jpg', 2, true),
('industrial_machinery_equipment', 'Machinery & Industrial Equipment', 'Pumps, compressors, conveyor systems, and packaging machines.', 'https://res.cloudinary.com/djolzxgct/image/upload/v1780293705/Industrial_Machinery_jubodl.jpg', 3, true),
('construction_building_materials', 'Construction & Building Material', 'Hardware, roofing, flooring, and structural materials.', 'https://res.cloudinary.com/djolzxgct/image/upload/v1780294255/Construction_zozolo.jpg', 4, true),
('automotive_spare_parts', 'Automobile & Auto Parts', 'Engine parts, braking systems, and EV components.', 'https://res.cloudinary.com/djolzxgct/image/upload/v1780294268/Automative_part_tusmob.jpg', 5, true),
('plastic_polymer_components', 'Plastic & Polymer Products', 'Injection molded parts and industrial plastic components.', 'https://res.cloudinary.com/djolzxgct/image/upload/v1780294480/Plastic_polymer_ysm22x.jpg', 6, true),
('food_agriculture_supplies', 'Food & Agriculture Processing', 'Agro-equipment, processing inputs, and organic supplies.', 'https://res.cloudinary.com/djolzxgct/image/upload/v1780294555/Food_Agriculture_heawd4.jpg', 7, true),
('laboratory_pharma_consumables', 'Chemical & Pharma Manufacturing', 'Chemicals, additives, and medical consumables.', 'https://res.cloudinary.com/djolzxgct/image/upload/v1780294629/Pharamas_labs_nigahy.jpg', 8, true),
('modular_furniture_wood', 'Furniture & Wood Products', 'Office, kitchen, and interior decorative products.', 'https://res.cloudinary.com/djolzxgct/image/upload/v1780294735/Furniture_uig7s6.jpg', 9, true),
('renewable_energy_systems', 'Renewable Energy Products', 'Solar panels, inverters, and energy storage solutions.', 'https://res.cloudinary.com/djolzxgct/image/upload/v1780294829/Renewable_Energy_piev0o.jpg', 10, true),
('packaging_logistics_supplies', 'Packaging Industry', 'Corrugated boxes, labels, and industrial pallets.', 'https://res.cloudinary.com/djolzxgct/image/upload/v1780294984/Packaging_boxes_mivqtz.jpg', 11, true),
('textile_garment_materials', 'Textile & Garments', 'Fabrics, yarns, and industrial safety apparel.', 'https://res.cloudinary.com/djolzxgct/image/upload/v1780295062/Textile_gqybcg.jpg', 12, true),
('cnc_industrial_tooling', 'CNC & VMC Tooling Product Categories', 'Precision cutting tools, holders, and inserts for CNC machines.', 'https://res.cloudinary.com/djolzxgct/image/upload/v1780295138/CNCC_Industrial_Tooling_vqipnh.jpg', 13, true);


CREATE TABLE IF NOT EXISTS vendor_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id UUID NOT NULL,
    category_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_vendor_category_selection UNIQUE (vendor_id, category_id),
    CONSTRAINT fk_vendor_categories_vendor
        FOREIGN KEY (vendor_id)
        REFERENCES vendors(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_vendor_categories_category
        FOREIGN KEY (category_id)
        REFERENCES product_category(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vendor_categories_vendor_id ON vendor_categories(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_categories_category_id ON vendor_categories(category_id);

CREATE OR REPLACE FUNCTION enforce_vendor_category_limit()
RETURNS TRIGGER AS $$
DECLARE
    category_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO category_count
    FROM vendor_categories
    WHERE vendor_id = NEW.vendor_id;

    IF category_count >= 3 THEN
        RAISE EXCEPTION 'A vendor can select up to 3 categories only';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vendor_category_limit ON vendor_categories;
CREATE TRIGGER trg_vendor_category_limit
BEFORE INSERT ON vendor_categories
FOR EACH ROW
EXECUTE FUNCTION enforce_vendor_category_limit();

-- ================================
-- CATALOG LAYER
-- ================================

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    category UUID NOT NULL,
    product_type TEXT,
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    item_code TEXT,
    approval_status TEXT NOT NULL DEFAULT 'pending',
    approval_notes TEXT,
    created_by_user_id UUID,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    quotation_limit INTEGER CHECK (quotation_limit > 0),
    vendor_can_set_quotation_limit BOOLEAN NOT NULL DEFAULT FALSE,
    rating NUMERIC(2,1) NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
    review_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_products_category
        FOREIGN KEY (category)
        REFERENCES product_category(id)
);

CREATE TABLE IF NOT EXISTS products_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL,
    image_url TEXT NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_approved BOOLEAN NOT NULL DEFAULT false,
    approval_status TEXT NOT NULL DEFAULT 'pending',
    created_by_user_id UUID,
    reviewed_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    media_type TEXT DEFAULT 'image',
    CONSTRAINT chk_products_images_status
        CHECK (approval_status IN ('pending', 'approved', 'rejected')),
    CONSTRAINT chk_products_images_media_type
        CHECK (media_type IN ('image', 'video')),
    CONSTRAINT fk_products_images_product
        FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_products_images_created_by
        FOREIGN KEY (created_by_user_id)
        REFERENCES users(id)
        ON DELETE SET NULL,
    CONSTRAINT fk_products_images_reviewed_by
        FOREIGN KEY (reviewed_by_user_id)
        REFERENCES users(id)
        ON DELETE SET NULL
);

-- ================================
-- TRANSACTION LOGIC LAYER
-- ================================

CREATE TABLE IF NOT EXISTS product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL,
    sku TEXT,
    properties JSONB NOT NULL DEFAULT '{}'::jsonb,
    approval_status TEXT NOT NULL DEFAULT 'approved',
    approval_notes TEXT,
    created_by_user_id UUID,
    reviewed_by_user_id UUID,
    reviewed_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_product_variants_product
        FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_product_variants_created_by
        FOREIGN KEY (created_by_user_id)
        REFERENCES users(id)
        ON DELETE SET NULL,
    CONSTRAINT fk_product_variants_reviewed_by
        FOREIGN KEY (reviewed_by_user_id)
        REFERENCES users(id)
        ON DELETE SET NULL,
    CONSTRAINT chk_product_variants_approval_status
        CHECK (approval_status IN ('pending', 'approved', 'rejected')),
    CONSTRAINT uq_product_id_properties
        UNIQUE (product_id, properties)
);

CREATE TABLE IF NOT EXISTS vendor_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL,
    product_variant_id UUID NOT NULL,
    vendor_id UUID NOT NULL,
    price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    moq INTEGER NOT NULL CHECK (moq > 0),
    stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    quotation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    quotation_min_qty INTEGER CHECK (quotation_min_qty > 0),
    commision_percentage INTEGER DEFAULT 0 CHECK (commision_percentage >= 0 AND commision_percentage <= 100),
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    status vendor_product_status NOT NULL DEFAULT 'waiting',
    gst_percentage NUMERIC(5,2) DEFAULT 0.00,
    pending_price NUMERIC(12,2) DEFAULT NULL CHECK (pending_price >= 0),
    discounted_price NUMERIC(12,2) DEFAULT NULL CHECK (discounted_price >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_vendor_product_variant UNIQUE (vendor_id, product_variant_id),
    CONSTRAINT fk_vendor_products_product
        FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_vendor_products_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_vendor_products_vendor
        FOREIGN KEY (vendor_id)
        REFERENCES vendors(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_specification(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    product_id UUID NOT NULL,

    spec_key TEXT NOT NULL,
    spec_value TEXT,
    approval_status TEXT NOT NULL DEFAULT 'pending',
    approval_notes TEXT,

    created_by_user_id UUID NOT NULL, -- user_id (admin/vendor)
    reviewed_by_user_id UUID,
    reviewed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_product_specification_status
        CHECK (approval_status IN ('pending', 'approved', 'rejected')),

    CONSTRAINT fk_product_specifications_product
        FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_product_specifications_created_by
        FOREIGN KEY (created_by_user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_product_specifications_reviewed_by
        FOREIGN KEY (reviewed_by_user_id)
        REFERENCES users(id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_product_specification_product_id ON product_specification(product_id);
CREATE INDEX IF NOT EXISTS idx_product_specification_status ON product_specification(approval_status);

CREATE TABLE IF NOT EXISTS addresses(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    address TEXT NOT NULL,
    address_line1 TEXT,
    address_line2 TEXT,
    landmark TEXT,
    address_phone TEXT,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    country TEXT NOT NULL,
    pincode VARCHAR(6) NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
    latitude DOUBLE PRECISION CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_addresses_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_addresses_user_id ON addresses(user_id);

CREATE TABLE IF NOT EXISTS client(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE,
    phone TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_client_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS wishlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_wishlists_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS wishlist_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wishlist_id UUID NOT NULL,
    product_id UUID NOT NULL,
    product_variant_id UUID NOT NULL,
    vendor_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_wishlist_product_variant UNIQUE (wishlist_id, product_variant_id),
    CONSTRAINT fk_wishlist_items_wishlist
        FOREIGN KEY (wishlist_id)
        REFERENCES wishlists(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_wishlist_items_product
        FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_wishlist_items_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_wishlist_items_vendor
        FOREIGN KEY (vendor_id)
        REFERENCES vendors(id)
        ON DELETE SET NULL
);

    CREATE TABLE IF NOT EXISTS abandoned_reminder_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('cart', 'wishlist')),
        source_item_id UUID NOT NULL,
        reminder_type TEXT NOT NULL DEFAULT '24h_abandoned_reminder',
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT unique_abandoned_reminder_source UNIQUE (source_type, source_item_id, reminder_type),
        CONSTRAINT fk_abandoned_reminder_logs_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS fulfillment_centers(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    country TEXT NOT NULL,
    pincode VARCHAR(6) NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
    latitude DOUBLE PRECISION CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180),
    capacity TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_fulfillment_centers_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

-- ================================
-- CART SYSTEM
-- ================================

--cart : 
CREATE TABLE IF NOT EXISTS carts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL,
    cart_type cart_type NOT NULL DEFAULT 'direct',

    status TEXT NOT NULL DEFAULT 'active', 
    -- future: active, converted, abandoned, saved

    total_amount NUMERIC(12,2) DEFAULT 0, -- optional (can be computed)

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_carts_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_carts_user_type_status
    ON carts(user_id, cart_type) WHERE status = 'active';

--cart_items : 
CREATE TABLE IF NOT EXISTS cart_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    cart_id UUID NOT NULL,
    product_id UUID NOT NULL,
    product_variant_id UUID NOT NULL,
    vendor_id UUID NOT NULL,

    quantity INTEGER NOT NULL CHECK (quantity > 0),

    price_at_added NUMERIC(12,2) NOT NULL, -- snapshot price

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_cart_items_cart
        FOREIGN KEY (cart_id)
        REFERENCES carts(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_cart_items_product
        FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_cart_items_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_cart_items_vendor
        FOREIGN KEY (vendor_id)
        REFERENCES vendors(id)
        ON DELETE CASCADE,

    CONSTRAINT unique_cart_product_variant_vendor
        UNIQUE (cart_id, product_variant_id, vendor_id)
);

-- ================================
-- ORDERS
-- ================================
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL,
    vendor_id UUID NOT NULL,

    cart_id UUID, -- reference to original cart (optional but useful)

    status TEXT NOT NULL DEFAULT 'pending',
    -- pending, confirmed, shipped, delivered, cancelled

    payment_status TEXT DEFAULT 'pending',
    -- pending, paid, failed

    order_type TEXT NOT NULL DEFAULT 'direct',
    -- direct, quotation

    total_amount NUMERIC(12,2) NOT NULL,
    source TEXT NOT NULL DEFAULT 'client',
    order_reference TEXT,
    order_notes TEXT,
    customer_name TEXT,
    customer_email TEXT,
    customer_phone TEXT,
    created_by_admin_id TEXT,

    -- for storing address(not storing address refrence but storing address directly, because if refrence is stored them deletion of address by user become impossible)
    address_line TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    country TEXT NOT NULL,
    pincode VARCHAR(6) NOT NULL,
    latitude TEXT NOT NULL,
    langitude TEXT NOT NULL,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT fk_orders_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id),
    CONSTRAINT fk_orders_cart FOREIGN KEY (cart_id) REFERENCES carts(id)
);

-- ================================
-- PAYMENTS
-- ================================
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'INR',
    status VARCHAR(50) DEFAULT 'pending',
    payment_method VARCHAR(50) DEFAULT 'razorpay',
    razorpay_order_id VARCHAR(255) UNIQUE,
    razorpay_payment_id VARCHAR(255),
    razorpay_signature TEXT,
    order_ids UUID[] DEFAULT '{}',
    quotation_request_id UUID REFERENCES quotation_requests(id) ON DELETE SET NULL,
    split_number INTEGER DEFAULT 1,
    split_percentage NUMERIC(5, 2) DEFAULT 100.00,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_razorpay_order_id ON payments(razorpay_order_id);

-- ================================
-- VENDOR PAYOUTS
-- ================================
CREATE TABLE IF NOT EXISTS vendor_payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    payout_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    payout_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    delivered_at TIMESTAMPTZ,
    due_date TIMESTAMPTZ,
    last_paid_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_payouts_order_id ON vendor_payouts(order_id);
CREATE INDEX IF NOT EXISTS idx_vendor_payouts_vendor_id ON vendor_payouts(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_payouts_status ON vendor_payouts(status);

-- ================================
-- QUOTATION REQUESTS (CLIENT <-> VENDOR)
-- ================================
CREATE TABLE IF NOT EXISTS quotation_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL,
    vendor_id UUID NOT NULL,
    product_id UUID NOT NULL,
    product_variant_id UUID NOT NULL,

    requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
    requested_price NUMERIC(12,2) CHECK (requested_price >= 0),

    status quotation_status NOT NULL DEFAULT 'pending_vendor',
    request_note TEXT,

    buyer_city TEXT,
    buyer_state TEXT,
    buyer_country TEXT,
    buyer_pincode VARCHAR(6),

    current_offer_price NUMERIC(12,2) CHECK (current_offer_price >= 0),
    current_offer_quantity INTEGER CHECK (current_offer_quantity > 0),
    current_offer_by TEXT,

    accepted_price NUMERIC(12,2) CHECK (accepted_price >= 0),
    accepted_quantity INTEGER CHECK (accepted_quantity > 0),

    rejection_reason TEXT,
    order_id UUID,

    -- Admin confirmation fields
    admin_confirmation_status TEXT,
    admin_confirmation_message TEXT,
    admin_confirmed_at TIMESTAMPTZ,
    admin_user_id UUID,

    quotation_group_id UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_quotation_requests_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_quotation_requests_vendor
        FOREIGN KEY (vendor_id)
        REFERENCES vendors(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_quotation_requests_product
        FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_quotation_requests_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_quotation_requests_order
        FOREIGN KEY (order_id)
        REFERENCES orders(id)
        ON DELETE SET NULL,
    CONSTRAINT fk_quotation_requests_admin_user
        FOREIGN KEY (admin_user_id)
        REFERENCES users(id)
        ON DELETE SET NULL,
    CONSTRAINT chk_quotation_offer_by
        CHECK (current_offer_by IS NULL OR current_offer_by IN ('client', 'vendor')),
    CONSTRAINT chk_admin_confirmation_status
        CHECK (admin_confirmation_status IS NULL OR admin_confirmation_status IN ('pending', 'confirmed', 'rejected'))
);

CREATE TABLE IF NOT EXISTS quotation_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quotation_id UUID NOT NULL,
    sender_user_id UUID NOT NULL,
    sender_role TEXT NOT NULL,
    action quotation_message_action NOT NULL,
    offer_price NUMERIC(12,2) CHECK (offer_price >= 0),
    offer_quantity INTEGER CHECK (offer_quantity > 0),
    note TEXT,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_quotation_messages_quotation
        FOREIGN KEY (quotation_id)
        REFERENCES quotation_requests(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_quotation_messages_sender
        FOREIGN KEY (sender_user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT chk_quotation_sender_role
        CHECK (sender_role IN ('client', 'vendor', 'admin'))
);

-- cart_items : 
CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    order_id UUID NOT NULL,

    product_id UUID NOT NULL,  -- keep FK (since we are not deleting products)
    product_variant_id UUID NOT NULL,
    vendor_id UUID NOT NULL,

    quantity INTEGER NOT NULL CHECK (quantity > 0),

    price NUMERIC(12,2) NOT NULL, -- 🔥 final locked price at checkout
    original_price NUMERIC(12,2) DEFAULT NULL,

    created_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT fk_order_items_order 
        FOREIGN KEY (order_id) 
        REFERENCES orders(id) 
        ON DELETE CASCADE,

    CONSTRAINT fk_order_items_product 
        FOREIGN KEY (product_id) 
        REFERENCES products(id),

    CONSTRAINT fk_order_items_variant
        FOREIGN KEY (product_variant_id) 
        REFERENCES product_variants(id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_order_items_vendor 
        FOREIGN KEY (vendor_id) 
        REFERENCES vendors(id)
);

CREATE TABLE IF NOT EXISTS order_status_history(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,

    status order_status NOT NULL,
    note TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT fk_order_status_history_order 
        FOREIGN KEY (order_id) 
        REFERENCES orders(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS order_fulfillment_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    order_id UUID NOT NULL,

    fulfillment_center_id UUID,

    status order_status NOT NULL,
    -- received, processing, dispatched, arrived, handed_over

    note TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT fk_oft_order
        FOREIGN KEY (order_id)
        REFERENCES orders(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_oft_center
        FOREIGN KEY (fulfillment_center_id)
        REFERENCES fulfillment_centers(id)
        ON DELETE SET NULL
);

-- ================================
-- REVIEWS
-- ================================
CREATE TABLE IF NOT EXISTS order_item_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,
    order_item_id UUID NOT NULL UNIQUE,
    user_id UUID NOT NULL,
    product_id UUID NOT NULL,
    vendor_id UUID NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    review_title TEXT,
    review_text TEXT,
    is_verified_purchase BOOLEAN NOT NULL DEFAULT TRUE,
    images TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_order_item_reviews_order
        FOREIGN KEY (order_id)
        REFERENCES orders(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_order_item_reviews_order_item
        FOREIGN KEY (order_item_id)
        REFERENCES order_items(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_order_item_reviews_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_order_item_reviews_product
        FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_order_item_reviews_vendor
        FOREIGN KEY (vendor_id)
        REFERENCES vendors(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vendor_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,
    user_id UUID NOT NULL,
    vendor_id UUID NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    review_title TEXT,
    review_text TEXT,
    is_verified_purchase BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_vendor_review_per_order UNIQUE (order_id, vendor_id),
    CONSTRAINT fk_vendor_reviews_order
        FOREIGN KEY (order_id)
        REFERENCES orders(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_vendor_reviews_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_vendor_reviews_vendor
        FOREIGN KEY (vendor_id)
        REFERENCES vendors(id)
        ON DELETE CASCADE
);

-- ================================
-- DYNAMIC MIGRATIONS & ALTERATIONS
-- ================================

-- Safely alter users
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS OTP TEXT,
    ADD COLUMN IF NOT EXISTS OTP_Expiry TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS refresh_token TEXT,
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Safely alter products
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS material TEXT,
    ADD COLUMN IF NOT EXISTS grade TEXT,
    ADD COLUMN IF NOT EXISTS application TEXT,
    ADD COLUMN IF NOT EXISTS standard TEXT,
    ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved',
    ADD COLUMN IF NOT EXISTS approval_notes TEXT,
    ADD COLUMN IF NOT EXISTS created_by_user_id UUID,
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS quotation_limit INTEGER CHECK (quotation_limit > 0),
    ADD COLUMN IF NOT EXISTS vendor_can_set_quotation_limit BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Safely alter addresses
ALTER TABLE addresses
    ADD COLUMN IF NOT EXISTS address_line1 TEXT,
    ADD COLUMN IF NOT EXISTS address_line2 TEXT,
    ADD COLUMN IF NOT EXISTS landmark TEXT,
    ADD COLUMN IF NOT EXISTS address_phone TEXT;

-- Safely alter vendors
ALTER TABLE vendors
    ADD COLUMN IF NOT EXISTS user_id UUID,
    ADD COLUMN IF NOT EXISTS company_name TEXT,
    ADD COLUMN IF NOT EXISTS gst_number TEXT,
    ADD COLUMN IF NOT EXISTS gst_certificate_link TEXT,
    ADD COLUMN IF NOT EXISTS business_type TEXT,
    ADD COLUMN IF NOT EXISTS company_website TEXT,
    ADD COLUMN IF NOT EXISTS phone TEXT,
    ADD COLUMN IF NOT EXISTS alternative_number TEXT,
    ADD COLUMN IF NOT EXISTS designation TEXT,
    ADD COLUMN IF NOT EXISTS business_description TEXT,
    ADD COLUMN IF NOT EXISTS credit_cycle TEXT,
    ADD COLUMN IF NOT EXISTS minimum_commision_percentage INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS maximum_commision_percentage INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rating NUMERIC(2,1) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS application_number TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS approval_status vendor_approval_status NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS approval_notes TEXT,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Safely alter vendor_products
ALTER TABLE vendor_products
    ADD COLUMN IF NOT EXISTS stock_quantity INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS commision_percentage INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS quotation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS quotation_min_qty INTEGER,
    ADD COLUMN IF NOT EXISTS status vendor_product_status NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Safely alter orders
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'client',
    ADD COLUMN IF NOT EXISTS order_reference TEXT,
    ADD COLUMN IF NOT EXISTS order_notes TEXT,
    ADD COLUMN IF NOT EXISTS customer_name TEXT,
    ADD COLUMN IF NOT EXISTS customer_email TEXT,
    ADD COLUMN IF NOT EXISTS customer_phone TEXT,
    ADD COLUMN IF NOT EXISTS created_by_admin_id TEXT,
    ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'direct',
    ADD COLUMN IF NOT EXISTS cart_id UUID,
    ADD COLUMN IF NOT EXISTS address_line TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS pincode VARCHAR(6) NOT NULL DEFAULT '000000',
    ADD COLUMN IF NOT EXISTS latitude TEXT NOT NULL DEFAULT '0',
    ADD COLUMN IF NOT EXISTS langitude TEXT NOT NULL DEFAULT '0',
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Safely alter carts
ALTER TABLE carts
    ADD COLUMN IF NOT EXISTS cart_type cart_type NOT NULL DEFAULT 'direct';

-- ================================
-- INDEXES
-- ================================

-- Optimizing Foreign Keys (Postgres does not index these automatically)
CREATE INDEX IF NOT EXISTS idx_vendor_products_product_id ON vendor_products(product_id);
CREATE INDEX IF NOT EXISTS idx_products_images_product_id ON products_images(product_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_centers_user_id ON fulfillment_centers(user_id);

-- Optimizing Common Filtering Columns
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_vendors_rating ON vendors(rating DESC) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_products_product_type ON products(product_type);
CREATE INDEX IF NOT EXISTS idx_vendor_products_status ON vendor_products(status);

--cart indexes
CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id ON cart_items(cart_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_product_id ON cart_items(product_id);
CREATE INDEX IF NOT EXISTS idx_carts_user_id ON carts(user_id);
CREATE INDEX IF NOT EXISTS idx_carts_user_type ON carts(user_id, cart_type);
CREATE INDEX IF NOT EXISTS idx_wishlists_user_id ON wishlists(user_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_items_wishlist_id ON wishlist_items(wishlist_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_items_product_id ON wishlist_items(product_id);
CREATE INDEX IF NOT EXISTS idx_abandoned_reminder_logs_user_id ON abandoned_reminder_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_abandoned_reminder_logs_source ON abandoned_reminder_logs(source_type, source_item_id);

--order indexs : 
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE INDEX IF NOT EXISTS idx_vendor_categories_vendor_id ON vendor_categories(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_categories_category_id ON vendor_categories(category_id);
CREATE INDEX IF NOT EXISTS idx_order_item_reviews_order_id ON order_item_reviews(order_id);
CREATE INDEX IF NOT EXISTS idx_order_item_reviews_user_id ON order_item_reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_order_item_reviews_product_id ON order_item_reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_order_item_reviews_vendor_id ON order_item_reviews(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_order_id ON vendor_reviews(order_id);
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_user_id ON vendor_reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_vendor_id ON vendor_reviews(vendor_id);

-- quotation indexes
CREATE INDEX IF NOT EXISTS idx_quotation_requests_vendor_id ON quotation_requests(vendor_id);
CREATE INDEX IF NOT EXISTS idx_quotation_requests_user_id ON quotation_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_quotation_requests_status ON quotation_requests(status);
CREATE INDEX IF NOT EXISTS idx_quotation_requests_product_id ON quotation_requests(product_id);
CREATE INDEX IF NOT EXISTS idx_quotation_messages_quotation_id ON quotation_messages(quotation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_quotation_requests_admin_status ON quotation_requests(admin_confirmation_status) WHERE admin_confirmation_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quotation_requests_group_id ON quotation_requests(quotation_group_id) WHERE quotation_group_id IS NOT NULL;

-- ================================
-- NOTIFICATIONS
-- ================================
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    reference_type TEXT,
    reference_id UUID,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_notifications_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT chk_notification_type
        CHECK (type IN (
            'quotation_request_received',
            'quotation_offer_received',
            'quotation_counter_received',
            'quotation_accepted',
            'quotation_rejected',
            'admin_confirmation_sent',
            'admin_confirmation_accepted',
            'admin_confirmation_rejected',
            'product_approved',
            'product_rejected',
            'image_approved',
            'image_rejected',
            'vendor_product_approved',
            'vendor_product_rejected',
            'general'
        )),
    CONSTRAINT chk_notification_reference_type
        CHECK (reference_type IS NULL OR reference_type IN ('quotation', 'order', 'product'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_reference ON notifications(reference_type, reference_id);

-- ================================
-- VENDOR COMMUNICATION & QUOTATIONS
-- ================================

CREATE TABLE IF NOT EXISTS vendor_chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id UUID NOT NULL,
    sender_user_id UUID NOT NULL,
    sender_role TEXT NOT NULL,
    body TEXT NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_vendor_chat_messages_vendor
        FOREIGN KEY (vendor_id)
        REFERENCES vendors(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_vendor_chat_messages_sender
        FOREIGN KEY (sender_user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT chk_vendor_chat_sender_role
        CHECK (sender_role IN ('vendor', 'admin', 'super_admin'))
);

CREATE TABLE IF NOT EXISTS vendor_quotations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quotation_number TEXT NOT NULL UNIQUE,
    vendor_id UUID NOT NULL,
    created_by_admin_id UUID NOT NULL,
    sent_to_email CITEXT NOT NULL,
    title TEXT NOT NULL,
    quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
    unit TEXT NOT NULL,
    target_price NUMERIC(12,2) CHECK (target_price >= 0),
    requested_moq INTEGER CHECK (requested_moq > 0),
    request_notes TEXT,
    validity_date TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'sent',
    vendor_price NUMERIC(12,2) CHECK (vendor_price >= 0),
    vendor_moq INTEGER CHECK (vendor_moq > 0),
    vendor_notes TEXT,
    admin_signature_data TEXT NOT NULL,
    vendor_signature_data TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    token_expires_at TIMESTAMPTZ NOT NULL,
    vendor_opened_at TIMESTAMPTZ,
    vendor_responded_at TIMESTAMPTZ,
    vendor_response_ip TEXT,
    vendor_response_user_agent TEXT,
    admin_reviewed_at TIMESTAMPTZ,
    reviewed_by_admin_id UUID,
    admin_review_notes TEXT,
    vendor_rejection_reason TEXT,
    email_sent_at TIMESTAMPTZ,
    email_last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_vendor_quotations_vendor
        FOREIGN KEY (vendor_id)
        REFERENCES vendors(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_vendor_quotations_admin
        FOREIGN KEY (created_by_admin_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_vendor_quotations_reviewed_by_admin
        FOREIGN KEY (reviewed_by_admin_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT chk_vendor_quotation_status
        CHECK (status IN ('sent', 'vendor_opened', 'vendor_approved', 'vendor_rejected', 'admin_approved', 'admin_rejected'))
);

CREATE INDEX IF NOT EXISTS idx_vendor_chat_messages_vendor_id
    ON vendor_chat_messages(vendor_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_vendor_chat_messages_is_read
    ON vendor_chat_messages(vendor_id, is_read);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_quotations_number_unique
    ON vendor_quotations(quotation_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_quotations_token_hash_unique
    ON vendor_quotations(token_hash);
CREATE INDEX IF NOT EXISTS idx_vendor_quotations_vendor_id
    ON vendor_quotations(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_quotations_created_by_admin_id
    ON vendor_quotations(created_by_admin_id);
CREATE INDEX IF NOT EXISTS idx_vendor_quotations_reviewed_by_admin_id
    ON vendor_quotations(reviewed_by_admin_id);
CREATE INDEX IF NOT EXISTS idx_vendor_quotations_status
    ON vendor_quotations(status);

-- ================================
-- ORDER ROUTE PLAN (2026-05-23)
-- Stores pre-planned fulfillment center stops for each order
-- computed via Haversine when vendor accepts (status -> processing).
-- ================================

CREATE TABLE IF NOT EXISTS order_route_plan (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,
    fulfillment_center_id UUID NOT NULL,
    stop_sequence INTEGER NOT NULL,
    center_name TEXT NOT NULL,
    center_city TEXT NOT NULL,
    center_state TEXT NOT NULL,
    center_pincode VARCHAR(6),
    center_latitude DOUBLE PRECISION,
    center_longitude DOUBLE PRECISION,
    estimated_arrival TIMESTAMPTZ,
    actual_arrival TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'upcoming',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT fk_orp_order
        FOREIGN KEY (order_id)
        REFERENCES orders(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_orp_fc
        FOREIGN KEY (fulfillment_center_id)
        REFERENCES fulfillment_centers(id)
        ON DELETE CASCADE,

    CONSTRAINT chk_orp_status
        CHECK (status IN ('upcoming', 'in_transit', 'arrived', 'departed')),

    CONSTRAINT uq_orp_order_sequence
        UNIQUE (order_id, stop_sequence)
);

CREATE INDEX IF NOT EXISTS idx_order_route_plan_order_id ON order_route_plan(order_id);
CREATE INDEX IF NOT EXISTS idx_order_route_plan_fc_id ON order_route_plan(fulfillment_center_id);
CREATE INDEX IF NOT EXISTS idx_order_route_plan_status ON order_route_plan(status);

-- Enhance order_fulfillment_tracking with stop_sequence and location_label
ALTER TABLE order_fulfillment_tracking
    ADD COLUMN IF NOT EXISTS stop_sequence INTEGER,
    ADD COLUMN IF NOT EXISTS location_label TEXT;

CREATE INDEX IF NOT EXISTS idx_oft_order_sequence
    ON order_fulfillment_tracking(order_id, stop_sequence);

-- Cache vendor location on orders for display
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS vendor_city TEXT,
    ADD COLUMN IF NOT EXISTS vendor_state TEXT,
    ADD COLUMN IF NOT EXISTS vendor_latitude DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS vendor_longitude DOUBLE PRECISION;
