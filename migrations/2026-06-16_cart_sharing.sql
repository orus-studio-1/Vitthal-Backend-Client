-- Migration Name: 2026-06-16_cart_sharing
-- Description: Drop the unique index idx_carts_user_type_status and recreate it as a partial index active only when status = 'active' to support shared carts snapshots.

DROP INDEX IF EXISTS idx_carts_user_type_status;

CREATE UNIQUE INDEX IF NOT EXISTS idx_carts_user_type_status
    ON carts(user_id, cart_type) WHERE status = 'active';
