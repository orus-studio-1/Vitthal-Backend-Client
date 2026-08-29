-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: Local Employee Hiring & Staffing Module
-- Created: 2026-08-29
-- Tables: employee_candidates, employee_documents, hire_requests
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════
-- Table 1: employee_candidates (Main Details)
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS employee_candidates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name           TEXT NOT NULL,
    email               TEXT,
    phone               VARCHAR(20) NOT NULL,

    -- Location
    city                TEXT,
    state               TEXT,
    pincode             VARCHAR(10),
    address_line        TEXT,

    -- Professional Details
    designation         TEXT,                       -- "CNC Operator", "Welder", etc.
    experience_years    NUMERIC(4,1) DEFAULT 0,     -- e.g. 2.5 years

    -- JSONB for loosely-coupled extensibility
    skills              JSONB NOT NULL DEFAULT '[]',        -- ["welding", "CNC", "lathe"]
    metadata            JSONB NOT NULL DEFAULT '{}',        -- {hiring_type, salary_expectation, languages, ...}

    -- Profile
    photo_url           TEXT,                       -- S3 key for profile photo

    -- Verification (Admin-controlled)
    verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
                        -- 'pending' | 'verified' | 'rejected'
    rejection_reason    TEXT,
    verified_at         TIMESTAMPTZ,
    verified_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Hiring state
    is_available        BOOLEAN NOT NULL DEFAULT true,

    -- Commission (default 0%, admin can update later)
    commission_percentage NUMERIC(5,2) NOT NULL DEFAULT 0.00,

    -- Who registered this candidate (NULL = self-registered via client portal)
    registered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Audit
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_emp_cand_status ON employee_candidates(verification_status);
CREATE INDEX IF NOT EXISTS idx_emp_cand_city ON employee_candidates(city);
CREATE INDEX IF NOT EXISTS idx_emp_cand_skills ON employee_candidates USING GIN (skills);
CREATE INDEX IF NOT EXISTS idx_emp_cand_available ON employee_candidates(is_available)
    WHERE is_available = true;
CREATE INDEX IF NOT EXISTS idx_emp_cand_phone ON employee_candidates(phone);

-- ═══════════════════════════════════════════════════════
-- Table 2: employee_documents (Flexible Document Store)
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS employee_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id        UUID NOT NULL REFERENCES employee_candidates(id) ON DELETE CASCADE,

    doc_type            VARCHAR(50) NOT NULL,       -- 'aadhaar' | 'pan' | 'resume' | 'certificate' | 'other'
    doc_number          VARCHAR(100),               -- Document number (Aadhaar, PAN, etc.)
    doc_url             TEXT NOT NULL,               -- S3 key
    doc_name            TEXT,                        -- Original filename for display

    -- JSONB for any extra doc-specific metadata
    metadata            JSONB NOT NULL DEFAULT '{}', -- {issuing_authority, expiry_date, ...}

    -- Audit
    uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_emp_doc_candidate ON employee_documents(candidate_id);
CREATE INDEX IF NOT EXISTS idx_emp_doc_type ON employee_documents(doc_type);

-- ═══════════════════════════════════════════════════════
-- Table 3: hire_requests (Who wants to hire whom)
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS hire_requests (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id            UUID NOT NULL REFERENCES employee_candidates(id) ON DELETE CASCADE,
    requested_by_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Admin-controlled status
    status                  VARCHAR(20) NOT NULL DEFAULT 'pending',
                            -- 'pending' | 'approved' | 'rejected' | 'completed'

    -- JSONB for flexible request details
    request_details         JSONB NOT NULL DEFAULT '{}',
                            -- {hiring_type, duration, salary_offered, notes, ...}

    -- Admin review fields
    admin_notes             TEXT,
    reviewed_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at             TIMESTAMPTZ,

    -- Audit
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hire_req_candidate ON hire_requests(candidate_id);
CREATE INDEX IF NOT EXISTS idx_hire_req_user ON hire_requests(requested_by_user_id);
CREATE INDEX IF NOT EXISTS idx_hire_req_status ON hire_requests(status);
