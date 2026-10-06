ALTER TABLE service_bookings 
    DROP COLUMN IF EXISTS completion_otp,
    DROP COLUMN IF EXISTS completion_otp_expires_at;

ALTER TABLE service_bookings 
    ADD COLUMN IF NOT EXISTS completion_otp_hash VARCHAR(64) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS completion_otp_expires_at TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS completion_otp_failed_attempts INTEGER NOT NULL DEFAULT 0;
