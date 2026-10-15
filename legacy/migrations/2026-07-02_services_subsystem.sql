-- 1. Extend product_category to support different types
ALTER TABLE product_category ADD COLUMN IF NOT EXISTS category_type TEXT DEFAULT 'product';

-- Drop constraint if exists and re-add to check category_type
ALTER TABLE product_category DROP CONSTRAINT IF EXISTS chk_category_type;
ALTER TABLE product_category ADD CONSTRAINT chk_category_type CHECK (category_type IN ('product', 'service', 'both'));

-- 2. Create the Services Catalog Table
CREATE TABLE IF NOT EXISTS services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    category_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
    created_by_user_id UUID,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    rating NUMERIC(2,1) NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
    review_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_services_category FOREIGN KEY (category_id) REFERENCES product_category(id) ON DELETE RESTRICT,
    CONSTRAINT fk_services_created_by FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_services_status CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_services_category_id ON services(category_id);
CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);

-- 3. Create the Vendor Services Mapping Table (similar to vendor_products)
CREATE TABLE IF NOT EXISTS vendor_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id UUID NOT NULL,
    vendor_id UUID NOT NULL,
    pricing_type TEXT NOT NULL DEFAULT 'flat', -- hourly, project, milestone, flat
    price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    moq INTEGER NOT NULL DEFAULT 1 CHECK (moq > 0), -- e.g. minimum hours or projects
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_vendor_service UNIQUE (vendor_id, service_id),
    CONSTRAINT fk_vendor_services_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
    CONSTRAINT fk_vendor_services_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
    CONSTRAINT chk_vendor_services_pricing CHECK (pricing_type IN ('hourly', 'project', 'milestone', 'flat'))
);

CREATE INDEX IF NOT EXISTS idx_vendor_services_service_id ON vendor_services(service_id);
CREATE INDEX IF NOT EXISTS idx_vendor_services_vendor_id ON vendor_services(vendor_id);

-- 4. Create Service Bookings Table (equivalent to orders)
CREATE TABLE IF NOT EXISTS service_bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL, -- client
    vendor_id UUID NOT NULL,
    vendor_service_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, confirmed, in_progress, completed, cancelled
    payment_status TEXT NOT NULL DEFAULT 'pending', -- pending, paid, refunded
    total_amount NUMERIC(12,2) NOT NULL,
    scheduled_start TIMESTAMPTZ,
    scheduled_end TIMESTAMPTZ,
    booking_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_bookings_user FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT fk_bookings_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id),
    CONSTRAINT fk_bookings_vendor_service FOREIGN KEY (vendor_service_id) REFERENCES vendor_services(id),
    CONSTRAINT chk_bookings_status CHECK (status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled')),
    CONSTRAINT chk_bookings_payment CHECK (payment_status IN ('pending', 'paid', 'refunded'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_user_id ON service_bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_vendor_id ON service_bookings(vendor_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON service_bookings(status);

-- 5. Create Service Quotations Table (B2B service negotiations)
CREATE TABLE IF NOT EXISTS service_quotations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    vendor_id UUID NOT NULL,
    service_id UUID NOT NULL,
    scope_of_work TEXT NOT NULL,
    requested_price NUMERIC(12,2) CHECK (requested_price >= 0),
    status TEXT NOT NULL DEFAULT 'pending_vendor', -- pending_vendor, vendor_offered, client_accepted, client_rejected, cancelled
    agreed_price NUMERIC(12,2) CHECK (agreed_price >= 0),
    booking_id UUID REFERENCES service_bookings(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_service_quotes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_service_quotes_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
    CONSTRAINT fk_service_quotes_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_service_quotes_user_id ON service_quotations(user_id);
CREATE INDEX IF NOT EXISTS idx_service_quotes_vendor_id ON service_quotations(vendor_id);
