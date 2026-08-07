-- Add kyc_status to delivery_agents table if not present
ALTER TABLE delivery_agents 
    ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(50) NOT NULL DEFAULT 'pending';

-- Create delivery_agent_kyc table for flexible Indian KYC documents + Bank payout info
CREATE TABLE IF NOT EXISTS delivery_agent_kyc (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_agent_id UUID NOT NULL UNIQUE REFERENCES delivery_agents(id) ON DELETE CASCADE,
    kyc_status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'pending' | 'submitted' | 'approved' | 'rejected'
    id_doc_type VARCHAR(50) NOT NULL, -- 'aadhaar' | 'pan' | 'driving_license'
    id_doc_number VARCHAR(100) NOT NULL,
    bank_name VARCHAR(100) NOT NULL,
    account_number VARCHAR(50) NOT NULL,
    ifsc_code VARCHAR(20) NOT NULL,
    account_holder_name VARCHAR(100) NOT NULL,
    rejection_reason TEXT,
    submitted_at TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookup of KYC per rider
CREATE INDEX IF NOT EXISTS idx_delivery_agent_kyc_rider ON delivery_agent_kyc(delivery_agent_id);

-- Create rider_earnings table for recording per-leg earnings (₹40 vendor pickup, ₹50 client dropoff)
CREATE TABLE IF NOT EXISTS rider_earnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_agent_id UUID NOT NULL REFERENCES delivery_agents(id) ON DELETE CASCADE,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    order_reference VARCHAR(100),
    leg_type VARCHAR(50) NOT NULL, -- 'vendor_pickup' | 'client_dropoff'
    amount NUMERIC(10, 2) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'credited', -- 'credited' | 'paid_out'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast earnings queries per rider
CREATE INDEX IF NOT EXISTS idx_rider_earnings_rider ON rider_earnings(delivery_agent_id);
