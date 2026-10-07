ALTER TABLE addresses
    DROP CONSTRAINT IF EXISTS addresses_user_id_key;

ALTER TABLE addresses
    ADD COLUMN IF NOT EXISTS address_line1 TEXT,
    ADD COLUMN IF NOT EXISTS address_line2 TEXT,
    ADD COLUMN IF NOT EXISTS landmark TEXT,
    ADD COLUMN IF NOT EXISTS address_phone TEXT;

CREATE INDEX IF NOT EXISTS idx_addresses_user_id ON addresses(user_id);

UPDATE addresses
SET
    address_line1 = COALESCE(NULLIF(address_line1, ''), address),
    address_line2 = NULLIF(address_line2, ''),
    landmark = NULLIF(landmark, '')
WHERE address_line1 IS NULL OR address_line1 = '';