CREATE TABLE IF NOT EXISTS worker_payout_bank_details (
    worker_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bank_name VARCHAR(100) NOT NULL,
    account_holder_name VARCHAR(100) NOT NULL,
    account_number TEXT NOT NULL,
    account_number_last4 CHAR(4) NOT NULL,
    ifsc_code VARCHAR(20) NOT NULL,
    cancelled_cheque_link TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS worker_payout_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hire_request_id UUID NOT NULL REFERENCES hire_requests(id) ON DELETE CASCADE,
    gross_amount NUMERIC(12, 2) NOT NULL CHECK (gross_amount > 0),
    commission_percentage NUMERIC(5, 2) NOT NULL CHECK (commission_percentage >= 0 AND commission_percentage <= 100),
    eligible_amount NUMERIC(12, 2) NOT NULL CHECK (eligible_amount > 0),
    paid_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0 AND paid_amount <= eligible_amount),
    status VARCHAR(20) NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'partially_paid', 'rejected', 'paid')),
    transfer_reference TEXT,
    rejection_reason TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    processed_by UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_payout_requests_active_hire
    ON worker_payout_requests(hire_request_id)
    WHERE status IN ('requested', 'partially_paid', 'paid');
CREATE INDEX IF NOT EXISTS idx_worker_payout_requests_worker_status
    ON worker_payout_requests(worker_user_id, status, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_payout_requests_transfer_reference
    ON worker_payout_requests(transfer_reference)
    WHERE transfer_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS worker_payout_bank_access_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_payout_request_id UUID NOT NULL REFERENCES worker_payout_requests(id) ON DELETE CASCADE,
    admin_user_id UUID NOT NULL,
    accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_worker_payout_bank_audit_admin
    ON worker_payout_bank_access_audit(admin_user_id, accessed_at);

CREATE TABLE IF NOT EXISTS worker_payout_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES worker_payout_requests(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    transfer_reference TEXT NOT NULL UNIQUE,
    transferred_by UUID NOT NULL,
    transferred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_worker_payout_transfers_request
    ON worker_payout_transfers(request_id, transferred_at);
