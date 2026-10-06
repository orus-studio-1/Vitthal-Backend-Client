-- Quotation flow migration (2026-05-20)

-- Enums
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
            'expired'
        );
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quotation_message_action') THEN
        CREATE TYPE quotation_message_action AS ENUM ('request', 'offer', 'counter', 'accept', 'reject', 'note');
    END IF;
END$$;

-- carts: allow multiple carts per user (direct + quotation)
ALTER TABLE carts
    ADD COLUMN IF NOT EXISTS cart_type cart_type NOT NULL DEFAULT 'direct';

UPDATE carts SET cart_type = 'direct' WHERE cart_type IS NULL;

ALTER TABLE carts
    DROP CONSTRAINT IF EXISTS carts_user_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_carts_user_type_status
    ON carts(user_id, cart_type, status);

-- vendor_products: quotation settings
ALTER TABLE vendor_products
    ADD COLUMN IF NOT EXISTS quotation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS quotation_min_qty INTEGER;

-- orders: mark quotation orders
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'direct';

-- quotation tables
CREATE TABLE IF NOT EXISTS quotation_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    vendor_id UUID NOT NULL,
    product_id UUID NOT NULL,
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
    CONSTRAINT fk_quotation_requests_order
        FOREIGN KEY (order_id)
        REFERENCES orders(id)
        ON DELETE SET NULL,
    CONSTRAINT chk_quotation_offer_by
        CHECK (current_offer_by IS NULL OR current_offer_by IN ('client', 'vendor'))
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
        CHECK (sender_role IN ('client', 'vendor'))
);

-- indexes
CREATE INDEX IF NOT EXISTS idx_quotation_requests_vendor_id ON quotation_requests(vendor_id);
CREATE INDEX IF NOT EXISTS idx_quotation_requests_user_id ON quotation_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_quotation_requests_status ON quotation_requests(status);
CREATE INDEX IF NOT EXISTS idx_quotation_requests_product_id ON quotation_requests(product_id);
CREATE INDEX IF NOT EXISTS idx_quotation_messages_quotation_id ON quotation_messages(quotation_id, created_at ASC);
