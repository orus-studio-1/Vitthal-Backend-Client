ALTER TABLE rider_earnings

ADD COLUMN IF NOT EXISTS earning_type VARCHAR(30) NOT NULL DEFAULT 'base';

CREATE INDEX IF NOT EXISTS "rider_earnings_delivery_agent_id_created_at_idx"
ON "rider_earnings" ("delivery_agent_id", "created_at");

CREATE INDEX IF NOT EXISTS "rider_earnings_delivery_agent_id_status_idx"
ON "rider_earnings" ("delivery_agent_id", "status");

CREATE TABLE IF NOT EXISTS rider_incentives (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_orders INTEGER NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT rider_incentives_target_orders_key
        UNIQUE (target_orders)
);

INSERT INTO rider_incentives
    (target_orders, amount)
VALUES
    (10, 100.00),
    (20, 250.00),
    (30, 500.00)
ON CONFLICT (target_orders)
DO UPDATE SET
    amount = EXCLUDED.amount,
    active = true,
    updated_at = NOW();