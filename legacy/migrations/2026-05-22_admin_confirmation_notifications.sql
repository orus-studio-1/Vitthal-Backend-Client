-- Admin confirmation & notifications migration (2026-05-22)
-- Adds notifications table, admin confirmation fields on quotation_requests,
-- and expands quotation_messages to support admin sender_role.

-- ================================
-- 1. Extend quotation_status enum with admin confirmation states
-- ================================
DO $$
BEGIN
    -- Add new enum values if they don't exist
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'admin_confirmation_pending' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'quotation_status')) THEN
        ALTER TYPE quotation_status ADD VALUE 'admin_confirmation_pending';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'admin_confirmed' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'quotation_status')) THEN
        ALTER TYPE quotation_status ADD VALUE 'admin_confirmed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'admin_confirmation_rejected' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'quotation_status')) THEN
        ALTER TYPE quotation_status ADD VALUE 'admin_confirmation_rejected';
    END IF;
END$$;

-- ================================
-- 2. Extend quotation_message_action enum
-- ================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'admin_confirm_request' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'quotation_message_action')) THEN
        ALTER TYPE quotation_message_action ADD VALUE 'admin_confirm_request';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'admin_confirmed' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'quotation_message_action')) THEN
        ALTER TYPE quotation_message_action ADD VALUE 'admin_confirmed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'admin_rejected' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'quotation_message_action')) THEN
        ALTER TYPE quotation_message_action ADD VALUE 'admin_rejected';
    END IF;
END$$;

-- ================================
-- 3. Add admin confirmation columns to quotation_requests
-- ================================
ALTER TABLE quotation_requests
    ADD COLUMN IF NOT EXISTS admin_confirmation_status TEXT,
    ADD COLUMN IF NOT EXISTS admin_confirmation_message TEXT,
    ADD COLUMN IF NOT EXISTS admin_confirmed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS admin_user_id UUID;

-- Add constraint for admin_confirmation_status values
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'chk_admin_confirmation_status'
          AND table_name = 'quotation_requests'
    ) THEN
        ALTER TABLE quotation_requests
            ADD CONSTRAINT chk_admin_confirmation_status
            CHECK (admin_confirmation_status IS NULL OR admin_confirmation_status IN ('pending', 'confirmed', 'rejected'));
    END IF;
END$$;

-- FK for admin_user_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_quotation_requests_admin_user'
          AND table_name = 'quotation_requests'
    ) THEN
        ALTER TABLE quotation_requests
            ADD CONSTRAINT fk_quotation_requests_admin_user
            FOREIGN KEY (admin_user_id)
            REFERENCES users(id)
            ON DELETE SET NULL;
    END IF;
END$$;

-- ================================
-- 4. Expand sender_role CHECK on quotation_messages to allow 'admin'
-- ================================
ALTER TABLE quotation_messages
    DROP CONSTRAINT IF EXISTS chk_quotation_sender_role;

ALTER TABLE quotation_messages
    ADD CONSTRAINT chk_quotation_sender_role
    CHECK (sender_role IN ('client', 'vendor', 'admin'));

-- ================================
-- 5. Create notifications table
-- ================================
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    reference_type TEXT,
    reference_id UUID,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_notifications_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT chk_notification_type
        CHECK (type IN (
            'quotation_request_received',
            'quotation_offer_received',
            'quotation_counter_received',
            'quotation_accepted',
            'quotation_rejected',
            'admin_confirmation_sent',
            'admin_confirmation_accepted',
            'admin_confirmation_rejected',
            'general'
        )),
    CONSTRAINT chk_notification_reference_type
        CHECK (reference_type IS NULL OR reference_type IN ('quotation', 'order'))
);

-- Indexes for notifications
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_reference ON notifications(reference_type, reference_id);

-- Index for admin confirmation lookups
CREATE INDEX IF NOT EXISTS idx_quotation_requests_admin_status ON quotation_requests(admin_confirmation_status) WHERE admin_confirmation_status IS NOT NULL;
