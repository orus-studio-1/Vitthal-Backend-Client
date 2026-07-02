ALTER TABLE vendors ADD COLUMN IF NOT EXISTS vendor_type TEXT NOT NULL DEFAULT 'product' CHECK (vendor_type IN ('product', 'service', 'both'));
