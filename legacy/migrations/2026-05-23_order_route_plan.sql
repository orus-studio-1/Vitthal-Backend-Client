-- Order Route Plan Migration (2026-05-23)
-- Adds the order_route_plan table for pre-planned fulfillment center routing,
-- and enhances order_fulfillment_tracking with stop_sequence & location_label
-- for full Amazon/Flipkart style transparent order journey tracking.

-- ================================
-- 1. Create order_route_plan table
-- ================================
-- Stores the planned list of fulfillment center stops for each order,
-- computed at the time the vendor accepts (status -> processing).
-- The route is calculated via Haversine distance: seller -> nearest FC on path -> customer.
CREATE TABLE IF NOT EXISTS order_route_plan (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,
    fulfillment_center_id UUID NOT NULL,
    stop_sequence INTEGER NOT NULL,   -- 1 = first hub after seller, ascending toward customer
    center_name TEXT NOT NULL,        -- denormalised snapshot for resilience
    center_city TEXT NOT NULL,
    center_state TEXT NOT NULL,
    center_pincode VARCHAR(6),
    center_latitude DOUBLE PRECISION,
    center_longitude DOUBLE PRECISION,
    estimated_arrival TIMESTAMPTZ,    -- simple: 1-2 days per hop based on distance
    actual_arrival TIMESTAMPTZ,       -- set when FC receives the order
    status TEXT NOT NULL DEFAULT 'upcoming',
    -- upcoming | in_transit | arrived | departed
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

-- ================================
-- 2. Enhance order_fulfillment_tracking
-- ================================
-- Add stop_sequence to link a tracking event to its planned route stop.
-- Add location_label for a human-readable "at Pune FC" style label.
ALTER TABLE order_fulfillment_tracking
    ADD COLUMN IF NOT EXISTS stop_sequence INTEGER,
    ADD COLUMN IF NOT EXISTS location_label TEXT;

-- Index for fast lookup by order + sequence
CREATE INDEX IF NOT EXISTS idx_oft_order_sequence
    ON order_fulfillment_tracking(order_id, stop_sequence);

-- ================================
-- 3. Add vendor location columns to vendors (for route origin)
-- ================================
-- The route origin comes from the vendor's registered address (addresses table),
-- but we cache the city/state on the order for display without extra joins.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS vendor_city TEXT,
    ADD COLUMN IF NOT EXISTS vendor_state TEXT,
    ADD COLUMN IF NOT EXISTS vendor_latitude DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS vendor_longitude DOUBLE PRECISION;
