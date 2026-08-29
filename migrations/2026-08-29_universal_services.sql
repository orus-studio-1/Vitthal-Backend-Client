-- ==============================================================================
-- Universal B2B Service Hub & Asset Registry Migration
-- Date: 2026-08-29
-- ==============================================================================

-- 1. Extend subcategories table with dynamic form schema
ALTER TABLE subcategories 
    ADD COLUMN IF NOT EXISTS form_schema JSONB DEFAULT '[]';

-- 2. Universal Client Asset Registry (Machines, Equipment, Tools, Vehicles)
CREATE TABLE IF NOT EXISTS client_assets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id         UUID REFERENCES product_category(id) ON DELETE SET NULL,
    subcategory_id      UUID REFERENCES subcategories(id) ON DELETE SET NULL,
    
    asset_name          TEXT NOT NULL,
    asset_code          VARCHAR(100),
    brand               TEXT,
    model_number        TEXT,
    serial_number       TEXT,
    installation_year   INTEGER,
    
    specs               JSONB NOT NULL DEFAULT '{}',
    location_details    JSONB NOT NULL DEFAULT '{}',
    documents           JSONB NOT NULL DEFAULT '[]',
    
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_assets_user ON client_assets(user_id);
CREATE INDEX IF NOT EXISTS idx_client_assets_category ON client_assets(category_id);
CREATE INDEX IF NOT EXISTS idx_client_assets_specs ON client_assets USING GIN (specs);

-- 3. Universal Service Tickets
CREATE TABLE IF NOT EXISTS service_tickets (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_number           VARCHAR(50) NOT NULL UNIQUE,
    
    category_id             UUID NOT NULL REFERENCES product_category(id) ON DELETE RESTRICT,
    subcategory_id          UUID REFERENCES subcategories(id) ON DELETE SET NULL,
    
    client_user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vendor_id               UUID REFERENCES vendors(id) ON DELETE SET NULL,
    assigned_agent_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    asset_id                UUID REFERENCES client_assets(id) ON DELETE SET NULL,
    
    status                  VARCHAR(30) NOT NULL DEFAULT 'draft',
    priority                VARCHAR(20) NOT NULL DEFAULT 'medium',
    
    ticket_payload          JSONB NOT NULL DEFAULT '{}',
    quotation_breakdown     JSONB NOT NULL DEFAULT '{}',
    
    total_amount            NUMERIC(12,2) DEFAULT 0.00,
    advance_paid            NUMERIC(12,2) DEFAULT 0.00,
    
    completion_otp          VARCHAR(6),
    otp_verified_at         TIMESTAMPTZ,
    
    timeline_logs           JSONB NOT NULL DEFAULT '[]',
    
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_srv_tickets_client ON service_tickets(client_user_id);
CREATE INDEX IF NOT EXISTS idx_srv_tickets_vendor ON service_tickets(vendor_id);
CREATE INDEX IF NOT EXISTS idx_srv_tickets_status ON service_tickets(status);
CREATE INDEX IF NOT EXISTS idx_srv_tickets_cat ON service_tickets(category_id);
CREATE INDEX IF NOT EXISTS idx_srv_tickets_payload ON service_tickets USING GIN (ticket_payload);

-- 4. Vendor Quotation Bids for Service Tickets
CREATE TABLE IF NOT EXISTS service_ticket_quotations (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id        UUID NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
    vendor_id        UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    status           VARCHAR(20) NOT NULL DEFAULT 'submitted',
    quote_breakdown  JSONB NOT NULL DEFAULT '{}',
    total_price      NUMERIC(12,2) NOT NULL,
    token_percentage NUMERIC(5,2) DEFAULT 0.00,
    token_amount     NUMERIC(12,2) DEFAULT 0.00,
    valid_until      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_srv_ticket_quotes_ticket ON service_ticket_quotations(ticket_id);
CREATE INDEX IF NOT EXISTS idx_srv_ticket_quotes_vendor ON service_ticket_quotations(vendor_id);

-- 5. Service Ticket Documents (CAD files, photos, diagnostic reports, POD)
CREATE TABLE IF NOT EXISTS service_ticket_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
    doc_type            VARCHAR(50) NOT NULL,
    doc_name            TEXT,
    doc_url             TEXT NOT NULL,
    uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    metadata            JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_srv_ticket_docs_ticket ON service_ticket_documents(ticket_id);
