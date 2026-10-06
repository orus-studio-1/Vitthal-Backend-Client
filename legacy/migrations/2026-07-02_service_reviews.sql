CREATE TABLE IF NOT EXISTS service_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL UNIQUE,
    user_id UUID NOT NULL,
    service_id UUID NOT NULL,
    vendor_id UUID NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    review_title TEXT,
    review_text TEXT,
    images TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_service_reviews_booking
        FOREIGN KEY (booking_id)
        REFERENCES service_bookings(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_service_reviews_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_service_reviews_service
        FOREIGN KEY (service_id)
        REFERENCES services(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_service_reviews_vendor
        FOREIGN KEY (vendor_id)
        REFERENCES vendors(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_service_reviews_service_id ON service_reviews(service_id);
CREATE INDEX IF NOT EXISTS idx_service_reviews_vendor_id ON service_reviews(vendor_id);
CREATE INDEX IF NOT EXISTS idx_service_reviews_user_id ON service_reviews(user_id);
