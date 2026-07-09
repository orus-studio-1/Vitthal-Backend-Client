-- Migration: Add pickup flow support to order_route_plan
-- Date: 2026-07-04
-- Description: Adds pickup_pending and pickup_assigned statuses for the vendor pickup flow,
--              and a pickup_rider_id column to track which rider is assigned for vendor pickup.

-- 1. Drop existing status constraint and add new statuses
ALTER TABLE order_route_plan 
    DROP CONSTRAINT IF EXISTS chk_orp_status;

ALTER TABLE order_route_plan 
    ADD CONSTRAINT chk_orp_status
    CHECK (status IN ('upcoming', 'pickup_pending', 'pickup_assigned', 'in_transit', 'arrived', 'departed'));

-- 2. Add pickup_rider_id column (rider assigned to pick up from vendor)
ALTER TABLE order_route_plan 
    ADD COLUMN IF NOT EXISTS pickup_rider_id UUID REFERENCES delivery_agents(id) ON DELETE SET NULL;

-- 3. Index for fast lookup of pending pickups by FC
CREATE INDEX IF NOT EXISTS idx_orp_pickup_status 
    ON order_route_plan(fulfillment_center_id, status) 
    WHERE status IN ('pickup_pending', 'pickup_assigned');
