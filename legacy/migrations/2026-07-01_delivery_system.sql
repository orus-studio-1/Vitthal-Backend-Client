-- Add delivery_agent to user_role enum safely
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'delivery_agent';

-- Create delivery_agents table to store Rider profiles
CREATE TABLE IF NOT EXISTS delivery_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    fulfillment_center_id UUID NOT NULL REFERENCES fulfillment_centers(id) ON DELETE CASCADE,
    special_rider_id TEXT NOT NULL UNIQUE,
    contact_phone TEXT,
    vehicle_type TEXT,
    vehicle_number TEXT,
    status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'blocked' | 'deleted'
    is_online BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on fulfillment_center_id for fast loading of active riders per hub
CREATE INDEX IF NOT EXISTS idx_delivery_agents_fc ON delivery_agents(fulfillment_center_id);

-- Add delivery_agent_id to order_fulfillment_tracking to track custodian changes during deliveries
ALTER TABLE order_fulfillment_tracking 
    ADD COLUMN IF NOT EXISTS delivery_agent_id UUID REFERENCES delivery_agents(id) ON DELETE SET NULL;
