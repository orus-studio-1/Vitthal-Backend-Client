-- 1. Add fulfillment_center role to user_role enum safely
-- Note: ALTER TYPE ADD VALUE cannot run inside DO $$ BEGIN ... END $$ or transaction blocks easily on old PG versions,
-- so we do it directly. If it fails due to existing value, pg will ignore/error, but we use IF NOT EXISTS if PG supports it.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'fulfillment_center';

-- 2. Drop the old basic fulfillment_centers table if it exists
-- We do CASCADE to ensure dependent objects (if any) are updated, though we'll recreate the foreign keys.
DROP TABLE IF EXISTS fulfillment_centers CASCADE;

-- 3. Create the new detailed industry-grade fulfillment_centers table
CREATE TABLE fulfillment_centers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    contact_phone TEXT,
    contact_email CITEXT,
    manager_name TEXT,
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    country TEXT NOT NULL,
    pincode VARCHAR(6) NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
    latitude DOUBLE PRECISION CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180),
    total_area_sqft NUMERIC(10,2),
    capacity_packages INTEGER,
    storage_type TEXT,
    operating_hours TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Re-create foreign keys for tables referencing fulfillment_centers
ALTER TABLE order_fulfillment_tracking
    DROP CONSTRAINT IF EXISTS fk_oft_center;

ALTER TABLE order_fulfillment_tracking
    ADD CONSTRAINT fk_oft_center
    FOREIGN KEY (fulfillment_center_id)
    REFERENCES fulfillment_centers(id)
    ON DELETE SET NULL;

ALTER TABLE order_route_plan
    DROP CONSTRAINT IF EXISTS fk_orp_fc;

ALTER TABLE order_route_plan
    ADD CONSTRAINT fk_orp_fc
    FOREIGN KEY (fulfillment_center_id)
    REFERENCES fulfillment_centers(id)
    ON DELETE CASCADE;

-- 5. Add index on user_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_fulfillment_centers_user_id ON fulfillment_centers(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fulfillment_centers_code ON fulfillment_centers(code);
