CREATE TABLE IF NOT EXISTS services_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id UUID NOT NULL,
    media_url TEXT NOT NULL,
    media_type TEXT NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_approved BOOLEAN NOT NULL DEFAULT FALSE,
    approval_status TEXT NOT NULL DEFAULT 'pending',
    created_by_user_id UUID,
    reviewed_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_services_media_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
    CONSTRAINT fk_services_media_created_by FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_services_media_reviewed_by FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_services_media_type CHECK (media_type IN ('image', 'video')),
    CONSTRAINT chk_services_media_status CHECK (approval_status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_services_media_service_id ON services_media(service_id);

-- Enforce at most one video per service
CREATE UNIQUE INDEX IF NOT EXISTS unique_video_per_service ON services_media(service_id) WHERE (media_type = 'video');
