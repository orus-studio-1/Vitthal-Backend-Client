CREATE TABLE IF NOT EXISTS service_quotation_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quotation_id UUID NOT NULL,
    sender_user_id UUID NOT NULL,
    sender_role TEXT NOT NULL,
    action quotation_message_action NOT NULL,
    offer_price NUMERIC(12,2) CHECK (offer_price >= 0),
    note TEXT,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_service_quotation_messages_quotation
        FOREIGN KEY (quotation_id)
        REFERENCES service_quotations(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_service_quotation_messages_sender
        FOREIGN KEY (sender_user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT chk_service_quotation_sender_role
        CHECK (sender_role IN ('client', 'vendor', 'admin'))
);

CREATE INDEX IF NOT EXISTS idx_service_quotation_messages_quotation_id ON service_quotation_messages(quotation_id);
