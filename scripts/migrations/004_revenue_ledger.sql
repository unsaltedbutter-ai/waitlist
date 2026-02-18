BEGIN;

CREATE TABLE IF NOT EXISTS revenue_ledger (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id       TEXT NOT NULL,
    action           TEXT NOT NULL,
    amount_sats      INT NOT NULL,
    payment_status   TEXT NOT NULL CHECK (payment_status IN ('paid', 'eventual')),
    job_completed_at TIMESTAMPTZ NOT NULL,
    recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revenue_ledger_date ON revenue_ledger(recorded_at);
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_service ON revenue_ledger(service_id, action);

COMMIT;
