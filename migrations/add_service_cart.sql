-- Service Cart Items
-- Each row represents one vendor-service offering placed in a user's cart.
-- Reuses the existing `carts` table (cart_type = 'direct' or 'quotation').

CREATE TABLE IF NOT EXISTS service_cart_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id           UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  service_id        UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  vendor_service_id UUID NOT NULL REFERENCES vendor_services(id) ON DELETE CASCADE,
  vendor_id         UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  quantity          INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  price_at_added    NUMERIC(12, 2) NOT NULL,
  pricing_type      TEXT NOT NULL DEFAULT 'flat',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cart_id, vendor_service_id)
);
