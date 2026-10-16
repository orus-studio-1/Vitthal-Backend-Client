CREATE TABLE IF NOT EXISTS payout_commission_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    vendor_commission_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (vendor_commission_percentage BETWEEN 0 AND 100),
    worker_commission_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (worker_commission_percentage BETWEEN 0 AND 100),
    updated_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO payout_commission_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE vendor_payout_requests
    ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS commission_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0;

UPDATE vendor_payout_requests
SET gross_amount = eligible_amount
WHERE gross_amount = 0 AND eligible_amount > 0;
